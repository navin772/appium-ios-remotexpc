/**
 * WiFi Device Discovery Service
 *
 * Discovers iOS devices advertising the _remotepairing._tcp service via Bonjour.
 * These are devices that have been previously paired over USB and are now
 * available for WiFi tunnel connections.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { logger } from '@appium/support';

import {
  BONJOUR_DEFAULT_DOMAIN,
  BONJOUR_SERVICE_TYPES,
  BONJOUR_TIMEOUTS,
  DNS_SD_ACTIONS,
  DNS_SD_COMMANDS,
  DNS_SD_PATTERNS,
} from '../bonjour/constants.js';
import { getRemotePairingStorage } from './remote-pairing-storage.js';

const log = logger.getLogger('WiFiDeviceDiscovery');

const DNS_SD_COMMAND = 'dns-sd';

/**
 * Discovered WiFi device information
 */
export interface WiFiDevice {
  /** Device name from Bonjour service */
  name: string;
  /** Device UDID (matched from stored pairing records) */
  identifier: string;
  /** Device IP address */
  ip: string;
  /** Service port */
  port: number;
  /** Network interface name (e.g., 'en0') */
  interfaceIndex?: number;
  /** Whether we have a stored pairing record for this device */
  hasPairingRecord: boolean;
  /** Bonjour session identifier (different from device UDID) */
  bonjourSessionId?: string;
}

/**
 * Raw Bonjour service result before IP resolution
 */
interface BonjourServiceResult {
  name: string;
  type: string;
  domain: string;
  hostname?: string;
  port?: number;
  txtRecord?: Record<string, string>;
  interfaceIndex?: number;
}

/**
 * WiFi Device Discovery Service
 *
 * Discovers iOS devices on the local network that support remote pairing.
 */
export class WiFiDeviceDiscovery {
  private browseProcess?: ChildProcess;
  private readonly discoveredServices: Map<string, BonjourServiceResult> =
    new Map();

  /**
   * Discovers all WiFi devices with remote pairing support
   * @param timeoutMs - Discovery timeout in milliseconds
   * @returns Array of discovered WiFi devices
   */
  async discoverDevices(
    timeoutMs: number = BONJOUR_TIMEOUTS.DEFAULT_DISCOVERY,
  ): Promise<WiFiDevice[]> {
    log.info('Starting WiFi device discovery...');

    try {
      // Browse for remote pairing services
      const services = await this.browseServices(timeoutMs);

      if (services.length === 0) {
        log.info('No WiFi devices found');
        return [];
      }

      // Resolve each service to get full details
      const devices: WiFiDevice[] = [];
      for (const service of services) {
        try {
          const resolved = await this.resolveService(service.name);
          if (resolved) {
            const device = await this.convertToWiFiDevice(resolved);
            if (device) {
              devices.push(device);
            }
          }
        } catch (error) {
          log.warn(`Failed to resolve service ${service.name}: ${error}`);
        }
      }

      log.info(`Discovered ${devices.length} WiFi device(s)`);
      return devices;
    } catch (error) {
      log.error('WiFi device discovery failed:', error);
      throw error;
    }
  }

  /**
   * Discovers WiFi devices that have stored pairing records
   * This matches discovered addresses with stored pairing identifiers.
   *
   * @param timeoutMs - Discovery timeout in milliseconds
   * @returns Array of paired WiFi devices ready for connection
   */
  async discoverPairedDevices(
    timeoutMs: number = BONJOUR_TIMEOUTS.DEFAULT_DISCOVERY,
  ): Promise<WiFiDevice[]> {
    log.info('Discovering paired WiFi devices...');

    // Get stored identifiers
    const storage = getRemotePairingStorage();
    const storedIdentifiers = await storage.listIdentifiers();

    if (storedIdentifiers.length === 0) {
      log.info('No stored pairing records found');
      return [];
    }

    log.debug(`Found ${storedIdentifiers.length} stored pairing record(s)`);

    // Browse for services
    const services = await this.browseServices(timeoutMs);
    if (services.length === 0) {
      log.info('No remote pairing services found on network');
      return [];
    }

    // Resolve services and create device entries for each stored identifier
    const devices: WiFiDevice[] = [];

    for (const service of services) {
      try {
        const resolved = await this.resolveService(service.name);
        if (!resolved || !resolved.hostname || !resolved.port) {
          continue;
        }

        const ip = await this.resolveHostname(resolved.hostname);
        if (!ip) {
          continue;
        }

        // Skip link-local addresses (169.254.x.x) as they're usually not usable
        if (ip.startsWith('169.254.')) {
          log.debug(`Skipping link-local address: ${ip}`);
          continue;
        }

        // For each stored identifier, create a potential device entry
        // The actual matching happens when we try to connect
        for (const identifier of storedIdentifiers) {
          devices.push({
            name: service.name,
            identifier,
            ip,
            port: resolved.port,
            interfaceIndex: resolved.interfaceIndex,
            hasPairingRecord: true,
            bonjourSessionId: resolved.txtRecord?.identifier || service.name,
          });
        }
      } catch (error) {
        log.warn(`Failed to resolve service ${service.name}: ${error}`);
      }
    }

    // Deduplicate by identifier+ip
    const seen = new Set<string>();
    const uniqueDevices = devices.filter((d) => {
      const key = `${d.identifier}@${d.ip}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    log.info(`Found ${uniqueDevices.length} potential paired device connection(s)`);
    return uniqueDevices;
  }

  /**
   * Browses for remote pairing services
   */
  private async browseServices(
    timeoutMs: number,
  ): Promise<BonjourServiceResult[]> {
    return new Promise((resolve, reject) => {
      const services: BonjourServiceResult[] = [];
      const serviceType = BONJOUR_SERVICE_TYPES.REMOTE_PAIRING;
      const domain = BONJOUR_DEFAULT_DOMAIN;

      const child = spawn(DNS_SD_COMMAND, [
        DNS_SD_COMMANDS.BROWSE,
        serviceType,
        domain,
      ]);

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);

      let buffer = '';

      child.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const result = this.parseBrowseLine(line);
          if (result && result.action === DNS_SD_ACTIONS.ADD) {
            // Avoid duplicates
            const key = `${result.service.name}@${result.service.type}`;
            if (!this.discoveredServices.has(key)) {
              this.discoveredServices.set(key, result.service);
              services.push(result.service);
              log.debug(`Found service: ${result.service.name}`);
            }
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        log.debug(`dns-sd stderr: ${data.toString()}`);
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      child.on('close', () => {
        clearTimeout(timeoutId);
        resolve(services);
      });
    });
  }

  /**
   * Resolves a service to get hostname and port
   */
  private async resolveService(
    serviceName: string,
  ): Promise<BonjourServiceResult | null> {
    return new Promise((resolve, reject) => {
      const serviceType = BONJOUR_SERVICE_TYPES.REMOTE_PAIRING;
      const domain = BONJOUR_DEFAULT_DOMAIN;

      const child = spawn(DNS_SD_COMMAND, [
        DNS_SD_COMMANDS.RESOLVE,
        serviceName,
        serviceType,
        domain,
      ]);

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        resolve(null);
      }, BONJOUR_TIMEOUTS.SERVICE_RESOLUTION);

      let buffer = '';

      child.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();

        // Check for reachable pattern
        const reachableMatch = buffer.match(DNS_SD_PATTERNS.REACHABLE);
        if (reachableMatch) {
          clearTimeout(timeoutId);
          child.kill('SIGTERM');

          const [, hostname, port, interfaceIndex] = reachableMatch;
          const txtRecord = this.parseTxtRecord(buffer);

          resolve({
            name: serviceName,
            type: serviceType,
            domain,
            hostname,
            port: parseInt(port, 10),
            txtRecord,
            interfaceIndex: parseInt(interfaceIndex, 10),
          });
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      child.on('close', () => {
        clearTimeout(timeoutId);
        resolve(null);
      });
    });
  }

  /**
   * Parses a browse output line
   */
  private parseBrowseLine(
    line: string,
  ): { action: string; service: BonjourServiceResult } | null {
    const match = line.match(DNS_SD_PATTERNS.BROWSE_LINE);
    if (!match) {
      return null;
    }

    const [, , action, , interfaceIndex, domain, serviceType, name] = match;

    return {
      action,
      service: {
        name: name.trim(),
        type: serviceType,
        domain,
        interfaceIndex: parseInt(interfaceIndex, 10),
      },
    };
  }

  /**
   * Parses TXT record from resolve output
   * Remote pairing TXT records contain: identifier, authTag, ver, minVer, flags
   */
  private parseTxtRecord(output: string): Record<string, string> {
    const txtRecord: Record<string, string> = {};

    // Look for TXT record line
    const txtMatch = output.match(/txtRecord\s*=\s*(.+)/i);
    if (!txtMatch) {
      // Try alternative format
      const keyValueMatches = output.matchAll(
        /(\w+)=([^\s]+)/g,
      );
      for (const match of keyValueMatches) {
        txtRecord[match[1]] = match[2];
      }
      return txtRecord;
    }

    // Parse key=value pairs from TXT record
    const keyValueMatches = txtMatch[1].matchAll(/(\w+)=([^\s"]+)/g);
    for (const match of keyValueMatches) {
      txtRecord[match[1]] = match[2];
    }

    return txtRecord;
  }

  /**
   * Converts a resolved Bonjour service to a WiFiDevice
   * Note: The identifier from Bonjour is a session UUID, not the device UDID.
   * Use discoverPairedDevices() to get devices matched with stored UDIDs.
   */
  private async convertToWiFiDevice(
    service: BonjourServiceResult,
  ): Promise<WiFiDevice | null> {
    if (!service.hostname || !service.port) {
      log.warn(`Service ${service.name} missing hostname or port`);
      return null;
    }

    // Resolve hostname to IP
    const ip = await this.resolveHostname(service.hostname);
    if (!ip) {
      log.warn(`Could not resolve IP for ${service.hostname}`);
      return null;
    }

    // Skip link-local addresses
    if (ip.startsWith('169.254.')) {
      log.debug(`Skipping link-local address: ${ip}`);
      return null;
    }

    // The Bonjour service name/identifier is a session UUID, not the device UDID
    // We use it as the identifier here, but the actual UDID matching happens in discoverPairedDevices()
    const bonjourSessionId = service.txtRecord?.identifier || service.name;

    return {
      name: service.name,
      identifier: bonjourSessionId, // This is NOT the device UDID
      ip,
      port: service.port,
      interfaceIndex: service.interfaceIndex,
      hasPairingRecord: false, // Will be set correctly in discoverPairedDevices()
      bonjourSessionId,
    };
  }

  /**
   * Resolves hostname to IP address
   */
  private async resolveHostname(hostname: string): Promise<string | null> {
    const clean = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    try {
      // Try IPv4 first
      const results = await lookup(clean, { family: 4, all: true });
      const list = Array.isArray(results) ? results : [results];
      if (list.length > 0) {
        return list[0].address;
      }
    } catch {
      // Fall through to try IPv6
    }

    try {
      // Try IPv6
      const results = await lookup(clean, { family: 6, all: true });
      const list = Array.isArray(results) ? results : [results];
      if (list.length > 0) {
        return list[0].address;
      }
    } catch {
      // Fall through
    }

    // If dns lookup fails, check if it's already an IP
    if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
      return clean;
    }

    return null;
  }
}

// Singleton instance
let discoveryInstance: WiFiDeviceDiscovery | null = null;

/**
 * Gets the singleton WiFiDeviceDiscovery instance
 */
export function getWiFiDeviceDiscovery(): WiFiDeviceDiscovery {
  if (!discoveryInstance) {
    discoveryInstance = new WiFiDeviceDiscovery();
  }
  return discoveryInstance;
}

