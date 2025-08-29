import { logger } from '@appium/support';

import type {
  HeartbeatService as HeartbeatServiceInterface,
  PlistDictionary,
  PlistMessage,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('HeartbeatService');

export interface HeartbeatRequest extends PlistDictionary {
  Command: 'Polo';
}

/**
 * HeartbeatService provides an API to:
 * - Start heartbeat session for connection keep-alive
 * - Send heartbeat requests (Polo commands)
 * - Receive heartbeat responses for connection monitoring
 */
class HeartbeatService extends BaseService implements HeartbeatServiceInterface {
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
   * @returns Promise that resolves when the connection is established
   */
  async start(): Promise<void> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }
    this._isHeartbeatRunning = true;
    log.info('Heartbeat service started');
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
   * Send a heartbeat response (Polo command) after receiving Marco
   * @returns Promise that resolves when the Polo response is sent
   */
  async sendPolo(): Promise<void> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }
    
    const request = this.createHeartbeatRequest();
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
   * Wait for any message from iOS and send Polo response
   * @returns Promise that resolves with the message received from iOS
   */
  async waitForMessageAndSendPolo(): Promise<PlistDictionary> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }
    
    // Wait for any message from iOS (not specifically Marco)
    const message = await this._conn.receive(this.timeout);
    log.debug(`Received message from iOS: ${JSON.stringify(message)}`);
    
    // Send Polo response to any message received
    await this.sendPolo();
    
    return message as PlistDictionary;
  }

  /**
   * Start heartbeat monitoring with automatic interval
   * @param interval Interval in seconds (if specified, stops after interval)
   * @returns AsyncGenerator yielding heartbeat responses
   */
  async *monitorHeartbeat(interval?: number): AsyncGenerator<PlistMessage> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }

    this._isHeartbeatRunning = true;
    const startTime = Date.now();

    while (this._isHeartbeatRunning) {
      try {
        const response = await this._conn.receive(this.timeout);
        log.debug(`Received heartbeat: ${JSON.stringify(response)}`);
        
        yield response;

        if (interval && (Date.now() - startTime) / 1000 >= interval) {
          break;
        }

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
   * Wait for a single heartbeat response
   * @param timeout Timeout in milliseconds
   * @returns Promise resolving to the heartbeat response
   */
  async waitForHeartbeat(timeout: number = 10000): Promise<PlistMessage> {
    if (!this._conn) {
      this._conn = await this.connectToHeartbeatService();
    }

    try {
      const response = await this._conn.receive(timeout);
      log.debug(`Received heartbeat response: ${JSON.stringify(response)}`);
      return response;
    } catch (error) {
      log.error(`Error waiting for heartbeat: ${(error as Error).message}`);
      throw error;
    }
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

  private createHeartbeatRequest(): HeartbeatRequest {
    return {
      Command: 'Polo',
    };
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
