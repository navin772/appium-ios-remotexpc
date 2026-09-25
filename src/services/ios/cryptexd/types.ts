import type {PlistDictionary, XPCDictionary} from '../../../lib/types.js';

/** A cryptex installed on the device, as `copy-installed` reports it. */
export interface InstalledCryptex {
  identifier: string;
  version: string;
}

/** The payloads and parameters of an `install` request. */
export interface CryptexInstallRequest {
  /** The cryptex disk image (`Cryptex1,GenericDmg`). */
  image: Buffer;
  /** `Cryptex1,GenericTrustCache`. */
  trustCache: Buffer;
  /** The Cryptex1 personalization ticket (IM4M) bound to the device's current cryptex nonce. */
  ticket: Buffer;
  /** `Cryptex1,CryptexInfoPlist`; it names and versions the cryptex. */
  infoPlist: Buffer;
  /** `Cryptex1,GenericVolume` root hash. */
  volumeHash: Buffer;
  /** The `Cryptex1,*` parameters of the cryptex's build identity, as built by `loadCryptex1Assets`. */
  cryptex1Properties: XPCDictionary;
}

export interface CryptexInstallOptions {
  imageTypeIndex?: number;
  persistence?: number;
  noncePersistence?: number;
  auth?: number;
  timeoutMs?: number;
}

/** A Cryptex1 image read out of an unpacked DDI `Restore` directory, minus its ticket. */
export interface Cryptex1Assets extends Omit<CryptexInstallRequest, 'ticket'> {
  /** The build identity describing the cryptex; the TSS request is built from it. */
  buildIdentity: PlistDictionary;
  /** Handle (not index) of the nonce domain the cryptex is personalized against. */
  nonceDomainHandle: number;
}
