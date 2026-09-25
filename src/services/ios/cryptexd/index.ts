import {getLogger} from '../../../lib/logger.js';
import {XPCFileTransfer} from '../../../lib/remote-xpc/xpc-file-transfer.js';
import {asDictionary} from '../../../lib/remote-xpc/xpc-value.js';
import {getCryptex1TicketFromTSS, type Img4ChipInstance} from '../../../lib/tss/index.js';
import type {XPCDictionary} from '../../../lib/types.js';
import {type CoreDeviceInvokeOptions, CoreDeviceService} from '../core-device/core-device-service.js';
import {MobileImageMounterService} from '../mobile-image-mounter/index.js';
import {CRYPTEX_INSTALL_DEFAULTS, CRYPTEX_INSTALL_TIMEOUT_MS, DDI_CRYPTEX_IDENTIFIER} from './constants.js';
import {loadCryptex1Assets} from './developer-disk-image.js';
import {CryptexdError} from './errors.js';
import type {CryptexInstallOptions, CryptexInstallRequest, InstalledCryptex} from './types.js';

const log = getLogger('CryptexdService');

/**
 * Client for `com.apple.security.cryptexd.remote`, which installs cryptexes such as the
 * DeveloperDiskImage. Devices missing from the DDI's `PersonalizedDMG` build identities (e.g. the
 * iPhone 18 series) can only get a DDI this way.
 *
 * Requests are `{routine, argv}` dictionaries answered with `{error: 0, argv}` or `{cferr}`.
 * The daemon serves one routine per connection, which `sendReceive` already provides.
 */
export class CryptexdService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.security.cryptexd.remote';

  constructor(udid: string) {
    super(udid, CryptexdService.RSD_SERVICE_NAME);
  }

  /** The device's AppleImage4 chip instance (`img4_chip_*` keys), used to personalize a cryptex. */
  async readPersonalizationIdentifiers(): Promise<Img4ChipInstance> {
    const argv = await this.invokeRoutine('read-personalization-id');
    for (const key of ['img4_chip_chip', 'img4_chip_ecid', 'img4_chip_cpro']) {
      if (argv[key] === undefined) {
        throw new CryptexdError('read-personalization-id', `the reply has no ${key}`);
      }
    }
    return argv as Img4ChipInstance;
  }

  /** Lists the installed cryptexes. */
  async copyInstalled(): Promise<InstalledCryptex[]> {
    const argv = await this.invokeRoutine('copy-installed');
    const entries = Array.isArray(argv['remote-cryptex-array']) ? argv['remote-cryptex-array'] : [];
    return entries.map((entry) => {
      const cryptex = asDictionary(entry) ?? {};
      return {
        identifier: String(cryptex['remote-cryptex-identifier']),
        version: String(cryptex['remote-cryptex-version']),
      };
    });
  }

  /** Returns the installed DeveloperDiskImage cryptex, or `undefined` when there is none. */
  async findInstalledDeveloperDiskImage(): Promise<InstalledCryptex | undefined> {
    return (await this.copyInstalled()).find(({identifier}) => identifier === DDI_CRYPTEX_IDENTIFIER);
  }

  /**
   * Reads the nonce of a nonce domain.
   *
   * @param nonceDomainHandle The domain's **handle**, which is what a build identity's
   * `Cryptex1,NonceDomain` holds. Selecting by index instead picks an unrelated domain whose
   * nonce yields tickets the device rejects.
   */
  async getNonce(nonceDomainHandle: number): Promise<Buffer> {
    const argv = await this.invokeRoutine('get-nonce', {'nonce-domain-handle': BigInt(nonceDomainHandle)});
    if (!Buffer.isBuffer(argv.nonce)) {
      throw new CryptexdError('get-nonce', 'the reply has no nonce');
    }
    return unwrapCryptexNonce(argv.nonce);
  }

  /**
   * Installs a cryptex. The payloads are announced as XPC file transfers and pushed on the same
   * connection; the daemon replies once it has consumed and verified them all.
   */
  async install(request: CryptexInstallRequest, options: CryptexInstallOptions = {}): Promise<void> {
    const {
      imageTypeIndex = CRYPTEX_INSTALL_DEFAULTS.imageTypeIndex,
      persistence = CRYPTEX_INSTALL_DEFAULTS.persistence,
      noncePersistence = CRYPTEX_INSTALL_DEFAULTS.noncePersistence,
      auth = CRYPTEX_INSTALL_DEFAULTS.auth,
      timeoutMs = CRYPTEX_INSTALL_TIMEOUT_MS,
    } = options;
    const payloads: [string, Buffer][] = [
      ['image', request.image],
      ['trustcache', request.trustCache],
      ['im4m', request.ticket],
      ['info', request.infoPlist],
      ['volumehash', request.volumeHash],
    ];
    // Integers are uint64 (bigint) except image-type-index, which is int64.
    const argv: XPCDictionary = {
      auth: BigInt(auth),
      'client-version': BigInt(CRYPTEX_INSTALL_DEFAULTS.clientVersion),
      'cryptex1-properties': request.cryptex1Properties,
      'image-type-index': imageTypeIndex,
      'nonce-persistence': BigInt(noncePersistence),
      persistence: BigInt(persistence),
    };
    const fileTransfers = new Map<number, Buffer>();
    payloads.forEach(([key, data], index) => {
      const transferId = index + 1;
      argv[key] = new XPCFileTransfer(transferId, data.length);
      fileTransfers.set(transferId, data);
    });

    await this.invokeRoutine('install', argv, {timeoutMs, fileTransfers});
  }

  /**
   * Uninstalls a cryptex.
   * @param identifier The identifier `copyInstalled` reports, e.g. `com.apple.MobileAsset.DDI`.
   * @param version Limits the removal to this version.
   */
  async uninstall(identifier: string, version?: string): Promise<void> {
    const argv: XPCDictionary = {'remote-cryptex-identifier': identifier};
    if (version !== undefined) {
      argv['remote-cryptex-version'] = version;
    }
    await this.invokeRoutine('uninstall', argv);
  }

  /**
   * Personalizes and installs the DeveloperDiskImage cryptex, as Xcode does from iOS 17.
   *
   * Does nothing when a DDI is already present, either as a cryptex or as a Personalized image
   * mounted by the image mounter (which holds the mount point the cryptex would need).
   *
   * @param restoreDir An unpacked DDI `Restore` directory, e.g. Xcode's
   * `/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore`; see {@link loadCryptex1Assets}.
   */
  async installDeveloperDiskImage(restoreDir: string): Promise<void> {
    const installed = await this.findInstalledDeveloperDiskImage();
    if (installed) {
      log.info(`The DeveloperDiskImage cryptex ${installed.version} is already installed`);
      return;
    }

    const mounter = new MobileImageMounterService(this.udid);
    try {
      if (await mounter.isPersonalizedImageMounted()) {
        log.info('A Personalized DeveloperDiskImage is already mounted');
        return;
      }
      if (!(await mounter.queryDeveloperModeStatus())) {
        throw new Error('Developer mode is not enabled on this device');
      }
    } finally {
      await mounter.cleanup();
    }

    const assets = await loadCryptex1Assets(restoreDir);
    const chipInstance = await this.readPersonalizationIdentifiers();
    const nonce = await this.getNonce(assets.nonceDomainHandle);
    const ticket = await getCryptex1TicketFromTSS(assets.buildIdentity, chipInstance, nonce);
    await this.install({...assets, ticket});

    const ddi = await this.findInstalledDeveloperDiskImage();
    if (!ddi) {
      throw new CryptexdError('install', `the device reported success but ${DDI_CRYPTEX_IDENTIFIER} is not installed`);
    }
    log.info(`Installed the DeveloperDiskImage cryptex ${ddi.version}`);
  }

  private async invokeRoutine(
    routine: string,
    argv: XPCDictionary = {},
    options: CoreDeviceInvokeOptions = {},
  ): Promise<XPCDictionary> {
    const reply = await this.sendReceive({routine, argv}, {...options, actionIdentifier: routine});
    const cferr = asDictionary(reply.cferr);
    if (cferr) {
      throw CryptexdError.fromCferr(routine, cferr);
    }
    // read-personalization-id omits `error` on success.
    const errno = Number(reply.error ?? 0);
    if (errno !== 0) {
      throw new CryptexdError(routine, `errno ${errno}`, {code: errno});
    }
    return asDictionary(reply.argv) ?? {};
  }
}

/**
 * Extracts the nonce from cryptexd's nonce structure: a 2-byte lead, the nonce, and a trailing
 * little-endian uint32 holding the nonce length (56 bytes carrying a 48-byte nonce on current devices).
 */
export function unwrapCryptexNonce(blob: Buffer): Buffer {
  const length = blob.length >= 4 ? blob.readUInt32LE(blob.length - 4) : -1;
  if (length < 0 || 2 + length > blob.length - 4) {
    throw new CryptexdError('get-nonce', `malformed ${blob.length}-byte nonce structure`);
  }
  return Buffer.from(blob.subarray(2, 2 + length));
}

export {CryptexdError} from './errors.js';
export {findCryptex1BuildIdentity, loadCryptex1Assets} from './developer-disk-image.js';
export {DDI_CRYPTEX_IDENTIFIER} from './constants.js';
export type {Cryptex1Assets, CryptexInstallOptions, CryptexInstallRequest, InstalledCryptex} from './types.js';

export default CryptexdService;
