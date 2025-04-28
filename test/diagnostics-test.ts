import type { TunnelConnection } from 'tuntap-bridge';

import DiagnosticsService from '../src/services/ios/diagnostic-service/index.js';
import { startCoreDeviceProxy } from '../src/services/ios/tunnel-service/index.js';
import { createLockdownServiceByUDID } from '../src/lib/lockdown/index.js';
import RemoteXpcConnection from '../src/lib/remote-xpc/remote-xpc-connection.js';
import TunnelManager from '../src/lib/tunnel/index.js';

async function test() {
  const tunManager = TunnelManager;
  let tunnelResult: TunnelConnection;
  console.log('create connection....');
  const { lockdownService, device } = await createLockdownServiceByUDID();
  const { socket } = await startCoreDeviceProxy(
    lockdownService,
    device.DeviceID,
    device.Properties.SerialNumber,
    {},
  );
  try {
    tunnelResult = await tunManager.getTunnel(socket);
    // console.log(tunnelResult)

    // Fix: Check if RsdPort is defined and provide a fallback value if it's undefined
    const rsdPort = tunnelResult.RsdPort ?? 0; // Using nullish coalescing operator

    const remoteXPC = new RemoteXpcConnection([tunnelResult.Address, rsdPort]);
    await remoteXPC.connect();
    remoteXPC.listAllServices();
    // console.log(remoteXPC.getServices())

    // Find the diagnostics service
    const diagnosticsService = remoteXPC.findService(
      DiagnosticsService.RSD_SERVICE_NAME,
    );

    // Create diagnostics service with the address and port
    const diagService = new DiagnosticsService([
      tunnelResult.Address,
      parseInt(diagnosticsService.port),
    ]);

    // Query some basic device information
    console.log('Querying device information...');
    const powerInfo = await diagService.ioregistry({
      ioClass: 'IOPMPowerSource',
    });
    console.log('Device Information:');
    console.log(powerInfo);
    const wifiInfo = await diagService.ioregistry({
      name: 'AppleBCMWLANSkywalkInterface',
    });
    console.log('wifiInfo Information:');
    console.log(wifiInfo);
    await tunManager.closeTunnel();
  } catch (err) {
    console.error('Failed to establish tunnel:', err);
  }
}

test();
