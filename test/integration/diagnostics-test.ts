import { expect } from 'chai';
import type { TunnelConnection } from 'tuntap-bridge';

import DiagnosticsService from '../../src/Services/IOS/DiagnosticService/index.js';
import { startCoreDeviceProxy } from '../../src/Services/IOS/TunnelService/index.js';
import { createLockdownServiceByUDID } from '../../src/lib/Lockdown/index.js';
import RemoteXpcConnection from '../../src/lib/RemoteXPC/remote-xpc-connection.js';
import TunnelManager from '../../src/lib/Tunnel/index.js';

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
