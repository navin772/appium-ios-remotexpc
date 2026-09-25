import assert from 'node:assert/strict';
import {type TestContext, describe, it} from 'node:test';

import axios from 'axios';

import {createPlist, parsePlist} from '../../../src/lib/plist/index.js';
import {type Img4ChipInstance, TSSError, cryptex1Udid, getCryptex1TicketFromTSS} from '../../../src/lib/tss/index.js';
import type {PlistDictionary} from '../../../src/lib/types.js';

const NONCE = Buffer.alloc(48, 0xab);
const TICKET = Buffer.from('signed cryptex1 ticket');
const CHIP: Img4ChipInstance = {img4_chip_chip: 0x8140, img4_chip_ecid: 0x1e25d20111801c, img4_chip_cpro: 1};

function digest(fill: number): Buffer {
  return Buffer.alloc(48, fill);
}

/** Shaped like the cryptex identity in Xcode's DDI BuildManifest. */
function cryptexIdentity(): PlistDictionary {
  return {
    'Cryptex1,ChipID': '0xFF10',
    'Cryptex1,Type': 3,
    'Cryptex1,SubType': 2,
    'Cryptex1,ProductClass': '0xF2',
    'Cryptex1,UseProductClass': true,
    'Cryptex1,NonceDomain': 4,
    'Cryptex1,Version': '39.999.999.0.0,0',
    'Cryptex1,PreauthorizationVersion': '39.999.999.0.0,0',
    Manifest: {
      'Cryptex1,GenericDmg': {Digest: digest(1), Info: {Path: 'image.dmg', Personalize: false}},
      'Cryptex1,GenericTrustCache': {Digest: digest(2), Info: {Path: 'image.trustcache', Personalize: true}},
      'Cryptex1,CryptexInfoPlist': {Digest: digest(3), Trusted: true, Info: {Path: 'info', Personalize: true}},
      'Cryptex1,GenericVolume': {Digest: digest(4), Info: {Path: 'root_hash', Personalize: true}},
      LoadableTrustCache: {Digest: digest(5), Trusted: true, Info: {Path: 'other', Personalize: true}},
    },
  };
}

/** Replaces the POST to gs.apple.com, capturing the request and answering with `reply`. */
function stubTss(t: TestContext, reply: string): {requests: PlistDictionary[]; bodies: string[]} {
  const requests: PlistDictionary[] = [];
  const bodies: string[] = [];
  t.mock.method(axios, 'post', async (_url: string, data: string) => {
    bodies.push(data);
    requests.push(parsePlist(data) as PlistDictionary);
    return {status: 200, data: reply};
  });
  return {requests, bodies};
}

function success(response: PlistDictionary): string {
  return `STATUS=0&MESSAGE=SUCCESS&REQUEST_STRING=${createPlist(response)}`;
}

describe('getCryptex1TicketFromTSS', function () {
  it('sends the Cryptex1 request shape and returns the ticket', async function (t) {
    const {requests, bodies} = stubTss(t, success({'Cryptex1,Ticket': TICKET}));

    assert.deepEqual(await getCryptex1TicketFromTSS(cryptexIdentity(), CHIP, NONCE), TICKET);

    // The XML parser reads an empty <data/> back as null, so check that key on the wire.
    assert.ok(bodies[0].includes('<key>Cryptex1,UniqueTagList</key><data></data>'));
    const {'Cryptex1,UniqueTagList': _uniqueTagList, ...request} = requests[0];
    assert.match(String(request['@UUID']), /^[0-9A-F-]{36}$/);
    assert.deepEqual(request, {
      '@HostPlatformInfo': 'mac',
      '@VersionInfo': 'libauthinstall-1104.0.9',
      '@UUID': request['@UUID'],
      '@Cryptex1,Ticket': true,
      'Cryptex1,ChipID': 0xff10,
      'Cryptex1,Type': 3,
      'Cryptex1,SubType': 2,
      'Cryptex1,ProductClass': 0xf2,
      'Cryptex1,UseProductClass': true,
      'Cryptex1,NonceDomain': 4,
      'Cryptex1,Version': '39.999.999.0.0,0',
      'Cryptex1,PreauthorizationVersion': '39.999.999.0.0,0',
      'Cryptex1,Nonce': NONCE,
      'Cryptex1,ProductionMode': true,
      'Cryptex1,UDID': Buffer.from('0000000000008140001e25d20111801c', 'hex'),
      // Digest only; the non-personalized GenericDmg and non-Cryptex1 entries are left out.
      'Cryptex1,GenericTrustCache': {Digest: digest(2)},
      'Cryptex1,CryptexInfoPlist': {Digest: digest(3)},
      'Cryptex1,GenericVolume': {Digest: digest(4)},
    });
  });

  it('reports a TSS refusal', async function (t) {
    stubTss(t, 'STATUS=94&MESSAGE=An internal error occurred.');

    await assert.rejects(getCryptex1TicketFromTSS(cryptexIdentity(), CHIP, NONCE), {
      name: 'TSSError',
      message: /An internal error occurred/,
    });
  });

  it('rejects a build identity missing a Cryptex1 key before contacting TSS', async function (t) {
    const {requests} = stubTss(t, success({'Cryptex1,Ticket': TICKET}));
    const identity = cryptexIdentity();
    delete identity['Cryptex1,Version'];

    await assert.rejects(getCryptex1TicketFromTSS(identity, CHIP, NONCE), TSSError);
    assert.equal(requests.length, 0);
  });
});

describe('cryptex1Udid', function () {
  it('packs the chip id and an ECID beyond the safe-integer range as big-endian uint64s', function () {
    const udid = cryptex1Udid({img4_chip_chip: 0x8150, img4_chip_ecid: 0x0123456789abcdefn, img4_chip_cpro: 1});

    assert.equal(udid.toString('hex'), '00000000000081500123456789abcdef');
  });
});
