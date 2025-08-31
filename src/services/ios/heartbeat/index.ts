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
 * with Polo responses.
 */
class HeartbeatService
  extends BaseService
  implements HeartbeatServiceInterface
{
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.heartbeat.shim.remote';
  private readonly timeout: number;
  private _conn: ServiceConnection | null = null;

  constructor(address: [string, number], timeout: number = 10000) {
    super(address);
    this.timeout = timeout;
  }

  /**
   * Start the heartbeat service and establish connection
   * Continuously receives messages from iOS and responds with Polo commands
   * @param interval Optional interval in seconds to stop after receiving messages
   * @returns Promise that resolves when the service stops
   */
  async start(interval?: number): Promise<void> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }

    log.info('Heartbeat service started');
    const startTime = Date.now();

    while (true) {
      try {
        // Wait for message from iOS (blocks until received)
        const response = await this._conn.receive(this.timeout);
        log.debug(`Received heartbeat: ${JSON.stringify(response)}`);

        // Check if we should stop based on interval (after receiving message)
        if (interval && (Date.now() - startTime) / 1000 >= interval) {
          break;
        }

        // Send Polo response (no response expected)
        (this._conn as any)
          .getPlistService()
          .sendPlist(this.createHeartbeatRequest());
        log.debug('Sent Polo response');
      } catch (error) {
        log.error(`Heartbeat error: ${(error as Error).message}`);
        throw error;
      }
    }
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

  private createHeartbeatRequest(): PlistDictionary {
    return { Command: 'Polo' };
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
