import {randomUUID} from 'node:crypto';

import axios from 'axios';

import {getLogger} from '../logger.js';
import {createPlist, parsePlist} from '../plist/index.js';
import type {PlistDictionary, PlistValue, XPCDictionary} from '../types.js';

const log = getLogger('TSSRequestor');

// TSS Constants
const TSS_CONTROLLER_ACTION_URL = 'http://gs.apple.com/TSS/controller?action=2';
const TSS_CLIENT_VERSION_STRING = 'libauthinstall-1104.0.9';
const TSS_SUCCESS_MESSAGE = 'SUCCESS';
const TSS_REQUEST_TIMEOUT = 10000; // 10 seconds
const TSS_RULE_IGNORE_VALUE = 255;

export interface TSSResponse {
  [key: string]: any;
  ApImg4Ticket?: Buffer;
  'Cryptex1,Ticket'?: Buffer;
}

/**
 * A device's AppleImage4 chip instance, as cryptexd's `read-personalization-id` reports it
 * (`img4_chip_chip` is the ChipID, `img4_chip_ecid` the ECID, `img4_chip_cpro` the production mode).
 */
export interface Img4ChipInstance extends XPCDictionary {
  img4_chip_chip: number | bigint;
  img4_chip_ecid: number | bigint;
  img4_chip_cpro: number | bigint | boolean;
}

export interface RestoreRequestRule {
  Conditions?: {
    ApRawProductionMode?: boolean;
    ApCurrentProductionMode?: boolean;
    ApRawSecurityMode?: boolean;
    ApRequiresImage4?: boolean;
    ApDemotionPolicyOverride?: string;
    ApInRomDFU?: boolean;
    [key: string]: any;
  };
  Actions?: {
    [key: string]: any;
  };
}

export interface ManifestEntry {
  Info?: {
    RestoreRequestRules?: RestoreRequestRule[];
    [key: string]: any;
  };
  Digest?: Buffer;
  Trusted?: boolean;
  [key: string]: any;
}

export interface BuildManifest {
  LoadableTrustCache?: ManifestEntry;
  PersonalizedDMG?: ManifestEntry;
  [key: string]: ManifestEntry | undefined;
}

export class TSSError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TSSError';
  }
}

export class BuildIdentityNotFoundError extends TSSError {
  constructor(message: string) {
    super(message);
    this.name = 'BuildIdentityNotFoundError';
  }
}

export class TSSRequest {
  private _request: PlistDictionary;

  constructor() {
    this._request = {
      '@HostPlatformInfo': 'mac',
      '@VersionInfo': TSS_CLIENT_VERSION_STRING,
      '@UUID': randomUUID().toUpperCase(),
    };
  }

  /**
   * Apply restore request rules to TSS entry
   * @param tssEntry The TSS entry to modify
   * @param parameters The parameters for rule evaluation
   * @param rules The rules to apply
   * @returns Modified TSS entry
   */
  static applyRestoreRequestRules(
    tssEntry: PlistDictionary,
    parameters: PlistDictionary,
    rules: RestoreRequestRule[],
  ): PlistDictionary {
    for (const rule of rules) {
      let conditionsFulfilled = true;
      const conditions = rule.Conditions || {};

      for (const [key, value] of Object.entries(conditions)) {
        if (!conditionsFulfilled) {
          break;
        }

        let value2: any;
        switch (key) {
          case 'ApRawProductionMode':
          case 'ApCurrentProductionMode':
            value2 = parameters.ApProductionMode;
            break;
          case 'ApRawSecurityMode':
            value2 = parameters.ApSecurityMode;
            break;
          case 'ApRequiresImage4':
            value2 = parameters.ApSupportsImg4;
            break;
          case 'ApDemotionPolicyOverride':
            value2 = parameters.DemotionPolicy;
            break;
          case 'ApInRomDFU':
            value2 = parameters.ApInRomDFU;
            break;
          default:
            log.error(`Unhandled condition ${key} while parsing RestoreRequestRules`);
            value2 = null;
        }

        if (value2 !== null && value2 !== undefined) {
          conditionsFulfilled = value === value2;
        } else {
          conditionsFulfilled = false;
        }
      }

      if (!conditionsFulfilled) {
        continue;
      }

      const actions = rule.Actions || {};
      for (const [key, value] of Object.entries(actions)) {
        if (value !== TSS_RULE_IGNORE_VALUE) {
          const value2 = tssEntry[key];
          if (value2) {
            delete tssEntry[key];
          }
          log.debug(`Adding ${key}=${value} to TSS entry`);
          tssEntry[key] = value as any;
        }
      }
    }
    return tssEntry;
  }

  /**
   * Build a Cryptex1 personalization request (`@Cryptex1,Ticket`).
   *
   * Unlike the AP request {@link getManifestFromTSS} builds, the device is identified by
   * `Cryptex1,UDID` alone (no `Ap*` tags), and each personalized component contributes only
   * its `Digest`. The generic DMG is declared `Personalize: false` and is left out.
   *
   * @param buildIdentity The build identity describing the cryptex (its `Cryptex1,*` keys).
   * @param chipInstance The device's chip instance.
   * @param nonce The nonce of the identity's `Cryptex1,NonceDomain`, as is (not hashed).
   */
  addCryptex1Tags(buildIdentity: PlistDictionary, chipInstance: Img4ChipInstance, nonce: Buffer): void {
    const identityValue = (key: string): PlistValue => {
      const value = buildIdentity[key];
      if (value === undefined) {
        throw new TSSError(`The build identity has no ${key}`);
      }
      return value;
    };

    this.update({
      '@Cryptex1,Ticket': true,
      'Cryptex1,ChipID': parseManifestInteger(identityValue('Cryptex1,ChipID')),
      'Cryptex1,Type': identityValue('Cryptex1,Type'),
      'Cryptex1,SubType': identityValue('Cryptex1,SubType'),
      'Cryptex1,ProductClass': parseManifestInteger(identityValue('Cryptex1,ProductClass')),
      'Cryptex1,UseProductClass': identityValue('Cryptex1,UseProductClass'),
      'Cryptex1,NonceDomain': identityValue('Cryptex1,NonceDomain'),
      'Cryptex1,Version': identityValue('Cryptex1,Version'),
      'Cryptex1,PreauthorizationVersion': identityValue('Cryptex1,PreauthorizationVersion'),
      'Cryptex1,Nonce': nonce,
      'Cryptex1,ProductionMode': Boolean(chipInstance.img4_chip_cpro),
      'Cryptex1,UDID': cryptex1Udid(chipInstance),
      'Cryptex1,UniqueTagList': Buffer.alloc(0),
    });

    const manifest = (buildIdentity.Manifest ?? {}) as Record<string, ManifestEntry>;
    for (const [key, entry] of Object.entries(manifest)) {
      if (!key.startsWith('Cryptex1,')) {
        continue;
      }
      if (!entry.Info?.Personalize) {
        log.debug(`Skipping ${key} as it is not personalized`);
        continue;
      }
      this.update({[key]: {Digest: entry.Digest ?? Buffer.alloc(0)}});
    }
  }

  /**
   * Update the TSS request with additional options
   * @param options The options to add to the request
   */
  update(options: PlistDictionary): void {
    Object.assign(this._request, options);
  }

  /**
   * Send the TSS request to Apple's servers and receive the response
   * @returns Promise resolving to TSS response
   */
  async sendReceive(): Promise<TSSResponse> {
    const headers = {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/xml; charset="utf-8"',
      'User-Agent': 'InetURL/1.0',
      Expect: '',
    };

    log.info('Sending TSS request...');
    log.debug('TSS Request:', this._request);

    try {
      const requestData = createPlist(this._request);

      const res = await axios.post(TSS_CONTROLLER_ACTION_URL, requestData, {
        headers,
        timeout: TSS_REQUEST_TIMEOUT,
        responseType: 'text',
      });

      const response = res.data;
      log.debug(`TSS response status: ${res.status}`);

      if (response.includes('MESSAGE=SUCCESS')) {
        log.debug('TSS response successfully received');
      } else {
        log.warn('TSS response does not contain MESSAGE=SUCCESS');
      }

      const [, messagePart] = response.split('MESSAGE=');
      if (!messagePart) {
        throw new TSSError('Invalid TSS response format');
      }

      const [message] = messagePart.split('&');
      log.debug(`TSS server message: ${message}`);

      if (message !== TSS_SUCCESS_MESSAGE) {
        throw new TSSError(`TSS server replied: ${message}`);
      }

      const [, requestStringPart] = response.split('REQUEST_STRING=');
      if (!requestStringPart) {
        throw new TSSError('No REQUEST_STRING in TSS response');
      }

      return parsePlist(requestStringPart) as TSSResponse;
    } catch (error) {
      log.error('TSS request failed:', error);
      throw error;
    }
  }
}

/**
 * The 16-byte `Cryptex1,UDID`: the ChipID and the ECID, each as a big-endian uint64.
 */
export function cryptex1Udid(chipInstance: Img4ChipInstance): Buffer {
  const udid = Buffer.alloc(16);
  udid.writeBigUInt64BE(BigInt(chipInstance.img4_chip_chip), 0);
  udid.writeBigUInt64BE(BigInt(chipInstance.img4_chip_ecid), 8);
  return udid;
}

/** Build manifests store some integers as strings, e.g. `Cryptex1,ChipID` is `'0xFF10'`. */
function parseManifestInteger(value: PlistValue): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new TSSError(`Expected an integer in the build identity, got ${String(value)}`);
  }
  return parsed;
}

/**
 * Get a Cryptex1 personalization ticket from Apple's TSS.
 * @param buildIdentity The build identity describing the cryptex (its `Cryptex1,*` keys)
 * @param chipInstance The device's chip instance, from cryptexd `read-personalization-id`
 * @param nonce The nonce of the identity's `Cryptex1,NonceDomain`
 * @returns The ticket (an IM4M) to install the cryptex with
 */
export async function getCryptex1TicketFromTSS(
  buildIdentity: PlistDictionary,
  chipInstance: Img4ChipInstance,
  nonce: Buffer,
): Promise<Buffer> {
  const request = new TSSRequest();
  request.addCryptex1Tags(buildIdentity, chipInstance, nonce);
  const response = await request.sendReceive();
  const ticket = response['Cryptex1,Ticket'] ?? response.ApImg4Ticket;
  if (!Buffer.isBuffer(ticket)) {
    throw new TSSError('TSS response does not contain a Cryptex1,Ticket');
  }
  return ticket;
}

/**
 * Get manifest from Apple's TSS (Ticket Signing Server)
 * @param personalizationIdentifiers The device personalization identifiers
 * @param buildManifest The build manifest dictionary
 * @param queryNonce Function to query nonce
 * @returns Promise resolving to the manifest bytes
 */
export async function getManifestFromTSS(
  personalizationIdentifiers: PlistDictionary,
  buildManifest: PlistDictionary,
  queryNonce: (personalizedImageType: string) => Promise<Buffer>,
): Promise<Buffer> {
  log.debug('Starting TSS manifest generation process');

  const request = new TSSRequest();

  for (const [key, value] of Object.entries(personalizationIdentifiers)) {
    if (key.startsWith('Ap,')) {
      request.update({[key]: value});
    }
  }

  const ecid = personalizationIdentifiers.UniqueChipID as number;
  const boardId = personalizationIdentifiers.BoardId as number;
  const chipId = personalizationIdentifiers.ChipID as number;

  let buildIdentity: any = null;
  const buildIdentities = buildManifest.BuildIdentities as any[];

  for (const tmpBuildIdentity of buildIdentities) {
    // ApBoardID and ApChipID are hex strings, so parse with radix 16
    const apBoardId = parseInt(tmpBuildIdentity.ApBoardID, 16);
    const apChipId = parseInt(tmpBuildIdentity.ApChipID, 16);

    if (apBoardId === boardId && apChipId === chipId) {
      buildIdentity = tmpBuildIdentity;
      break;
    }
  }

  if (!buildIdentity) {
    throw new BuildIdentityNotFoundError(`Could not find the manifest for board ${boardId} and chip ${chipId}`);
  }

  const manifest = buildIdentity.Manifest as BuildManifest;

  const parameters = {
    ApProductionMode: true,
    ApSecurityDomain: 1,
    ApSecurityMode: true,
    ApSupportsImg4: true,
    ApCurrentProductionMode: true,
    ApRequiresImage4: true,
    ApDemotionPolicyOverride: 'Demote',
    ApInRomDFU: true,
    ApRawSecurityMode: true,
  };

  const apNonce = await queryNonce('DeveloperDiskImage');

  request.update({
    '@ApImg4Ticket': true,
    '@BBTicket': true,
    ApBoardID: boardId,
    ApChipID: chipId,
    ApECID: ecid,
    ApNonce: apNonce,
    ApProductionMode: true,
    ApSecurityDomain: 1,
    ApSecurityMode: true,
    SepNonce: Buffer.alloc(20, 0), // 20 bytes of zeros
    UID_MODE: false,
  });

  for (const [key, manifestEntry] of Object.entries(manifest)) {
    if (!manifestEntry?.Info) {
      continue;
    }

    if (!manifestEntry.Trusted) {
      log.debug(`Skipping ${key} as it is not trusted`);
      continue;
    }

    log.debug(`Processing manifest entry: ${key}`);

    const tssEntry: PlistDictionary = {
      Digest: manifestEntry.Digest || Buffer.alloc(0),
      Trusted: manifestEntry.Trusted || false,
    };

    if (key === 'PersonalizedDMG') {
      tssEntry.Name = 'DeveloperDiskImage';
    }

    const loadableTrustCache = manifest.LoadableTrustCache;
    if (loadableTrustCache?.Info?.RestoreRequestRules) {
      const rules = loadableTrustCache.Info.RestoreRequestRules;
      if (rules.length > 0) {
        log.debug(`Applying restore request rules for entry ${key}`);
        TSSRequest.applyRestoreRequestRules(tssEntry, parameters, rules);
      }
    }

    request.update({[key]: tssEntry});
  }

  const response = await request.sendReceive();

  if (!response.ApImg4Ticket) {
    throw new TSSError('TSS response does not contain ApImg4Ticket');
  }

  return response.ApImg4Ticket;
}
