import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {after, before, describe, it} from 'node:test';

import {XpcConstants} from '../../src/lib/remote-xpc/constants.js';
import type {RemoteXpcFramedTransport} from '../../src/lib/remote-xpc/remote-xpc-framed-transport.js';
import {XPCFileTransfer} from '../../src/lib/remote-xpc/xpc-file-transfer.js';
import {encodeMessage} from '../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary} from '../../src/lib/types.js';
import {CoreDeviceService} from '../../src/services/ios/core-device/core-device-service.js';
import {requireDeviceUdid} from './helpers/device.js';

const CRYPTEXD_SERVICE_NAME = 'com.apple.security.cryptexd.remote';
const REPLY_TIMEOUT_MS = 30_000;

/** Exposes a raw connection to cryptexd: `install` needs the request and its payload streams on one connection. */
class CryptexdConnection extends CoreDeviceService {
  constructor(udid: string) {
    super(udid, CRYPTEXD_SERVICE_NAME);
  }

  async open(): Promise<RemoteXpcFramedTransport> {
    return await this.createTransport();
  }
}

function nextReply(transport: RemoteXpcFramedTransport): Promise<XPCDictionary> {
  return new Promise<XPCDictionary>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply within ${REPLY_TIMEOUT_MS}ms`)), REPLY_TIMEOUT_MS);
    transport.on('message', (body: XPCDictionary) => {
      if (Object.keys(body).length > 0) {
        clearTimeout(timer);
        resolve(body);
      }
    });
    transport.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Drives outbound XPC file transfers against a real consumer: a cryptexd `install`
 * with a bogus ticket. cryptexd only evaluates the ticket once it has read every
 * announced payload, so an image4 trust failure (rather than a timeout or a
 * GOAWAY/RST_STREAM) proves the streams were delivered. Nothing gets installed.
 */
describe('RemoteXPC outbound file transfer (cryptexd)', {timeout: 60000}, function () {
  let transport: RemoteXpcFramedTransport | null = null;

  before(async function () {
    transport = await new CryptexdConnection(requireDeviceUdid()).open();
  });

  after(async function () {
    await transport?.close();
  });

  it('delivers several payloads, one larger than the initial window, to a single request', async function () {
    const payloads: [string, Buffer][] = [
      ['image', randomBytes(4 * 1024 * 1024)],
      ['trustcache', randomBytes(2048)],
      ['im4m', randomBytes(4096)],
      ['info', Buffer.from('<plist version="1.0"><dict/></plist>')],
      ['volumehash', randomBytes(48)],
    ];
    const argv: XPCDictionary = {
      auth: 0n,
      'client-version': 3n,
      'cryptex1-properties': {
        'Cryptex1,UseProductClass': true,
        MountedCryptex: false,
        'Cryptex1,SubType': 2n,
        'Cryptex1,NonceDomain': 4n,
        'Cryptex1,Version': '39.999.999.0.0,0',
        'Cryptex1,PreauthVersion': '39.999.999.0.0,0',
      },
      'image-type-index': 10,
      'nonce-persistence': 1n,
      persistence: 2n,
    };
    payloads.forEach(([key, data], i) => {
      argv[key] = new XPCFileTransfer(i + 1, data.length);
    });

    const reply = nextReply(transport!);
    transport!.sendDataFrame(
      encodeMessage({
        flags:
          XpcConstants.XPC_FLAGS_ALWAYS_SET |
          XpcConstants.XPC_FLAGS_DATA_PRESENT |
          XpcConstants.XPC_FLAGS_WANTING_REPLY,
        id: 1n,
        body: {routine: 'install', argv},
      }),
    );
    for (const [i, [, data]] of payloads.entries()) {
      await transport!.sendFileTransfer(i + 1, data);
    }

    const cferr = (await reply).cferr as XPCDictionary | undefined;
    assert.ok(cferr, 'expected cryptexd to reject the bogus ticket');
    assert.match(JSON.stringify(cferr), /image4 trust evaluation failed/);
    assert.equal(transport!.isConnected, true, 'finished transfer streams must not fail the connection');
  });
});
