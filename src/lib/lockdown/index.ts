import { logger } from '@appium/support';
import { Socket } from 'node:net';
import tls, { type ConnectionOptions, TLSSocket } from 'tls';

import { BasePlistService } from '../../base-plist-service.js';
import { type PairRecord } from '../pair-record/index.js';
import { PlistService } from '../plist/plist-service.js';
import type { PlistValue } from '../types.js';
import { connectAndRelay, createUsbmux } from '../usbmux/index.js';

const log = logger.getLogger('Lockdown');
const LABEL = 'appium-internal';

interface Device {
  DeviceID: number;
  MessageType: string;
  Properties: {
    ConnectionSpeed: number;
    ConnectionType: string;
    DeviceID: number;
    LocationID: number;
    ProductID: number;
    SerialNumber: string;
    USBSerialNumber: string;
  };
}

interface LockdownServiceInfo {
  lockdownService: LockdownService;
  device: Device;
}

/**
 * Upgrades a socket to TLS
 */
export function upgradeSocketToTLS(
  socket: Socket,
  tlsOptions: Partial<ConnectionOptions> = {},
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    socket.pause();
    log.info('Upgrading socket to TLS...');
    const secure = tls.connect(
      {
        socket,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        ...tlsOptions,
      },
      () => {
        log.info('TLS handshake completed');
        resolve(secure);
      },
    );
    secure.on('error', (err) => {
      log.error(`TLS socket error: ${err}`);
      reject(err);
    });
    socket.on('error', (err) => {
      log.error(`Underlying socket error during TLS: ${err}`);
      reject(err);
    });
  });
}

export class LockdownService extends BasePlistService {
  private readonly _udid: string;
  private _plistAfterTLS?: PlistService;
  private _isTLS = false;
  public _tlsUpgrade?: Promise<void>;

  constructor(socket: Socket, udid: string, autoSecure = true) {
    super(socket);
    this._udid = udid;
    log.info(`LockdownService initialized for UDID: ${udid}`);
    if (autoSecure) {
      this._tlsUpgrade = this.tryUpgradeToTLS().catch((err) =>
        log.warn(`Auto TLS upgrade failed: ${err.message}`),
      );
    }
  }

  async startSession(hostID: string, systemBUID: string, timeout = 5000) {
    log.info(`Starting lockdown session with HostID: ${hostID}`);
    const res = await this.sendAndReceive(
      {
        Label: LABEL,
        Request: 'StartSession',
        HostID: hostID,
        SystemBUID: systemBUID,
      },
      timeout,
    );
    if (res.Request === 'StartSession' && res.SessionID) {
      log.info(`Lockdown session started, SessionID: ${res.SessionID}`);
      return {
        sessionID: res.SessionID,
        enableSessionSSL: res.EnableSessionSSL,
      };
    }
    throw new Error(`Unexpected session data: ${JSON.stringify(res)}`);
  }

  async tryUpgradeToTLS(): Promise<void> {
    const pairRecord = await this.getPairRecord();
    if (
      !pairRecord?.HostCertificate ||
      !pairRecord.HostPrivateKey ||
      !pairRecord.HostID ||
      !pairRecord.SystemBUID
    ) {
      log.warn('Missing certs/session info for TLS upgrade');
      return;
    }
    let sess;
    try {
      sess = await this.startSession(pairRecord.HostID, pairRecord.SystemBUID);
    } catch (err) {
      log.error(`Failed to start session: ${err}`);
      throw err;
    }
    if (!sess.enableSessionSSL) {
      log.info('Device did not request TLS upgrade. Continuing unencrypted.');
      return;
    }
    try {
      const tlsSocket = await upgradeSocketToTLS(this.getSocket() as Socket, {
        cert: pairRecord.HostCertificate,
        key: pairRecord.HostPrivateKey,
      });
      this._plistAfterTLS = new PlistService(tlsSocket);
      this._isTLS = true;
      log.info('Successfully upgraded connection to TLS');
    } catch (err) {
      log.error(`Failed to upgrade to TLS: ${err}`);
      throw err;
    }
  }

  public getSocket(): Socket | TLSSocket {
    return this._isTLS && this._plistAfterTLS
      ? this._plistAfterTLS.getSocket()
      : this.getPlistService().getSocket();
  }

  public async sendAndReceive(msg: Record<string, PlistValue>, timeout = 5000) {
    if (this._isTLS && this._plistAfterTLS) {
      return this._plistAfterTLS.sendPlistAndReceive(msg, timeout);
    }
    return this._plistService.sendPlistAndReceive(msg, timeout);
  }

  public close() {
    log.info('Closing LockdownService connections');
    try {
      // Close the TLS service if it exists
      if (this._isTLS && this._plistAfterTLS) {
        this._plistAfterTLS.close();
      } else {
        // Otherwise close the base service
        super.close();
      }
    } catch (err) {
      log.error(`Error or closing socket: ${err}`);
    }
  }

  private async getPairRecord(): Promise<PairRecord | null> {
    try {
      log.info(`Retrieving pair record for UDID: ${this._udid}`);
      const usbmux = await createUsbmux();
      const record = await usbmux.readPairRecord(this._udid);
      await usbmux.close();
      if (!record?.HostCertificate || !record.HostPrivateKey) {
        log.error('Pair record missing certificate or key');
        return null;
      }
      log.info('Pair record retrieved successfully');
      return record;
    } catch (err) {
      log.error(`Error getting pair record for TLS: ${err}`);
      return null;
    }
  }
}

/**
 * Creates a LockdownService using the provided UDID
 */
export async function createLockdownServiceByUDID(
  udid: string,
  port = 62078,
  autoSecure = true,
): Promise<LockdownServiceInfo> {
  const usbmux = await createUsbmux();
  log.info('Listing connected devices...');

  const devices = await usbmux.listDevices();
  log.info(
    `Devices: ${devices.map((d) => d.Properties.SerialNumber).join(', ')}`,
  );

  await usbmux.close();
  if (devices.length === 0) {
    throw new Error('No devices connected');
  }

  // Verify the provided UDID exists in connected devices
  if (!devices.some((d) => d.Properties.SerialNumber === udid)) {
    throw new Error(`Provided UDID ${udid} not found among connected devices`);
  }

  const selectedUDID = udid;
  log.info(`Using UDID: ${selectedUDID}`);

  const device = devices.find(
    (d) => d.Properties.SerialNumber === selectedUDID,
  );
  if (!device) {
    log.error(`UDID ${selectedUDID} not found among connected devices`);
    throw new Error(`UDID ${selectedUDID} not found`);
  }
  log.info(
    `Found device: DeviceID=${device.DeviceID}, SerialNumber=${device.Properties.SerialNumber}, ConnectionType=${device.Properties.ConnectionType}`,
  );

  log.info(`Connecting to device ${device.DeviceID} on port ${port}...`);
  const socket: Socket = await connectAndRelay(device.DeviceID, port);
  log.info('Socket connected, creating LockdownService');

  const service = new LockdownService(socket, selectedUDID, autoSecure);
  if (autoSecure && service._tlsUpgrade) {
    log.info('Waiting for TLS upgrade to complete...');
    await service._tlsUpgrade;
  }

  return { lockdownService: service, device };
}
