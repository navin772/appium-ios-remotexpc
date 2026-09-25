import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as net from 'node:net';
import {describe, it} from 'node:test';

import {Http2Constants} from '../../../src/lib/remote-xpc/constants.js';
import {RemoteXpcFramedTransport} from '../../../src/lib/remote-xpc/remote-xpc-framed-transport.js';
import type {XPCDictionary, XPCValue} from '../../../src/lib/types.js';
import {
  type CoreDeviceInvokeOptions,
  CoreDeviceService,
} from '../../../src/services/ios/core-device/core-device-service.js';
import {buildMessage, buildUndecodableMessage} from '../remote-xpc/xpc-fixtures.js';

const FEATURE = 'com.apple.coredevice.feature.test';

function buildReply(output: XPCValue = {ok: true}): Buffer {
  return buildMessage({'CoreDevice.output': output} as XPCDictionary, 2);
}

/**
 * Feeds a scripted byte stream back through the transport's own reassembly path
 * whenever the service sends a request, standing in for the device's reply.
 */
class ScriptedCoreDeviceService extends CoreDeviceService {
  constructor(private readonly reply: Buffer) {
    super('test-udid', 'com.apple.coredevice.test');
  }

  async invokeFeature(timeoutMs: number): Promise<XPCValue> {
    return this.invoke(FEATURE, {}, {timeoutMs});
  }

  protected async createTransport(): Promise<RemoteXpcFramedTransport> {
    const transport = new RemoteXpcFramedTransport(['::1', 1]);
    const ingest = (
      transport as unknown as {ingestXpcData: (streamId: number, chunk: Buffer) => void}
    ).ingestXpcData.bind(transport, Http2Constants.ROOT_CHANNEL);
    transport.sendDataFrame = (): void => {
      setImmediate(() => ingest(this.reply));
    };
    return transport;
  }
}

/** Points the real createTransport() at a socket that completes the write-only handshake. */
class LoopbackCoreDeviceService extends CoreDeviceService {
  constructor(private readonly port: number) {
    super('test-udid', 'com.apple.coredevice.test');
  }

  async openTransport(): Promise<RemoteXpcFramedTransport> {
    return this.createTransport();
  }

  protected async resolveServiceAddress(): Promise<[string, number]> {
    return ['::1', this.port];
  }
}

describe('CoreDeviceService transport wiring', function () {
  it('attaches failure listeners to the transport it creates', async function () {
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => accepted.push(socket));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', () => resolve((server.address() as net.AddressInfo).port));
    });

    const service = new LoopbackCoreDeviceService(port);
    let transport: RemoteXpcFramedTransport | undefined;
    try {
      transport = await service.openTransport();

      assert.ok(transport.listenerCount('error') > 0, "an unlistened 'error' crashes the process");
      assert.ok(transport.listenerCount('decodeError') > 0);
    } finally {
      await transport?.close();
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resolves the invocation when an undecodable message precedes the reply', async function () {
    const service = new ScriptedCoreDeviceService(Buffer.concat([buildUndecodableMessage(1), buildReply()]));

    try {
      assert.deepStrictEqual(await service.invokeFeature(2000), {ok: true});
    } finally {
      await service.close();
    }
  });

  it('names the undecodable message as the cause when the reply never decodes', async function () {
    const service = new ScriptedCoreDeviceService(buildUndecodableMessage(1));

    try {
      await assert.rejects(
        service.invokeFeature(300),
        /timed out after 300ms; last message was undecodable: Unsupported xpc type/,
      );
    } finally {
      await service.close();
    }
  });

  it('reports a plain timeout when no message arrived at all', async function () {
    const service = new ScriptedCoreDeviceService(Buffer.alloc(0));

    try {
      await assert.rejects(service.invokeFeature(300), /timed out after 300ms$/);
    } finally {
      await service.close();
    }
  });
});

/**
 * Stands in for the device end of a request with file transfers, recording the order in which
 * the request and its payloads go out.
 * - `replyAfterTransfers`: replies once both payloads are in.
 * - `replyEarly`: replies to the request itself; the payload pushes never finish.
 * - `closeDuringTransfer`: the connection drops mid-push, as the real transport reports it.
 */
class FileTransferTransport extends EventEmitter {
  isConnected = true;
  readonly events: string[] = [];

  constructor(private readonly mode: 'replyAfterTransfers' | 'replyEarly' | 'closeDuringTransfer') {
    super();
  }

  sendDataFrame(): void {
    this.events.push('request');
    if (this.mode === 'replyEarly') {
      queueMicrotask(() => this.emit('message', {early: true}));
    }
  }

  async sendFileTransfer(transferId: number, data: Buffer): Promise<void> {
    this.events.push(`transfer ${transferId}: ${data.toString()}`);
    if (this.mode === 'replyEarly') {
      await new Promise<void>(() => undefined);
    }
    if (this.mode === 'closeDuringTransfer') {
      this.emit('close');
      throw new Error(`RemoteXPC connection closed before file transfer stream 5 was sent`);
    }
    if (transferId === 2) {
      queueMicrotask(() => this.emit('message', {installed: true}));
    }
  }

  async close(): Promise<void> {}
}

class FileTransferCoreDeviceService extends CoreDeviceService {
  constructor(private readonly fake: FileTransferTransport) {
    super('test-udid', 'com.apple.coredevice.test');
  }

  async request(options: CoreDeviceInvokeOptions): Promise<XPCDictionary> {
    return this.sendReceive({routine: 'install'}, options);
  }

  protected async createTransport(): Promise<RemoteXpcFramedTransport> {
    return this.fake as unknown as RemoteXpcFramedTransport;
  }
}

describe('CoreDeviceService file transfers', function () {
  const fileTransfers = new Map([
    [1, Buffer.from('image')],
    [2, Buffer.from('ticket')],
  ]);

  it('pushes each payload after the request, in order, and returns the reply', async function () {
    const fake = new FileTransferTransport('replyAfterTransfers');
    const service = new FileTransferCoreDeviceService(fake);

    assert.deepStrictEqual(await service.request({fileTransfers, timeoutMs: 2000}), {installed: true});
    assert.deepStrictEqual(fake.events, ['request', 'transfer 1: image', 'transfer 2: ticket']);
  });

  it('returns a reply that arrives before the payloads are out', async function () {
    const service = new FileTransferCoreDeviceService(new FileTransferTransport('replyEarly'));

    assert.deepStrictEqual(await service.request({fileTransfers, timeoutMs: 2000}), {early: true});
  });

  it('fails at once, not at the timeout, when the connection drops during a push', async function () {
    const service = new FileTransferCoreDeviceService(new FileTransferTransport('closeDuringTransfer'));
    const start = performance.now();

    await assert.rejects(service.request({fileTransfers, timeoutMs: 60_000}), /connection closed/);
    assert.ok(performance.now() - start < 1000);
  });
});
