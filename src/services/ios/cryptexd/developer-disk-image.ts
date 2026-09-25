import {promises as fs} from 'node:fs';
import path from 'node:path';

import {util} from '@appium/support';

import {parsePlist} from '../../../lib/plist/index.js';
import type {PlistDictionary, XPCDictionary} from '../../../lib/types.js';
import {CRYPTEX1_VARIANT_SUFFIX} from './constants.js';
import type {Cryptex1Assets} from './types.js';

/**
 * Loads the Cryptex1 DeveloperDiskImage out of an unpacked DDI `Restore` directory, such as
 * Xcode's `/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore`.
 *
 * Payload locations are read from the build manifest (`Manifest.<key>.Info.Path`, relative to
 * the directory) rather than assumed, so renamed copies work as long as their manifest matches.
 *
 * @param restoreDir Directory holding `BuildManifest.plist` and the payloads it references.
 */
export async function loadCryptex1Assets(restoreDir: string): Promise<Cryptex1Assets> {
  const manifestPath = path.join(restoreDir, 'BuildManifest.plist');
  const buildManifest = parsePlist(await fs.readFile(manifestPath)) as PlistDictionary;
  const buildIdentity = findCryptex1BuildIdentity(buildManifest, manifestPath);
  const manifest = buildIdentity.Manifest as Record<string, PlistDictionary>;

  const readPayload = async (key: string): Promise<Buffer> => {
    const relativePath = (manifest[key]?.Info as PlistDictionary | undefined)?.Path;
    if (typeof relativePath !== 'string') {
      throw new Error(`The cryptex build identity in ${manifestPath} has no path for ${key}`);
    }
    return await fs.readFile(path.join(restoreDir, relativePath));
  };
  const [image, trustCache, infoPlist, volumeHash] = await Promise.all([
    readPayload('Cryptex1,GenericDmg'),
    readPayload('Cryptex1,GenericTrustCache'),
    readPayload('Cryptex1,CryptexInfoPlist'),
    readPayload('Cryptex1,GenericVolume'),
  ]);

  return {
    image,
    trustCache,
    infoPlist,
    volumeHash,
    cryptex1Properties: buildCryptex1Properties(buildIdentity),
    buildIdentity,
    nonceDomainHandle: Number(buildIdentity['Cryptex1,NonceDomain']),
  };
}

/**
 * Returns the one build identity describing a cryptex, out of the ~141 in a DDI's manifest.
 * @throws {Error} When the manifest has none.
 */
export function findCryptex1BuildIdentity(
  buildManifest: PlistDictionary,
  source = 'the build manifest',
): PlistDictionary {
  const identities = Array.isArray(buildManifest.BuildIdentities) ? buildManifest.BuildIdentities : [];
  const identity = identities.find((candidate) => {
    const info = util.isPlainObject(candidate) ? (candidate as PlistDictionary).Info : undefined;
    const variant = util.isPlainObject(info) ? (info as PlistDictionary).Variant : undefined;
    return typeof variant === 'string' && variant.endsWith(CRYPTEX1_VARIANT_SUFFIX);
  });
  if (!identity) {
    throw new Error(`No '${CRYPTEX1_VARIANT_SUFFIX}' build identity in ${source}`);
  }
  return identity as PlistDictionary;
}

/**
 * The `cryptex1-properties` of an `install` request. The integers must be XPC uint64 (hence
 * `bigint`): the daemon rejects an int64 `Cryptex1,NonceDomain`.
 */
function buildCryptex1Properties(buildIdentity: PlistDictionary): XPCDictionary {
  return {
    'Cryptex1,UseProductClass': Boolean(buildIdentity['Cryptex1,UseProductClass']),
    MountedCryptex: false,
    'Cryptex1,SubType': BigInt(buildIdentity['Cryptex1,SubType'] as number),
    'Cryptex1,NonceDomain': BigInt(buildIdentity['Cryptex1,NonceDomain'] as number),
    'Cryptex1,Version': String(buildIdentity['Cryptex1,Version']),
    // Named differently here than in the build identity and the TSS request.
    'Cryptex1,PreauthVersion': String(buildIdentity['Cryptex1,PreauthorizationVersion']),
  };
}
