import { expect } from 'chai';
import { Server, Socket } from 'net';

import { Usbmux } from '../../../src/lib/Usbmux/index.js';
import { UDID, fixtures, getServerWithFixtures } from '../fixtures/index.js';

let chai;
let chaiAsPromised;

before(async function () {
  chai = await import('chai');
  chaiAsPromised = await import('chai-as-promised');
  chai.use(chaiAsPromised.default);
  chai.should();
});

describe('usbmux', function () {
  let usbmux: Usbmux | null;
  let server: Server | null;
  let socket: Socket | null;

  beforeEach(function () {
    usbmux = null;
    server = null;
    socket = null;
  });

  afterEach(async function () {
    if (usbmux) {
      usbmux.close();
      usbmux = null;
    }

    // Add a small delay to avoid connection reset errors
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (server) {
      server.close();
      server = null;
    }

    socket = null;
  });

  it('should read usbmux message', async function () {
    ({ server, socket } = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);
    const devices = await usbmux.listDevices();
    expect(devices.length).to.equal(1);
  });

  it('should fail due to timeout', async function () {
    ({ server, socket } = await getServerWithFixtures());
    usbmux = new Usbmux(socket);

    await usbmux.listDevices(-1).should.eventually.be.rejected;
  });

  it('should find correct device', async function () {
    ({ server, socket } = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);

    const device = await usbmux.findDevice(UDID);
    device.Properties.SerialNumber.should.be.equal(UDID);
  });

  it.skip('should connect to correct device', async function () {
    ({ server, socket } = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);
    await usbmux.connect(UDID, 62078);
    // const socket: Socket = await connectAndRelay(UDID, 62078);
    // console.log('Socket connected, creating LockdownService');

    // const service = new LockdownService(socket, UDID, true);
  });
});
