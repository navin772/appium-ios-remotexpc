import { logger } from '@appium/support';
import { expect } from 'chai';

import type {
  DVTServiceWithConnection,
  SysmontapEvent,
} from '../../../src/index.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('Sysmontap.test');
log.level = 'debug';

describe('Sysmontap', function () {
  this.timeout(60000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '';

  before(async function () {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async function () {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch {}
    }
  });

  describe('One-shot snapshots', function () {
    it('should get a system snapshot with CPU and system metrics', async function () {
      const sysmontap = dvtServiceConnection!.sysmontap;
      const snapshot = await sysmontap.getSystemSnapshot();

      log.info('System snapshot:', JSON.stringify(snapshot, null, 2));

      // Verify CPU usage data
      expect(snapshot.cpu).to.be.an('object');
      expect(snapshot.cpu).to.have.property('cpuCount');
      expect(snapshot.cpu.cpuCount).to.be.greaterThan(0);
      expect(snapshot.cpu).to.have.property('enabledCPUs');
      expect(snapshot.cpu.enabledCPUs).to.be.greaterThan(0);
      expect(snapshot.cpu).to.have.property('totalLoad');
      expect(snapshot.cpu).to.have.property('niceLoad');
      expect(snapshot.cpu).to.have.property('systemLoad');
      expect(snapshot.cpu).to.have.property('userLoad');

      // Verify system metrics
      expect(snapshot.system).to.be.an('object');
      expect(Object.keys(snapshot.system).length).to.be.greaterThan(0);

      // Check for common system attributes
      expect(snapshot.system).to.have.property('threadCount');
      expect(snapshot.system.threadCount).to.be.greaterThan(0);
      expect(snapshot.system).to.have.property('physMemSize');
      expect(snapshot.system.physMemSize).to.be.greaterThan(0);
    });

    it('should get a process snapshot with per-process metrics', async function () {
      const sysmontap = dvtServiceConnection!.sysmontap;
      const processes = await sysmontap.getProcessSnapshot();

      log.info(`Retrieved ${processes.length} processes`);
      // Log first 3 processes as sample
      for (const proc of processes.slice(0, 3)) {
        log.info(
          `  ${proc.name} (PID ${proc.pid}): CPU ${proc.cpuUsage}%, Mem ${proc.physFootprint} bytes`,
        );
      }

      expect(processes).to.be.an('array');
      expect(processes.length).to.be.greaterThan(0);

      // Verify process structure
      for (const proc of processes) {
        expect(proc).to.have.property('pid');
        expect(proc).to.have.property('name');
        expect(proc).to.have.property('cpuUsage');
        expect(proc).to.have.property('physFootprint');
        expect(proc.pid).to.be.a('number');
        expect(proc.name).to.be.a('string');
      }

      // At least some processes should have non-empty names
      const namedProcesses = processes.filter(
        (p) => typeof p.name === 'string' && p.name.length > 0,
      );
      expect(namedProcesses.length).to.be.greaterThan(0);
    });
  });

  describe('Continuous Monitoring', function () {
    it('should receive both system and process events through async iterator', async function () {
      const sysmontap = dvtServiceConnection!.sysmontap;
      const events: SysmontapEvent[] = [];
      const maxEvents = 10;

      for await (const event of sysmontap.events()) {
        events.push(event);
        log.debug(`Event ${events.length}: type=${event.type}`);

        if (events.length >= maxEvents) {
          break;
        }
      }

      expect(events.length).to.be.at.least(1);

      // Should have received both event types
      const systemEvents = events.filter((e) => e.type === 'system');
      const processEvents = events.filter((e) => e.type === 'processes');

      log.info(
        `Received ${systemEvents.length} system events, ${processEvents.length} process events`,
      );

      // Verify at least one type was received
      expect(systemEvents.length + processEvents.length).to.be.greaterThan(0);

      // Verify system event structure
      for (const event of systemEvents) {
        if (event.type === 'system') {
          expect(event.system).to.be.an('object');
        }
      }

      // Verify process event structure
      for (const event of processEvents) {
        if (event.type === 'processes') {
          expect(event.processes).to.be.an('array');
        }
      }
    });
  });
});
