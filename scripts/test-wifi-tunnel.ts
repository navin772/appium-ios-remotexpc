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
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { logger } from '@appium/support';

import {
  WiFiDeviceDiscovery,
  RemotePairingTunnelService,
  getRemotePairingStorage,
} from '../src/lib/remote-pairing/index.js';
import { parsePlist } from '../src/lib/plist/index.js';

const log = logger.getLogger('WiFiTunnelTest');

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
    log.info('✅ WiFi tunnel connection successful!');
    log.info(`   Remote Identifier: ${result.remoteIdentifier}`);
    log.info(`   Hostname: ${result.hostname}`);
    log.info(`   Port: ${result.port}`);
    log.info('');

    // Keep connection open for inspection
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

