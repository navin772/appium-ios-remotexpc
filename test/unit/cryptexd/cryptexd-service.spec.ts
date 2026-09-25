import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {type TestContext, after, before, describe, it} from 'node:test';

import {createPlist} from '../../../src/lib/plist/index.js';
import {XPCFileTransfer} from '../../../src/lib/remote-xpc/xpc-file-transfer.js';
import {TSSRequest} from '../../../src/lib/tss/index.js';
import type {PlistDictionary, XPCDictionary} from '../../../src/lib/types.js';
import type {CoreDeviceInvokeOptions} from '../../../src/services/ios/core-device/core-device-service.js';
import {
  CryptexdError,
  CryptexdService,
  DDI_CRYPTEX_IDENTIFIER,
  findCryptex1BuildIdentity,
  loadCryptex1Assets,
  unwrapCryptexNonce,
} from '../../../src/services/ios/cryptexd/index.js';
import {MobileImageMounterService} from '../../../src/services/ios/mobile-image-mounter/index.js';

const NONCE = Buffer.alloc(48, 0x42);
const TICKET = Buffer.from('cryptex1 ticket');
const CHIP = {img4_chip_chip: 0x8140, img4_chip_ecid: 0x1e25d20111801c, img4_chip_cpro: 1, img4_chip_bord: 12};
const PAYLOADS = {
  image: Buffer.from('generic dmg'),
  trustCache: Buffer.from('trust cache'),
  infoPlist: Buffer.from('<plist/>'),
  volumeHash: Buffer.from('root hash'),
};

/** The 56-byte structure `get-nonce` returns: 2-byte lead, nonce, 2 bytes padding, uint32le length. */
function nonceStructure(nonce: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(nonce.length);
  return Buffer.concat([Buffer.alloc(2), nonce, Buffer.alloc(2), length]);
}

type RoutineHandler = (argv: XPCDictionary) => XPCDictionary;

interface RoutineCall {
  routine: string;
  argv: XPCDictionary;
  options: CoreDeviceInvokeOptions;
}

/** Answers each cryptexd routine with its handler's reply, recording the calls. */
function stubRoutines(
  t: TestContext,
  service: CryptexdService,
  handlers: Record<string, RoutineHandler>,
): RoutineCall[] {
  const calls: RoutineCall[] = [];
  t.mock.method(service as any, 'sendReceive', async (body: XPCDictionary, options: CoreDeviceInvokeOptions) => {
    const routine = String(body.routine);
    const argv = body.argv as XPCDictionary;
    calls.push({routine, argv, options});
    const handler = handlers[routine];
    if (!handler) {
      throw new Error(`unexpected routine ${routine}`);
    }
    return handler(argv);
  });
  return calls;
}

const ok =
  (argv: XPCDictionary = {}): RoutineHandler =>
  () => ({error: 0, argv});

describe('CryptexdService', function () {
  let restoreDir: string;

  before(async function () {
    restoreDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cryptex-restore-'));
    await fs.mkdir(path.join(restoreDir, 'Firmware'));
    const manifest = {
      ProductBuildVersion: '27A266a',
      BuildIdentities: [
        {Info: {Variant: 'Customer Developer Disk Image'}, ApChipID: '0x8140', Manifest: {}},
        {
          Info: {Variant: 'iOS Customer Developer Disk Image Cryptex'},
          'Cryptex1,ChipID': '0xFF10',
          'Cryptex1,Type': 3,
          'Cryptex1,SubType': 2,
          'Cryptex1,ProductClass': '0xF2',
          'Cryptex1,UseProductClass': true,
          'Cryptex1,NonceDomain': 4,
          'Cryptex1,Version': '39.999.999.0.0,0',
          'Cryptex1,PreauthorizationVersion': '39.999.999.1.0,0',
          Manifest: {
            'Cryptex1,GenericDmg': {Digest: Buffer.alloc(48, 1), Info: {Path: 'image.dmg', Personalize: false}},
            'Cryptex1,GenericTrustCache': {
              Digest: Buffer.alloc(48, 2),
              Info: {Path: 'Firmware/image.dmg.trustcache', Personalize: true},
            },
            'Cryptex1,CryptexInfoPlist': {
              Digest: Buffer.alloc(48, 3),
              Info: {Path: 'Firmware/image.dmg.cryptex_info', Personalize: true},
            },
            'Cryptex1,GenericVolume': {
              Digest: Buffer.alloc(48, 4),
              Info: {Path: 'Firmware/image.dmg.root_hash', Personalize: true},
            },
          },
        },
      ],
    };
    await fs.writeFile(path.join(restoreDir, 'BuildManifest.plist'), createPlist(manifest));
    await fs.writeFile(path.join(restoreDir, 'image.dmg'), PAYLOADS.image);
    await fs.writeFile(path.join(restoreDir, 'Firmware/image.dmg.trustcache'), PAYLOADS.trustCache);
    await fs.writeFile(path.join(restoreDir, 'Firmware/image.dmg.cryptex_info'), PAYLOADS.infoPlist);
    await fs.writeFile(path.join(restoreDir, 'Firmware/image.dmg.root_hash'), PAYLOADS.volumeHash);
  });

  after(async function () {
    await fs.rm(restoreDir, {recursive: true, force: true});
  });

  describe('routines', function () {
    it('reads the chip instance from a reply that omits the error key', async function (t) {
      const service = new CryptexdService('udid');
      const calls = stubRoutines(t, service, {'read-personalization-id': () => ({argv: CHIP})});

      assert.deepEqual(await service.readPersonalizationIdentifiers(), CHIP);
      assert.deepEqual(calls[0].argv, {});
    });

    it('lists installed cryptexes', async function (t) {
      const service = new CryptexdService('udid');
      stubRoutines(t, service, {
        'copy-installed': ok({
          'remote-cryptex-array': [
            {'remote-cryptex-identifier': DDI_CRYPTEX_IDENTIFIER, 'remote-cryptex-version': '27.1.5228.8'},
          ],
        }),
      });

      assert.deepEqual(await service.copyInstalled(), [{identifier: DDI_CRYPTEX_IDENTIFIER, version: '27.1.5228.8'}]);
    });

    it('selects the nonce domain by handle, as a uint64, and unwraps the nonce', async function (t) {
      const service = new CryptexdService('udid');
      const calls = stubRoutines(t, service, {'get-nonce': ok({nonce: nonceStructure(NONCE)})});

      assert.deepEqual(await service.getNonce(4), NONCE);
      assert.deepEqual(calls[0].argv, {'nonce-domain-handle': 4n});
    });

    it('reports a cferr with its underlying errors', async function (t) {
      const service = new CryptexdService('udid');
      stubRoutines(t, service, {
        install: () => ({
          cferr: {
            cferr_code: 14,
            cferr_domain: 'com.apple.security.cryptex',
            cferr_userinfo: {
              NSLocalizedDescription: 'failed to check data property on manifest',
              underlying_cferr: {
                cferr_code: 84,
                cferr_domain: 'com.apple.security.cryptex.posix',
                cferr_userinfo: {NSLocalizedDescription: 'image4 trust evaluation failed'},
              },
            },
          },
        }),
      });

      await assert.rejects(service.install({...PAYLOADS, ticket: TICKET, cryptex1Properties: {}}), (error) => {
        assert.ok(error instanceof CryptexdError);
        assert.equal(error.code, 14);
        assert.equal(error.domain, 'com.apple.security.cryptex');
        assert.match(error.message, /^install failed: failed to check data property on manifest/);
        assert.match(error.message, /image4 trust evaluation failed \(com\.apple\.security\.cryptex\.posix: 84\)/);
        return true;
      });
    });

    it('reports a non-zero errno', async function (t) {
      const service = new CryptexdService('udid');
      stubRoutines(t, service, {uninstall: () => ({error: 2})});

      await assert.rejects(service.uninstall(DDI_CRYPTEX_IDENTIFIER), {name: 'CryptexdError', code: 2});
    });
  });

  describe('install', function () {
    it('announces five file transfers and pushes their payloads with the request', async function (t) {
      const service = new CryptexdService('udid');
      const calls = stubRoutines(t, service, {install: ok()});
      const cryptex1Properties = {'Cryptex1,NonceDomain': 4n};

      await service.install({...PAYLOADS, ticket: TICKET, cryptex1Properties});

      const [{argv, options}] = calls;
      assert.deepEqual(argv, {
        auth: 0n,
        'client-version': 3n,
        'cryptex1-properties': cryptex1Properties,
        'image-type-index': 10,
        'nonce-persistence': 1n,
        persistence: 2n,
        image: new XPCFileTransfer(1, PAYLOADS.image.length),
        trustcache: new XPCFileTransfer(2, PAYLOADS.trustCache.length),
        im4m: new XPCFileTransfer(3, TICKET.length),
        info: new XPCFileTransfer(4, PAYLOADS.infoPlist.length),
        volumehash: new XPCFileTransfer(5, PAYLOADS.volumeHash.length),
      });
      assert.deepEqual(
        [...(options.fileTransfers ?? [])],
        [
          [1, PAYLOADS.image],
          [2, PAYLOADS.trustCache],
          [3, TICKET],
          [4, PAYLOADS.infoPlist],
          [5, PAYLOADS.volumeHash],
        ],
      );
      assert.equal(options.timeoutMs, 120_000);
    });
  });

  describe('loadCryptex1Assets', function () {
    it('reads each payload from the path its manifest entry declares', async function () {
      const assets = await loadCryptex1Assets(restoreDir);

      assert.deepEqual(assets.image, PAYLOADS.image);
      assert.deepEqual(assets.trustCache, PAYLOADS.trustCache);
      assert.deepEqual(assets.infoPlist, PAYLOADS.infoPlist);
      assert.deepEqual(assets.volumeHash, PAYLOADS.volumeHash);
      assert.equal(assets.nonceDomainHandle, 4);
      assert.deepEqual(assets.cryptex1Properties, {
        'Cryptex1,UseProductClass': true,
        MountedCryptex: false,
        'Cryptex1,SubType': 2n,
        'Cryptex1,NonceDomain': 4n,
        'Cryptex1,Version': '39.999.999.0.0,0',
        'Cryptex1,PreauthVersion': '39.999.999.1.0,0',
      });
    });

    it('fails when the manifest has no cryptex identity', function () {
      assert.throws(
        () => findCryptex1BuildIdentity({BuildIdentities: [{Info: {Variant: 'Customer Developer Disk Image'}}]}),
        /No 'Developer Disk Image Cryptex' build identity/,
      );
    });
  });

  describe('installDeveloperDiskImage', function () {
    function stubImageMounter(t: TestContext, state: {mounted: boolean; developerMode: boolean}): void {
      t.mock.method(MobileImageMounterService.prototype, 'isPersonalizedImageMounted', async () => state.mounted);
      t.mock.method(MobileImageMounterService.prototype, 'queryDeveloperModeStatus', async () => state.developerMode);
      t.mock.method(MobileImageMounterService.prototype, 'cleanup', async (): Promise<void> => undefined);
    }

    function stubTss(t: TestContext): {requests: PlistDictionary[]} {
      const requests: PlistDictionary[] = [];
      t.mock.method(TSSRequest.prototype, 'sendReceive', async function (this: TSSRequest) {
        requests.push({...(this as unknown as {_request: PlistDictionary})._request});
        return {'Cryptex1,Ticket': TICKET};
      });
      return {requests};
    }

    const installedDdi = ok({
      'remote-cryptex-array': [
        {'remote-cryptex-identifier': DDI_CRYPTEX_IDENTIFIER, 'remote-cryptex-version': '27.0.266.1'},
      ],
    });

    it('personalizes against the cryptex nonce and installs, then confirms the install', async function (t) {
      const service = new CryptexdService('udid');
      stubImageMounter(t, {mounted: false, developerMode: true});
      const {requests} = stubTss(t);
      let installed = false;
      const calls = stubRoutines(t, service, {
        'copy-installed': (argv) => (installed ? installedDdi(argv) : ok({'remote-cryptex-array': []})(argv)),
        'read-personalization-id': ok(CHIP),
        'get-nonce': ok({nonce: nonceStructure(NONCE)}),
        install: () => {
          installed = true;
          return {error: 0};
        },
      });

      await service.installDeveloperDiskImage(restoreDir);

      assert.deepEqual(
        calls.map(({routine}) => routine),
        ['copy-installed', 'read-personalization-id', 'get-nonce', 'install', 'copy-installed'],
      );
      assert.deepEqual(calls[2].argv, {'nonce-domain-handle': 4n});
      assert.deepEqual(requests[0]['Cryptex1,Nonce'], NONCE);
      assert.equal(calls[3].options.fileTransfers?.get(3), TICKET);
      assert.deepEqual(calls[3].options.fileTransfers?.get(1), PAYLOADS.image);
    });

    it('does nothing when the DDI cryptex is already installed', async function (t) {
      const service = new CryptexdService('udid');
      stubImageMounter(t, {mounted: true, developerMode: true});
      const {requests} = stubTss(t);
      const calls = stubRoutines(t, service, {'copy-installed': installedDdi});

      await service.installDeveloperDiskImage(restoreDir);

      assert.deepEqual(
        calls.map(({routine}) => routine),
        ['copy-installed'],
      );
      assert.equal(requests.length, 0);
    });

    it('does nothing when the image mounter already has a Personalized image mounted', async function (t) {
      const service = new CryptexdService('udid');
      stubImageMounter(t, {mounted: true, developerMode: true});
      const {requests} = stubTss(t);
      const calls = stubRoutines(t, service, {'copy-installed': ok({'remote-cryptex-array': []})});

      await service.installDeveloperDiskImage(restoreDir);

      assert.deepEqual(
        calls.map(({routine}) => routine),
        ['copy-installed'],
      );
      assert.equal(requests.length, 0);
    });

    it('refuses when developer mode is off', async function (t) {
      const service = new CryptexdService('udid');
      stubImageMounter(t, {mounted: false, developerMode: false});
      stubRoutines(t, service, {'copy-installed': ok({'remote-cryptex-array': []})});

      await assert.rejects(service.installDeveloperDiskImage(restoreDir), /Developer mode is not enabled/);
    });

    it('fails when the install reports success but the DDI is not listed', async function (t) {
      const service = new CryptexdService('udid');
      stubImageMounter(t, {mounted: false, developerMode: true});
      stubTss(t);
      stubRoutines(t, service, {
        'copy-installed': ok({'remote-cryptex-array': []}),
        'read-personalization-id': ok(CHIP),
        'get-nonce': ok({nonce: nonceStructure(NONCE)}),
        install: ok(),
      });

      await assert.rejects(service.installDeveloperDiskImage(restoreDir), /is not installed/);
    });
  });
});

describe('unwrapCryptexNonce', function () {
  it('extracts the nonce declared by the trailing length', function () {
    assert.deepEqual(unwrapCryptexNonce(nonceStructure(NONCE)), NONCE);
  });

  it('rejects a structure whose declared length does not fit', function () {
    const blob = nonceStructure(NONCE);
    blob.writeUInt32LE(60, blob.length - 4);

    assert.throws(() => unwrapCryptexNonce(blob), /malformed 56-byte nonce structure/);
  });
});
