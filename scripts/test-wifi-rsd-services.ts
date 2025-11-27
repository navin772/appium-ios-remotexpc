#!/usr/bin/env tsx
/**
 * Test RSD services over WiFi tunnel
 * 
 * Usage:
 *   sudo tsx scripts/test-wifi-rsd-services.ts <rsd-address> <rsd-port>
 * 
 * Example:
 *   sudo tsx scripts/test-wifi-rsd-services.ts fd14:974d:66b2::1 49174
 */
import { logger } from '@appium/support';

import { RemoteXpcConnection } from '../src/lib/remote-xpc/remote-xpc-connection.js';
import { DVTSecureSocketProxyService } from '../src/services/ios/dvt/index.js';
import { LocationSimulation } from '../src/services/ios/dvt/instruments/location-simulation.js';

const log = logger.getLogger('WiFiRSDTest');

/**
 * First test: Just connect to RSD and list services
 */
async function testRsdConnection(
  rsdAddress: string,
  rsdPort: number,
): Promise<boolean> {
  log.info('=== Testing RSD Connection over WiFi ===');
  log.info(`RSD Address: ${rsdAddress}`);
  log.info(`RSD Port: ${rsdPort}`);
  log.info('');

  try {
    log.info('Connecting to RSD...');
    const conn = new RemoteXpcConnection([rsdAddress, rsdPort]);
    const result = await conn.connect();
    
    log.info('✅ RSD connection successful!');
    log.info('');
    log.info('Available services:');
    for (const service of result.services) {
      log.info(`   - ${service.serviceName}: port ${service.port}`);
    }
    log.info('');
    
    await conn.close();
    return true;
  } catch (error) {
    log.error(`RSD connection failed: ${error}`);
    return false;
  }
}


async function testLocationSimulationDirect(
  rsdAddress: string,
  dvtPort: number,
): Promise<void> {
  log.info('=== Testing Location Simulation (Direct DVT Port) ===');
  log.info(`DVT Address: ${rsdAddress}:${dvtPort}`);
  log.info('');

  try {
    log.info('Connecting to DTServiceHub...');
    const dvt = new DVTSecureSocketProxyService([rsdAddress, dvtPort]);
    
    // Connect directly to the DVT port
    await dvt.connect();
    log.info('✅ DVT service connected!');

    // Create location simulation service
    log.info('');
    log.info('Creating Location Simulation service...');
    const locationSim = new LocationSimulation(dvt);
    await locationSim.initialize();
    log.info('✅ Location Simulation service ready!');

    // Test location: Apple Park, Cupertino
    const testLat = 37.3349;
    const testLon = -122.0090;

    log.info('');
    log.info(`Setting simulated location to Apple Park:`);
    log.info(`   Latitude:  ${testLat}`);
    log.info(`   Longitude: ${testLon}`);

    await locationSim.setLocation(testLat, testLon);

    log.info('');
    log.info('🎉 SUCCESS! Location simulation working over WiFi!');
    log.info('');
    log.info('📱 Check your device - open Maps app to verify');
    log.info('   The device should show location at Apple Park, Cupertino');
    log.info('');

    // Wait a few seconds then clear
    log.info('Location will be cleared in 10 seconds...');
    await new Promise((resolve) => setTimeout(resolve, 10000));

    log.info('Clearing simulated location...');
    await locationSim.clear();
    log.info('✅ Location cleared');

    // Close connection
    await dvt.close();
    log.info('DVT connection closed');
  } catch (error) {
    log.error(`Failed: ${error}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    log.error('Usage: sudo tsx scripts/test-wifi-rsd-services.ts <rsd-address> <rsd-port>');
    log.error('Example: sudo tsx scripts/test-wifi-rsd-services.ts fd14:974d:66b2::1 49174');
    process.exit(1);
  }

  const rsdAddress = args[0];
  const rsdPort = parseInt(args[1], 10);

  // First test basic RSD connection and get DVT port
  log.info('=== Testing RSD Connection over WiFi ===');
  log.info(`RSD Address: ${rsdAddress}`);
  log.info(`RSD Port: ${rsdPort}`);
  log.info('');

  let dvtPort: number | null = null;

  try {
    log.info('Connecting to RSD...');
    const conn = new RemoteXpcConnection([rsdAddress, rsdPort]);
    const result = await conn.connect();
    
    log.info('✅ RSD connection successful!');
    log.info(`Found ${result.services.length} services`);
    
    // Find DVT service port
    const dvtService = result.services.find(
      (s) => s.serviceName === 'com.apple.instruments.dtservicehub'
    );
    
    if (dvtService) {
      dvtPort = parseInt(dvtService.port, 10);
      log.info(`DVT service found on port: ${dvtPort}`);
    } else {
      log.error('DVT service not found in RSD services');
    }
    
    await conn.close();
  } catch (error) {
    log.error(`RSD connection failed: ${error}`);
    process.exit(1);
  }

  if (dvtPort) {
    log.info('');
    // Test location simulation using direct DVT port
    await testLocationSimulationDirect(rsdAddress, dvtPort);
  }
}

main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});

