/**
 * Remote Pairing Storage
 *
 * Stores and retrieves iOS remote pairing records for WiFi tunnel connections.
 * These records contain Ed25519 keys generated during the initial USB pairing
 * that are used to verify the host identity when connecting over WiFi.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { strongbox } from '@appium/strongbox';
import { logger } from '@appium/support';

import { STRONGBOX_CONTAINER_NAME } from '../../constants.js';
import { createXmlPlist, parsePlist } from '../plist/index.js';

const log = logger.getLogger('RemotePairingStorage');

/**
 * Remote pairing record containing Ed25519 keys for WiFi verification
 */
export interface RemotePairingRecord {
  /** Ed25519 private key (32 bytes) */
  privateKey: Buffer;
  /** Ed25519 public key (32 bytes) */
  publicKey: Buffer;
  /** Remote unlock host key (optional) */
  remoteUnlockHostKey?: string;
}

/**
 * Manages persistent storage of remote pairing credentials
 * Uses Strongbox for secure storage of sensitive key material
 */
export class RemotePairingStorage {
  private readonly box;
  private static readonly RECORD_PREFIX = 'remote_pairing_';

  constructor() {
    this.box = strongbox(STRONGBOX_CONTAINER_NAME);
  }

  /**
   * Generates the storage item name for a device identifier
   * @param identifier - Device UDID
   * @returns Storage item name
   */
  private getItemName(identifier: string): string {
    return `${RemotePairingStorage.RECORD_PREFIX}${identifier}`;
  }

  /**
   * Saves a remote pairing record for a device
   * @param identifier - Device UDID
   * @param publicKey - Ed25519 public key (32 bytes)
   * @param privateKey - Ed25519 private key (32 bytes)
   * @param remoteUnlockHostKey - Remote unlock host key (optional)
   * @returns Path to the saved record
   */
  async save(
    identifier: string,
    publicKey: Buffer,
    privateKey: Buffer,
    remoteUnlockHostKey = '',
  ): Promise<string> {
    try {
      const itemName = this.getItemName(identifier);
      const plistContent = this.createPlistContent(
        publicKey,
        privateKey,
        remoteUnlockHostKey,
      );

      const item = await this.box.createItemWithValue(itemName, plistContent);
      const itemPath = item.id;

      log.info(`Remote pairing record saved for ${identifier} at: ${itemPath}`);

      return itemPath;
    } catch (error) {
      log.error(`Failed to save remote pairing record for ${identifier}:`, error);
      throw new Error(
        `Failed to save remote pairing record: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Loads a remote pairing record for a device
   * @param identifier - Device UDID
   * @returns Remote pairing record or null if not found
   */
  async load(identifier: string): Promise<RemotePairingRecord | null> {
    try {
      const recordPath = this.getRecordPath(identifier);

      if (!existsSync(recordPath)) {
        log.debug(`No remote pairing record found for ${identifier}`);
        return null;
      }

      const content = readFileSync(recordPath, 'utf8');
      if (!content) {
        log.warn(`Empty remote pairing record for ${identifier}`);
        return null;
      }

      const parsed = parsePlist(Buffer.from(content)) as Record<
        string,
        Buffer | string
      >;

      const record: RemotePairingRecord = {
        privateKey: this.ensureBuffer(parsed.private_key),
        publicKey: this.ensureBuffer(parsed.public_key),
        remoteUnlockHostKey:
          typeof parsed.remote_unlock_host_key === 'string'
            ? parsed.remote_unlock_host_key
            : undefined,
      };

      log.debug(`Loaded remote pairing record for ${identifier}`);
      return record;
    } catch (error) {
      log.error(
        `Failed to load remote pairing record for ${identifier}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Gets the file path for a pairing record
   */
  private getRecordPath(identifier: string): string {
    const containerPath = this.getContainerPath();
    return join(containerPath, this.getItemName(identifier));
  }

  /**
   * Checks if a remote pairing record exists for a device
   * @param identifier - Device UDID
   * @returns True if record exists
   */
  async exists(identifier: string): Promise<boolean> {
    try {
      const recordPath = this.getRecordPath(identifier);
      return existsSync(recordPath);
    } catch (error) {
      log.debug(`Error checking if record exists for ${identifier}:`, error);
      return false;
    }
  }

  /**
   * Deletes a remote pairing record
   * @param identifier - Device UDID
   */
  async delete(identifier: string): Promise<void> {
    try {
      const itemName = this.getItemName(identifier);
      const item = await this.box.getItem(itemName);
      if (item) {
        await item.delete();
        log.info(`Deleted remote pairing record for ${identifier}`);
      }
    } catch (error) {
      log.error(`Failed to delete remote pairing record for ${identifier}:`, error);
    }
  }

  /**
   * Gets the strongbox container directory path
   */
  private getContainerPath(): string {
    // Strongbox stores files in Application Support/container-name-nodejs/strongbox/
    return this.box.container as string;
  }

  /**
   * Lists all stored remote pairing identifiers
   * @returns Array of device identifiers with stored pairing records
   */
  async listIdentifiers(): Promise<string[]> {
    try {
      const containerPath = this.getContainerPath();
      const prefix = RemotePairingStorage.RECORD_PREFIX;
      const identifiers: string[] = [];

      if (!existsSync(containerPath)) {
        return identifiers;
      }

      const files = readdirSync(containerPath);
      for (const file of files) {
        if (file.startsWith(prefix)) {
          const identifier = file.replace(prefix, '');
          identifiers.push(identifier);
        }
      }

      return identifiers;
    } catch (error) {
      log.error('Failed to list remote pairing identifiers:', error);
      return [];
    }
  }

  /**
   * Creates plist content for storage
   */
  private createPlistContent(
    publicKey: Buffer,
    privateKey: Buffer,
    remoteUnlockHostKey: string,
  ): string {
    return createXmlPlist({
      private_key: privateKey,
      public_key: publicKey,
      remote_unlock_host_key: remoteUnlockHostKey,
    });
  }

  /**
   * Ensures value is a Buffer
   */
  private ensureBuffer(value: Buffer | string | undefined): Buffer {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (typeof value === 'string') {
      // Try base64 decoding first (plist data is often base64 encoded)
      return Buffer.from(value, 'base64');
    }
    return Buffer.alloc(0);
  }
}

// Singleton instance for convenience
let storageInstance: RemotePairingStorage | null = null;

/**
 * Gets the singleton RemotePairingStorage instance
 */
export function getRemotePairingStorage(): RemotePairingStorage {
  if (!storageInstance) {
    storageInstance = new RemotePairingStorage();
  }
  return storageInstance;
}

