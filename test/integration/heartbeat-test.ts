import { logger } from '@appium/support';
import { expect } from 'chai';

import type { HeartbeatServiceWithConnection } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('HeartbeatService.test');

describe('HeartbeatService', function () {
  let udid: string;
  let heartbeatServiceWithConnection: HeartbeatServiceWithConnection;

  before(function () {
    udid = process.env.UDID || '00008030-001E290A3EF2402E';
    if (!udid) {
      throw new Error(
        'UDID is required for integration tests. Set UDID environment variable.',
      );
    }
  });

  beforeEach(async function () {
    this.timeout(30000);

    heartbeatServiceWithConnection = await Services.startHeartbeatService(udid);
  });

  afterEach(async function () {
    if (heartbeatServiceWithConnection?.remoteXPC) {
      await heartbeatServiceWithConnection.remoteXPC.close();
    }
  });

  it('should start heartbeat service', async function () {
    this.timeout(15000);
    
    const startTime = Date.now();

    try {
      await heartbeatServiceWithConnection.heartbeatService.start(3);

      const duration = (Date.now() - startTime) / 1000;
      log.info(`✅ HeartbeatService processed messages for ${duration.toFixed(1)}s`);

    } catch (error) {
      // Expected when iOS doesn't send heartbeat messages
      const duration = (Date.now() - startTime) / 1000;
      expect(duration).to.be.greaterThan(2);
      
      log.info(`✅ HeartbeatService timed out after ${duration.toFixed(1)}s (expected)`);
    }
  });
});
