import { logger } from '@appium/support';
import { expect } from 'chai';

import type { HeartbeatServiceWithConnection } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('HeartbeatService.test');

describe('HeartbeatService', function () {
  let udid: string;
  let heartbeatServiceWithConnection: HeartbeatServiceWithConnection;

  before(function () {
    udid = process.env.UDID || '';
    if (!udid) {
      throw new Error(
        'UDID is required for integration tests. Set UDID environment variable.',
      );
    }
  });

  beforeEach(async function () {
    this.timeout(30000);
    const result = await Services.startHeartbeatService(udid);
    heartbeatServiceWithConnection = result;
  });

  afterEach(async function () {
    if (heartbeatServiceWithConnection?.remoteXPC) {
      await heartbeatServiceWithConnection.remoteXPC.close();
    }
  });

  it('should establish heartbeat connection', async function () {
    this.timeout(15000);

    // Test that the service can establish connection
    const connection =
      await heartbeatServiceWithConnection.heartbeatService.connectToHeartbeatService();
    expect(connection).to.be.an('object');

    log.info('✅ HeartbeatService connection established successfully');
  });

  it('should handle heartbeat start with short timeout (no iOS messages expected)', async function () {
    this.timeout(15000);

    // Test heartbeat service behavior when iOS doesn't send messages
    // This simulates normal operation where iOS doesn't need heartbeats
    const startTime = Date.now();

    try {
      // Start heartbeat with 2 second interval, but expect it to timeout
      // since iOS won't send heartbeat messages during normal operation
      await heartbeatServiceWithConnection.heartbeatService.start(2);

      // If we get here, it means iOS did send messages (unexpected in normal operation)
      const duration = (Date.now() - startTime) / 1000;
      log.info(
        `✅ HeartbeatService received messages and ran for ${duration.toFixed(1)} seconds`,
      );
    } catch (error) {
      // This is expected - iOS doesn't send heartbeat messages during normal operation
      // The service times out waiting for messages, which is the correct behavior
      const duration = (Date.now() - startTime) / 1000;

      expect((error as Error).message).to.include(
        'Timed out waiting for plist response',
      );
      expect(duration).to.be.greaterThan(9); // Should timeout after ~10 seconds

      log.info(
        '✅ HeartbeatService correctly timed out waiting for iOS messages (expected behavior)',
      );
      log.info(
        'This confirms the service is working - it waits for iOS heartbeat requests during critical operations',
      );
    }
  });
});
