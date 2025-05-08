import { expect } from 'chai';
import type { TunnelConnection } from 'tuntap-bridge';

import { createLockdownServiceByUDID } from '../../src/lib/lockdown/index.js';
import RemoteXpcConnection from '../../src/lib/remote-xpc/remote-xpc-connection.js';
import TunnelManager from '../../src/lib/tunnel/index.js';
import SyslogService from '../../src/services/ios/syslog-service/index.js';
import { startCoreDeviceProxy } from '../../src/services/ios/tunnel-service/index.js';

describe('Tunnel and Syslog Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  const tunManager = TunnelManager;
  let tunnelResult: TunnelConnection;
  let remoteXPC: RemoteXpcConnection;
  let syslogService: SyslogService;
  let service: any;
  const udid = '00008110-001854423C3A801E';
  before(async function () {
    console.log('Creating connection...');
    const { lockdownService, device } = await createLockdownServiceByUDID(udid);
    const { socket } = await startCoreDeviceProxy(
      lockdownService,
      device.DeviceID,
      device.Properties.SerialNumber,
      {},
    );

    tunnelResult = await tunManager.getTunnel(socket);

    // Fix: Check if RsdPort is defined and provide a fallback value if it's undefined
    const rsdPort = tunnelResult.RsdPort ?? 0; // Using nullish coalescing operator

    remoteXPC = new RemoteXpcConnection([tunnelResult.Address, rsdPort]);
    await remoteXPC.connect();

    // Initialize syslog service
    syslogService = new SyslogService([tunnelResult.Address, rsdPort]);
  });

  after(async function () {
    if (tunManager) {
      await tunManager.closeTunnel();
    }
  });

  it('should list all services', function () {
    remoteXPC.listAllServices();
    const services = remoteXPC.getServices();
    expect(services).to.be.an('array');
  });

  it('should find os_trace_relay service', function () {
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;
  });

  it('should start syslog service', async function () {
    try {
      await syslogService.start(service, -1, tunnelResult.tunnelManager);
      // If no error is thrown, the test passes
      expect(true).to.be.true;
    } catch (err) {
      console.error('Failed to start syslog service:', err);
      throw err;
    }
  });
});
