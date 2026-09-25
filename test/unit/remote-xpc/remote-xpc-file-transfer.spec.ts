import assert from 'node:assert/strict';
import * as net from 'node:net';
import {describe, it} from 'node:test';

import {Http2Constants, XpcConstants} from '../../../src/lib/remote-xpc/constants.js';
import {WindowUpdateFrame} from '../../../src/lib/remote-xpc/handshake-frames.js';
import {RemoteXpcFramedTransport} from '../../../src/lib/remote-xpc/remote-xpc-framed-transport.js';
import {decodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import {toRstStreamFrame} from './xpc-fixtures.js';

const FRAME_TYPE_DATA = 0x00;
const FRAME_TYPE_HEADERS = 0x01;
const FLAG_END_STREAM = 0x01;
const FIRST_TRANSFER_STREAM = 5;

interface RawFrame {
  type: number;
  flags: number;
  streamId: number;
  body: Buffer;
}

interface PeerHarness {
  transport: RemoteXpcFramedTransport;
  peer: net.Socket;
  errors: Error[];
  /** Frames the transport sent on `streamId`, in order. */
  framesOn: (streamId: number) => RawFrame[];
}

function settle(ms = 100): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await settle(20);
  }
}

/** Connects a transport to a loopback peer that records every frame it receives. */
async function withPeer(run: (harness: PeerHarness) => Promise<void>): Promise<void> {
  const frames: RawFrame[] = [];
  let pending = Buffer.alloc(0);
  let prefaceLeft = Http2Constants.HTTP2_MAGIC.length;
  let onAccepted: (socket: net.Socket) => void = () => undefined;
  const accepted = new Promise<net.Socket>((resolve) => {
    onAccepted = resolve;
  });
  const server = net.createServer((socket): void => {
    socket.on('data', (chunk: Buffer) => {
      const skip = Math.min(prefaceLeft, chunk.length);
      prefaceLeft -= skip;
      pending = Buffer.concat([pending, chunk.subarray(skip)]);
      while (pending.length >= 9) {
        const length = pending.readUIntBE(0, 3);
        if (pending.length < 9 + length) {
          break;
        }
        frames.push({
          type: pending[3],
          flags: pending[4],
          streamId: pending.readUInt32BE(5) & 0x7fffffff,
          body: Buffer.from(pending.subarray(9, 9 + length)),
        });
        pending = pending.subarray(9 + length);
      }
    });
    onAccepted(socket);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', () => resolve((server.address() as net.AddressInfo).port));
  });
  const transport = new RemoteXpcFramedTransport(['::1', port]);
  const errors: Error[] = [];
  let peer: net.Socket | undefined;

  try {
    await transport.connect({timeoutMs: 2000});
    transport.on('error', (error: Error) => errors.push(error));
    peer = await accepted;
    await run({
      transport,
      peer,
      errors,
      framesOn: (streamId) => frames.filter((frame) => frame.streamId === streamId),
    });
  } finally {
    await transport.close();
    peer?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function dataFrames(frames: RawFrame[]): RawFrame[] {
  return frames.filter((frame) => frame.type === FRAME_TYPE_DATA);
}

/** DATA payload bytes on a transfer stream, without the preamble frame. */
function payloadBytes(frames: RawFrame[]): Buffer {
  return Buffer.concat(
    dataFrames(frames)
      .slice(1)
      .map((frame) => frame.body),
  );
}

function isEndStream(frame: RawFrame | undefined): boolean {
  return frame?.type === FRAME_TYPE_DATA && (frame.flags & FLAG_END_STREAM) !== 0;
}

function grantWindow(peer: net.Socket, streamId: number, increment: number): void {
  peer.write(
    Buffer.concat([
      new WindowUpdateFrame(0, increment).serialize(),
      new WindowUpdateFrame(streamId, increment).serialize(),
    ]),
  );
}

describe('RemoteXpcFramedTransport.sendFileTransfer', function () {
  it('opens an odd stream with HEADERS, a preamble tagged with the transfer id, the payload, then END_STREAM', async function () {
    await withPeer(async ({transport, framesOn}) => {
      const payload = Buffer.from('cryptex image bytes');

      await transport.sendFileTransfer(7, payload);
      await waitFor(() => isEndStream(framesOn(FIRST_TRANSFER_STREAM).at(-1)));

      const frames = framesOn(FIRST_TRANSFER_STREAM);
      assert.equal(frames[0].type, FRAME_TYPE_HEADERS);
      assert.ok(frames[0].flags & Http2Constants.FLAG_END_HEADERS, 'HEADERS must carry END_HEADERS');

      const preamble = decodeMessage(dataFrames(frames)[0].body).message;
      assert.equal(preamble.flags, XpcConstants.XPC_FLAGS_FILE_TX_STREAM_REQUEST | XpcConstants.XPC_FLAGS_ALWAYS_SET);
      assert.equal(BigInt(preamble.id ?? 0), 7n, 'the device correlates the stream by this message id');
      assert.equal(preamble.body, null);

      assert.deepEqual(payloadBytes(frames), payload);
      assert.equal(frames.at(-1)?.body.length, 0, 'END_STREAM goes on an empty DATA frame');
    });
  });

  it('gives every transfer its own odd stream', async function () {
    await withPeer(async ({transport, framesOn}) => {
      await transport.sendFileTransfer(1, Buffer.from('first'));
      await transport.sendFileTransfer(2, Buffer.from('second'));
      await waitFor(() => isEndStream(framesOn(FIRST_TRANSFER_STREAM + 2).at(-1)));

      assert.deepEqual(payloadBytes(framesOn(FIRST_TRANSFER_STREAM)), Buffer.from('first'));
      assert.deepEqual(payloadBytes(framesOn(FIRST_TRANSFER_STREAM + 2)), Buffer.from('second'));
    });
  });

  it('charges the preamble against the window and waits for WINDOW_UPDATE before finishing', async function () {
    await withPeer(async ({transport, peer, framesOn}) => {
      const payload = Buffer.alloc(Http2Constants.DEFAULT_PEER_WINDOW_SIZE, 0x5a);
      let finished = false;

      const sent = transport.sendFileTransfer(1, payload).then(() => {
        finished = true;
      });
      await settle();

      const streamBytes = dataFrames(framesOn(FIRST_TRANSFER_STREAM)).reduce(
        (total, frame) => total + frame.body.length,
        0,
      );
      assert.ok(
        streamBytes <= Http2Constants.DEFAULT_PEER_WINDOW_SIZE,
        `sent ${streamBytes} bytes into a ${Http2Constants.DEFAULT_PEER_WINDOW_SIZE}-byte stream window`,
      );
      assert.equal(finished, false, 'the transfer cannot finish before the peer grants more window');

      grantWindow(peer, FIRST_TRANSFER_STREAM, Http2Constants.DEFAULT_PEER_WINDOW_SIZE);
      await sent;
      await waitFor(() => isEndStream(framesOn(FIRST_TRANSFER_STREAM).at(-1)));

      assert.deepEqual(payloadBytes(framesOn(FIRST_TRANSFER_STREAM)), payload);
    });
  });

  it('ignores the RST_STREAM the device sends on a finished transfer stream', async function () {
    await withPeer(async ({transport, peer, errors}) => {
      await transport.sendFileTransfer(1, Buffer.from('done'));

      peer.write(toRstStreamFrame(FIRST_TRANSFER_STREAM, 0));
      await settle();

      assert.deepEqual(errors, []);
      assert.equal(transport.isConnected, true);
    });
  });

  it('still fails the connection on RST_STREAM for a transfer stream that has not finished', async function () {
    await withPeer(async ({transport, peer, errors}) => {
      const sent = transport.sendFileTransfer(1, Buffer.alloc(2 * Http2Constants.DEFAULT_PEER_WINDOW_SIZE));
      sent.catch((): void => undefined);
      await settle();

      peer.write(toRstStreamFrame(FIRST_TRANSFER_STREAM, 5));
      await waitFor(() => errors.length > 0);

      assert.match(errors[0].message, /RST_STREAM on stream 5/);
      await assert.rejects(sent);
    });
  });

  it('rejects when the connection closes before the payload is flushed', async function () {
    await withPeer(async ({transport}) => {
      const sent = transport.sendFileTransfer(1, Buffer.alloc(2 * Http2Constants.DEFAULT_PEER_WINDOW_SIZE));
      await settle();
      const rejected = assert.rejects(sent, /closed/i);

      await transport.close();

      await rejected;
    });
  });

  it('rejects transfer id 0', async function () {
    await withPeer(async ({transport}) => {
      await assert.rejects(transport.sendFileTransfer(0, Buffer.from('x')), /transfer id/i);
    });
  });
});
