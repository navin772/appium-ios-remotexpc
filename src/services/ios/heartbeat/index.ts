import { logger } from '@appium/support';

import type {
  HeartbeatService as HeartbeatServiceInterface,
  PlistDictionary,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('HeartbeatService');

/**
 * HeartbeatService - Use to keep an active connection with lockdownd
 * 
 * This service maintains a connection by responding to iOS heartbeat requests
 * with Polo responses. It follows the Python pymobiledevice3 implementation.
 */
class HeartbeatService
  extends BaseService
  implements HeartbeatServiceInterface
{
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.heartbeat.shim.remote';
  private readonly timeout: number;
  private _conn: ServiceConnection | null = null;
  private _isHeartbeatRunning: boolean = false;

  constructor(address: [string, number], timeout: number = 10000) {
    super(address);
    this.timeout = timeout;
  }

  /**
   * Start the heartbeat service and establish connection
   * Follows Python implementation: recv_plist() -> send_plist({'Command': 'Polo'}) loop
   * @param interval Optional interval in seconds to stop after
   * @param blocking If true, blocks until service stops (Python behavior). If false, starts and returns immediately.
   * @returns Promise that resolves when the service stops (if blocking) or when service starts (if non-blocking)
   */
  async start(interval?: number, blocking: boolean = false): Promise<void> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }
    
    this._isHeartbeatRunning = true;
    log.info('Heartbeat service started');
    
    if (!blocking) {
      // Non-blocking mode: start service and return immediately
      // This allows tests to call other methods on the service
      return;
    }

    // Blocking mode: matches Python implementation exactly
    const startTime = Date.now();

    // Python: while True: response = service.recv_plist() ... service.send_plist({'Command': 'Polo'})
    while (this._isHeartbeatRunning) {
      try {
        // Python: response = service.recv_plist()
        const response = await this._conn.receive(this.timeout);
        log.debug(`Received heartbeat: ${JSON.stringify(response)}`);

        // Python: if interval is not None: if time.time() >= start + interval: break
        if (interval && (Date.now() - startTime) / 1000 >= interval) {
          break;
        }

        // Python: service.send_plist({'Command': 'Polo'})
        await this.sendPolo();
        
      } catch (error) {
        if (this._isHeartbeatRunning) {
          log.error(`Heartbeat monitoring error: ${(error as Error).message}`);
          throw error;
        }
        break;
      }
    }
  }

  /**
   * Stop the heartbeat service
   * @returns Promise that resolves when the service is stopped
   */
  async stop(): Promise<void> {
    this._isHeartbeatRunning = false;
    if (this._conn) {
      await this._conn.close();
      this._conn = null;
    }
    log.info('Heartbeat service stopped');
  }

  /**
   * Send a Polo response (matches Python: service.send_plist({'Command': 'Polo'}))
   * @returns Promise that resolves when the Polo response is sent
   */
  async sendPolo(): Promise<void> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }

    const request = { Command: 'Polo' };
    try {
      await this._conn.sendPlistRequest(request, 500);
    } catch (error) {
      if (!(error as Error).message.includes('Timed out')) {
        log.error(`Error sending Polo: ${(error as Error).message}`);
        throw error;
      }
    }
    log.debug('Sent Polo response');
  }

  /**
   * Check if the heartbeat service is running
   * @returns Boolean indicating if the service is active
   */
  isRunning(): boolean {
    return this._isHeartbeatRunning && this._conn !== null;
  }

  /**
   * Connect to the heartbeat service
   * @returns Promise resolving to the ServiceConnection instance
   */
  async connectToHeartbeatService(): Promise<ServiceConnection> {
    if (this._conn) {
      return this._conn;
    }
    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  private getServiceConfig(): {
    serviceName: string;
    port: string;
    options: { createConnectionTimeout: number };
  } {
    return {
      serviceName: HeartbeatService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
      options: { createConnectionTimeout: this.timeout },
    };
  }
}

export { HeartbeatService };
