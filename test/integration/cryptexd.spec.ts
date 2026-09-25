import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {after, before, describe, it} from 'node:test';

import {type CryptexdService, DDI_CRYPTEX_IDENTIFIER, loadCryptex1Assets} from '../../src/index.js';
import {getCryptex1TicketFromTSS} from '../../src/lib/tss/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

const XCODE_DDI_RESTORE_DIR = '/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore';
const RESTORE_DIR =
  process.env.CRYPTEX_DDI_RESTORE_DIR ?? (existsSync(XCODE_DDI_RESTORE_DIR) ? XCODE_DDI_RESTORE_DIR : undefined);
/** The DDI cryptex's `Cryptex1,NonceDomain` in current DDIs. */
const DDI_NONCE_DOMAIN_HANDLE = 4;

describe('CryptexdService', {timeout: 180_000}, function () {
  let udid: string;
  let service: CryptexdService | null = null;

  before(async function () {
    udid = requireDeviceUdid();
    service = await Services.startCryptexdService(udid);
  });

  after(async function () {
    await service?.close();
  });

  it('lists the installed cryptexes', async function () {
    const installed = await service!.copyInstalled();

    assert.ok(Array.isArray(installed));
    for (const cryptex of installed) {
      assert.ok(cryptex.identifier.length > 0);
      assert.ok(cryptex.version.length > 0);
    }
  });

  it('reads the chip instance the device is personalized with', async function () {
    const chip = await service!.readPersonalizationIdentifiers();

    // The chip id is the first half of a modern UDID, e.g. 00008140-....
    assert.equal(Number(chip.img4_chip_chip), parseInt(udid.split('-')[0], 16));
    assert.equal(BigInt(chip.img4_chip_ecid), BigInt(`0x${udid.split('-')[1]}`));
  });

  it('reads the DDI cryptex nonce', async function () {
    const nonce = await service!.getNonce(DDI_NONCE_DOMAIN_HANDLE);

    assert.equal(nonce.length, 48);
  });

  describe('with a DDI Restore directory', {skip: !RESTORE_DIR && 'set CRYPTEX_DDI_RESTORE_DIR'}, function () {
    it('gets a Cryptex1 ticket from TSS for this device', async function () {
      const assets = await loadCryptex1Assets(RESTORE_DIR!);
      const chip = await service!.readPersonalizationIdentifiers();
      const nonce = await service!.getNonce(assets.nonceDomainHandle);

      const ticket = await getCryptex1TicketFromTSS(assets.buildIdentity, chip, nonce);

      assert.equal(ticket[0], 0x30, 'an IM4M is a DER SEQUENCE');
      assert.ok(ticket.includes(Buffer.from('IM4M')));
    });

    it('makes sure a DeveloperDiskImage is present, installing the cryptex if needed', async function () {
      await service!.installDeveloperDiskImage(RESTORE_DIR!);

      const cryptex = await service!.findInstalledDeveloperDiskImage();
      const mounter = await Services.startMobileImageMounterService(udid);
      try {
        assert.ok(
          cryptex?.identifier === DDI_CRYPTEX_IDENTIFIER || (await mounter.isPersonalizedImageMounted()),
          'no DeveloperDiskImage after installDeveloperDiskImage()',
        );
      } finally {
        await mounter.cleanup();
      }
    });
  });
});
