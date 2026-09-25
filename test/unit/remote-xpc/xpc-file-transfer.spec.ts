import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {XPCFileTransfer} from '../../../src/lib/remote-xpc/xpc-file-transfer.js';
import {decodeMessage, encodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';

const WRAPPER_AND_BODY_HEADER_SIZE = 24 + 8;
const DICTIONARY_TYPE = 0x0000f000;
const UINT64_TYPE = 0x00004000;
const FILE_TRANSFER_TYPE = 0x0001a000;

/** Bytes of the root dictionary's single value, after its 4-byte-padded key. */
function encodedValue(key: string, value: XPCFileTransfer): Buffer {
  const message = encodeMessage({flags: 1, id: 0n, body: {[key]: value}});
  const keyLength = Math.ceil((key.length + 1) / 4) * 4;
  // Root dictionary: type, payload length, entry count, then the key.
  return message.subarray(WRAPPER_AND_BODY_HEADER_SIZE + 12 + keyLength);
}

describe('XPCFileTransfer', function () {
  it('encodes as a fileTransfer object carrying the transfer id and a {s: uint64 size} dictionary', function () {
    const value = encodedValue('image', new XPCFileTransfer(3, 1234));

    const expected = Buffer.alloc(40);
    expected.writeUInt32LE(FILE_TRANSFER_TYPE, 0);
    expected.writeBigUInt64LE(3n, 4);
    expected.writeUInt32LE(DICTIONARY_TYPE, 12);
    expected.writeUInt32LE(20, 16); // entry count + "s\0" padded + uint64 type + value
    expected.writeUInt32LE(1, 20);
    expected.write('s', 24, 'ascii'); // "s\0\0\0"
    expected.writeUInt32LE(UINT64_TYPE, 28);
    expected.writeBigUInt64LE(1234n, 32);
    assert.deepEqual(value, expected);
  });

  it('keeps the rest of the message decodable around it', function () {
    const message = encodeMessage({
      flags: 1,
      id: 0n,
      body: {routine: 'install', argv: {'client-version': 3n}},
    });
    const withTransfer = encodeMessage({
      flags: 1,
      id: 0n,
      body: {routine: 'install', argv: {'client-version': 3n, image: new XPCFileTransfer(1, 10)}},
    });
    assert.ok(withTransfer.length > message.length);
    assert.deepEqual(decodeMessage(message).message.body, {routine: 'install', argv: {'client-version': 3}});
  });

  it('rejects transfer id 0, which makes the device drop the connection', function () {
    assert.throws(() => new XPCFileTransfer(0, 10), /transfer id/i);
  });

  it('rejects a negative or fractional size', function () {
    assert.throws(() => new XPCFileTransfer(1, -1), /size/i);
    assert.throws(() => new XPCFileTransfer(1, 1.5), /size/i);
  });
});
