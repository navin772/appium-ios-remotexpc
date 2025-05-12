import { expect } from 'chai';
import type { TunnelConnection } from 'tuntap-bridge';

import { createLockdownServiceByUDID } from '../../src/lib/lockdown/index.js';
import RemoteXpcConnection from '../../src/lib/remote-xpc/remote-xpc-connection.js';
import TunnelManager from '../../src/lib/tunnel/index.js';
import DiagnosticsService from '../../src/services/ios/diagnostic-service/index.js';
import { startCoreDeviceProxy } from '../../src/services/ios/tunnel-service/index.js';

describe('Diagnostics Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  const tunManager = TunnelManager;
  let tunnelResult: TunnelConnection;
  let remoteXPC: RemoteXpcConnection;
  let diagService: DiagnosticsService;
  const udid = process.env.UDID || '';

  before(async function () {
    console.log('Creating connection...');
    const { lockdownService, device } = await createLockdownServiceByUDID(udid);
    const { socket } = await startCoreDeviceProxy(
      lockdownService,
      device.DeviceID,
      udid,
      {},
    );

    tunnelResult = await tunManager.getTunnel(socket);
    const rsdPort = tunnelResult.RsdPort ?? 0;

    remoteXPC = new RemoteXpcConnection([tunnelResult.Address, rsdPort]);
    await remoteXPC.connect();
    remoteXPC.listAllServices();

    const diagnosticsService = remoteXPC.findService(
      DiagnosticsService.RSD_SERVICE_NAME,
    );

    diagService = new DiagnosticsService([
      tunnelResult.Address,
      parseInt(diagnosticsService.port),
    ]);
  });

  after(async function () {
    if (diagService) {
      await diagService.shutdown();
    }
    if (tunManager) {
      await tunManager.closeTunnel();
    }
  });

  it('should query power information', async function () {
    console.log('Querying power information...');
    const powerInfo = await diagService.ioregistry({
      ioClass: 'IOPMPowerSource',
    });
    console.log('Power Information:');
    console.log(powerInfo);

    expect(powerInfo).to.be.an('array');
    expect(powerInfo.length).to.be.greaterThan(0);
  });

  it('should query wifi information', async function () {
    console.log('Querying wifi information...');
    const wifiInfo = await diagService.ioregistry({
      name: 'AppleBCMWLANSkywalkInterface',
    });
    console.log('WiFi Information:');
    console.log(wifiInfo);

    expect(wifiInfo).to.be.an('array');
  });
});
