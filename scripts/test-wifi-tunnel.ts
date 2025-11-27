#!/usr/bin/env tsx
/**
 * Test script for WiFi tunnel connection
 *
 * This script demonstrates the WiFi tunnel workflow:
 * 1. Discover iOS devices on the network via Bonjour
 * 2. Check for stored pairing records
 * 3. Connect to a device over WiFi using stored credentials
 *
 * Prerequisites:
 * - Device must be on the same WiFi network
 * - Device must have been paired over USB first (pairing record must exist)
 *
 * Usage:
 *   sudo tsx scripts/test-wifi-tunnel.ts [--import-keys <udid>] [--discover-only]
 *
 * Options:
 *   --import-keys <udid>  Import pairing keys from pymobiledevice3 format
 *   --discover-only       Only discover devices, don't attempt connection
 */
import { execSync, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { logger } from '@appium/support';

import {
  WiFiDeviceDiscovery,
  RemotePairingTunnelService,
  getRemotePairingStorage,
} from '../src/lib/remote-pairing/index.js';
import { parsePlist } from '../src/lib/plist/index.js';
import { TunTap } from 'appium-ios-tuntap';

const log = logger.getLogger('WiFiTunnelTest');

/**
 * Connect using TLS-PSK via OpenSSL subprocess
 * Returns a duplex stream that wraps the OpenSSL process
 */
async function connectWithTlsPsk(
  host: string,
  port: number,
  pskHex: string,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // Use OpenSSL s_client for TLS-PSK
    const openssl = spawn('openssl', [
      's_client',
      '-connect',
      `${host}:${port}`,
      '-psk',
      pskHex,
      '-psk_identity',
      '',
      '-tls1_2',
      '-quiet',
    ]);

    const timeout = setTimeout(() => {
      openssl.kill();
      reject(new Error('TLS-PSK connection timeout'));
    }, 10000);

    let connected = false;

    openssl.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      log.debug(`OpenSSL stderr: ${text}`);
      if (text.includes('errno=')) {
        clearTimeout(timeout);
        reject(new Error(`OpenSSL connection failed: ${text}`));
      }
    });

    openssl.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    openssl.on('close', (code) => {
      if (!connected) {
        clearTimeout(timeout);
        reject(new Error(`OpenSSL exited with code ${code}`));
      }
    });

    // Give OpenSSL a moment to establish connection
    setTimeout(() => {
      if (!openssl.killed && openssl.stdin?.writable) {
        connected = true;
        clearTimeout(timeout);

        // Create a fake socket-like wrapper around the OpenSSL process
        const wrapper = new net.Socket();
        (wrapper as any)._opensslProcess = openssl;
        (wrapper as any).write = (data: Buffer) => {
          openssl.stdin?.write(data);
          return true;
        };
        (wrapper as any).destroy = () => {
          openssl.kill();
        };
        (wrapper as any).destroyed = false;

        // Forward stdout to socket data events
        openssl.stdout?.on('data', (data: Buffer) => {
          wrapper.emit('data', data);
        });

        openssl.on('close', () => {
          (wrapper as any).destroyed = true;
          wrapper.emit('close');
        });

        resolve(wrapper);
      }
    }, 1000);
  });
}

/**
 * Start bidirectional packet forwarding between TUN and socket
 */
function startPacketForwarding(tun: TunTap, socket: net.Socket): void {
  let buffer = Buffer.alloc(0);

  // Socket -> TUN (device to local)
  socket.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    // Process complete IPv6 packets
    let offset = 0;
    while (offset + 40 <= buffer.length) {
      const header = buffer.slice(offset, offset + 40);
      const version = (header[0] >> 4) & 0x0f;

      if (version !== 6) {
        offset++;
        continue;
      }

      const payloadLength = header.readUInt16BE(4);
      const totalLength = 40 + payloadLength;

      if (offset + totalLength > buffer.length) {
        break;
      }

      const packet = buffer.slice(offset, offset + totalLength);
      try {
        tun.write(packet);
      } catch (err) {
        log.debug(`TUN write error: ${err}`);
      }

      offset += totalLength;
    }

    if (offset > 0) {
      buffer = buffer.slice(offset);
    }
  });

  // TUN -> Socket (local to device)
  const readInterval = setInterval(() => {
    try {
      const data = tun.read(16384);
      if (data && data.length > 0) {
        (socket as any).write(data);
      }
    } catch (err) {
      // Ignore read errors (non-blocking)
    }
  }, 5);

  // Cleanup on socket close
  socket.on('close', () => {
    clearInterval(readInterval);
  });
}

/**
 * Exchange CDTunnel parameters with the device
 */
async function exchangeCDTunnelParams(socket: net.Socket): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = {
      type: 'clientHandshakeRequest',
      mtu: 16000,
    };

    const requestJSON = JSON.stringify(request);
    const jsonBuffer = Buffer.from(requestJSON);
    const magic = Buffer.from('CDTunnel');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(jsonBuffer.length);
    const message = Buffer.concat([magic, length, jsonBuffer]);

    log.debug(`Sending CDTunnel request: ${requestJSON}`);
    (socket as any).write(message);

    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      reject(new Error('CDTunnel exchange timeout'));
    }, 10000);

    const handleData = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      log.debug(`Received ${data.length} bytes, total buffer: ${buffer.length}`);

      if (buffer.length < 10) {
        return;
      }

      const receivedMagic = buffer.slice(0, 8).toString();
      if (receivedMagic !== 'CDTunnel') {
        clearTimeout(timeout);
        socket.removeListener('data', handleData);
        reject(new Error(`Invalid magic: ${receivedMagic}`));
        return;
      }

      const payloadLength = buffer.readUInt16BE(8);
      const totalLength = 8 + 2 + payloadLength;

      if (buffer.length >= totalLength) {
        clearTimeout(timeout);
        socket.removeListener('data', handleData);

        const payload = buffer.slice(10, totalLength);
        try {
          const response = JSON.parse(payload.toString());
          resolve(response);
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${err}`));
        }
      }
    };

    socket.on('data', handleData);
  });
}

/**
 * Import pairing keys from pymobiledevice3 format
 */
async function importPairingKeys(udid: string): Promise<boolean> {
  const pmd3Path = join(homedir(), '.pymobiledevice3', `remote_${udid}.plist`);

  if (!existsSync(pmd3Path)) {
    log.error(`Pairing record not found at: ${pmd3Path}`);
    log.info('');
    log.info('To create a pairing record, first pair the device over USB:');
    log.info('  sudo pymobiledevice3 remote start-tunnel');
    log.info('');
    return false;
  }

  try {
    log.info(`Importing pairing keys from: ${pmd3Path}`);
    const plistData = readFileSync(pmd3Path);
    const parsed = parsePlist(plistData) as Record<string, Buffer | string>;

    const storage = getRemotePairingStorage();
    await storage.save(
      udid,
      Buffer.isBuffer(parsed.public_key)
        ? parsed.public_key
        : Buffer.from(parsed.public_key as string, 'base64'),
      Buffer.isBuffer(parsed.private_key)
        ? parsed.private_key
        : Buffer.from(parsed.private_key as string, 'base64'),
      typeof parsed.remote_unlock_host_key === 'string'
        ? parsed.remote_unlock_host_key
        : '',
    );

    log.info(`Successfully imported pairing keys for ${udid}`);
    return true;
  } catch (error) {
    log.error(`Failed to import pairing keys: ${error}`);
    return false;
  }
}

/**
 * List all stored pairing records
 */
async function listStoredRecords(): Promise<void> {
  const storage = getRemotePairingStorage();
  const identifiers = await storage.listIdentifiers();

  if (identifiers.length === 0) {
    log.info('No stored pairing records found');
  } else {
    log.info(`Found ${identifiers.length} stored pairing record(s):`);
    for (const id of identifiers) {
      log.info(`  - ${id}`);
    }
  }
}

/**
 * Discover WiFi devices
 */
async function discoverDevices(): Promise<void> {
  log.info('Discovering WiFi devices...');

  const discovery = new WiFiDeviceDiscovery();
  const devices = await discovery.discoverDevices(10000); // 10 second timeout

  if (devices.length === 0) {
    log.warn('No WiFi devices found.');
    log.info('');
    log.info('Make sure:');
    log.info('  1. The iOS device is on the same WiFi network');
    log.info('  2. The device has been previously paired over USB');
    log.info('  3. The device is not connected via USB (may interfere)');
    return;
  }

  log.info(`Found ${devices.length} WiFi device(s):`);
  for (const device of devices) {
    log.info(`  - Name: ${device.name}`);
    log.info(`    Identifier: ${device.identifier}`);
    log.info(`    IP: ${device.ip}`);
    log.info(`    Port: ${device.port}`);
    log.info(`    Has Pairing Record: ${device.hasPairingRecord ? 'Yes' : 'No'}`);
    log.info('');
  }
}

/**
 * Attempt WiFi tunnel connection
 */
async function connectToDevice(
  identifier: string,
  ip: string,
  port: number,
): Promise<void> {
  log.info(`Connecting to ${identifier} at ${ip}:${port}...`);

  const tunnelService = new RemotePairingTunnelService(identifier, ip, port);

  try {
    const result = await tunnelService.connect();
    log.info('');
    log.info('✅ WiFi pairing connection successful!');
    log.info(`   Remote Identifier: ${result.remoteIdentifier}`);
    log.info(`   Hostname: ${result.hostname}`);
    log.info(`   Port: ${result.port}`);
    log.info('');

    // Try to create TCP listener for tunnel
    log.info('Creating TCP listener for tunnel...');
    try {
      const listener = await tunnelService.createTcpListener();
      log.info('');
      log.info('✅ TCP Listener created!');
      log.info(`   Listener Port: ${listener.port}`);
      log.info('');

      // Attempt TLS-PSK connection using OpenSSL
      const pskHex = result.encryptionKey.toString('hex');
      log.info('Attempting TLS-PSK connection using OpenSSL...');
      log.info(`   Target: ${ip}:${listener.port}`);

      try {
        const tlsPskSocket = await connectWithTlsPsk(
          ip,
          listener.port,
          pskHex,
        );
        log.info('');
        log.info('✅ TLS-PSK connection established!');

        // Now try to exchange CDTunnel parameters
        log.info('Exchanging CDTunnel parameters...');
        const tunnelInfo = await exchangeCDTunnelParams(tlsPskSocket);
        log.info('');
        log.info('✅ CDTunnel parameters exchanged!');
        log.info(`   Server Address: ${tunnelInfo.serverAddress}`);
        log.info(`   Server RSD Port: ${tunnelInfo.serverRSDPort}`);
        log.info(`   Client Address: ${tunnelInfo.clientParameters?.address}`);
        log.info(`   MTU: ${tunnelInfo.clientParameters?.mtu}`);
        log.info('');

        // Set up TUN interface
        log.info('Setting up TUN interface...');
        const tun = new TunTap();
        if (!tun.open()) {
          throw new Error('Failed to open TUN device');
        }
        log.info(`   TUN device opened: ${tun.name}`);

        // Configure TUN with client address and MTU
        await tun.configure(
          tunnelInfo.clientParameters.address,
          tunnelInfo.clientParameters.mtu,
        );
        log.info(`   Configured with address: ${tunnelInfo.clientParameters.address}`);

        // Add route for server address
        await tun.addRoute(`${tunnelInfo.serverAddress}/128`);
        log.info(`   Added route to: ${tunnelInfo.serverAddress}`);

        // Start packet forwarding
        log.info('Starting packet forwarding...');
        startPacketForwarding(tun, tlsPskSocket);

        log.info('');
        log.info('🎉 WiFi tunnel ACTIVE and ready for RSD services!');
        log.info('');
        log.info('   ╔════════════════════════════════════════════════════╗');
        log.info('   ║  RSD Connection Info                               ║');
        log.info('   ╠════════════════════════════════════════════════════╣');
        log.info(`   ║  Address: ${tunnelInfo.serverAddress.padEnd(27)}║`);
        log.info(`   ║  Port:    ${String(tunnelInfo.serverRSDPort).padEnd(27)}║`);
        log.info('   ╚════════════════════════════════════════════════════╝');
        log.info('');
        log.info('   Example commands to test RSD services:');
        log.info(`   pymobiledevice3 developer dvt ls / --rsd ${tunnelInfo.serverAddress} ${tunnelInfo.serverRSDPort}`);
        log.info('');

        // Keep running and handle cleanup
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => {
            log.info('\nShutting down WiFi tunnel...');
            tun.close();
            (tlsPskSocket as any).destroy();
            tunnelService.close().then(resolve);
          });
        });
        return; // Don't fall through to the outer cleanup
      } catch (tlsError) {
        log.error(`TLS-PSK connection failed: ${tlsError}`);
        log.info('');
        log.info('📝 Manual TLS-PSK connection info:');
        log.info(`   Host: ${ip}`);
        log.info(`   Port: ${listener.port}`);
        log.info(`   PSK (hex): ${pskHex}`);
        log.info('');
        log.info('   Try with OpenSSL:');
        log.info(
          `   openssl s_client -connect ${ip}:${listener.port} -psk ${pskHex} -psk_identity "" -tls1_2`,
        );
      }
    } catch (listenerError) {
      log.error(`Failed to create TCP listener: ${listenerError}`);
    }

    // Keep connection open for inspection
    log.info('');
    log.info('Connection established. Press Ctrl+C to disconnect...');

    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        log.info('\nClosing connection...');
        tunnelService.close().then(resolve);
      });
    });
  } catch (error) {
    log.error(`Connection failed: ${error}`);
    log.info('');
    log.info('Troubleshooting:');
    log.info('  1. Make sure the device is on the same WiFi network');
    log.info('  2. Ensure you have imported or created pairing keys:');
    log.info(`     sudo tsx scripts/test-wifi-tunnel.ts --import-keys ${identifier}`);
    log.info('  3. Try restarting the device');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  const importKeysIndex = args.indexOf('--import-keys');
  const discoverOnly = args.includes('--discover-only');
  const listRecords = args.includes('--list-records');

  log.info('=== WiFi Tunnel Test ===');
  log.info('');

  // Handle --list-records
  if (listRecords) {
    await listStoredRecords();
    return;
  }

  // Handle --import-keys
  if (importKeysIndex !== -1) {
    const udid = args[importKeysIndex + 1];
    if (!udid) {
      log.error('Please provide a UDID: --import-keys <udid>');
      process.exit(1);
    }
    const success = await importPairingKeys(udid);
    if (!success) {
      process.exit(1);
    }
    log.info('');
  }

  // Discover devices
  await discoverDevices();

  if (discoverOnly) {
    return;
  }

  // Try to connect to the first paired device found
  const discovery = new WiFiDeviceDiscovery();
  const pairedDevices = await discovery.discoverPairedDevices(5000);

  if (pairedDevices.length === 0) {
    log.warn('No paired WiFi devices found.');
    log.info('');
    log.info('To pair a device and import keys:');
    log.info('  1. First pair the device using pymobiledevice3:');
    log.info('     sudo pymobiledevice3 remote start-tunnel');
    log.info('  2. Then import the keys:');
    log.info('     sudo tsx scripts/test-wifi-tunnel.ts --import-keys <udid>');
    return;
  }

  const device = pairedDevices[0];
  log.info(`Attempting connection to: ${device.identifier}`);
  await connectToDevice(device.identifier, device.ip, device.port);
}

// Run
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});

