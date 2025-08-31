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
    const result = await Services.startHeartbeatService(udid);
    heartbeatServiceWithConnection = result;
  });

  afterEach(async function () {
    if (heartbeatServiceWithConnection?.heartbeatService?.isRunning()) {
      await heartbeatServiceWithConnection.heartbeatService.stop();
    }
    if (heartbeatServiceWithConnection?.remoteXPC) {
      await heartbeatServiceWithConnection.remoteXPC.close();
    }
  });

  it('should start heartbeat service as keep-alive mechanism', async function () {
    this.timeout(15000);

    // Test that the service can start (this doesn't block, just establishes connection)
    await heartbeatServiceWithConnection.heartbeatService.start();
    expect(heartbeatServiceWithConnection.heartbeatService.isRunning()).to.be
      .true;

    log.info('✅ HeartbeatService started successfully as keep-alive mechanism');
  });

  it('should send Polo response manually', async function () {
    this.timeout(10000);

    // Start service if not running
    if (!heartbeatServiceWithConnection.heartbeatService.isRunning()) {
      await heartbeatServiceWithConnection.heartbeatService.start();
    }

    // Test manual Polo sending (this is what gets called in the recv->send loop)
    await heartbeatServiceWithConnection.heartbeatService.sendPolo();
    log.info('✅ Successfully sent Polo response');
  });

  it('should manage service lifecycle correctly', async function () {
    this.timeout(15000);

    // Test complete lifecycle
    expect(heartbeatServiceWithConnection.heartbeatService.isRunning()).to.be
      .false;

    await heartbeatServiceWithConnection.heartbeatService.start();
    expect(heartbeatServiceWithConnection.heartbeatService.isRunning()).to.be
      .true;

    await heartbeatServiceWithConnection.heartbeatService.stop();
    expect(heartbeatServiceWithConnection.heartbeatService.isRunning()).to.be
      .false;

    log.info('✅ Service lifecycle works correctly');
  });
});
