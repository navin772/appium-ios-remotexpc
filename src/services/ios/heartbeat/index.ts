import { logger } from '@appium/support';

import type {
  HeartbeatService as HeartbeatServiceInterface,
  PlistDictionary,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('HeartbeatService');

/**
 * HeartbeatService - Maintains active connection with lockdownd
 * Receives heartbeat messages from iOS and responds with Polo commands
 */
class HeartbeatService
  extends BaseService
  implements HeartbeatServiceInterface
{
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.heartbeat.shim.remote';

  constructor(address: [string, number]) {
    super(address);
  }

  /**
   * Start the heartbeat service
   * Establishes connection and continuously handles heartbeat requests
   * @param interval Optional interval in seconds to stop after
   */
  async start(interval?: number): Promise<void> {
    const service = this.getServiceConfig();
    const connection = await this.startLockdownService(service);
    
    log.info('Starting HeartbeatService');
    const startTime = Date.now();

    while (true) {
      try {
        // Receive heartbeat message from iOS
        const response = await connection.receive();
        log.debug(`Received heartbeat: ${JSON.stringify(response)}`);

        if (interval && (Date.now() - startTime) / 1000 >= interval) {
          break;
        }

        (connection as any).send({ Command: 'Polo' });
        log.debug('Sent Polo response');

      } catch (error) {
        const elapsed = (Date.now() - startTime) / 1000;
        log.info(`HeartbeatService finished after ${elapsed.toFixed(1)}s: ${(error as Error).message}`);
        throw error;
      }
    }
  }

  private getServiceConfig() {
    return {
      serviceName: HeartbeatService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
      options: { createConnectionTimeout: 10000 },
    };
  }
}

export { HeartbeatService };
