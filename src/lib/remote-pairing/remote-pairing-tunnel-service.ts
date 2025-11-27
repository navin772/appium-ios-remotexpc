/**
 * Remote Pairing Tunnel Service
 *
 * Implements the RemotePairing protocol for establishing WiFi tunnel connections
 * to iOS devices. This is the equivalent of pymobiledevice3's RemotePairingTunnelService.
 *
 * The protocol flow:
 * 1. Connect to device IP:port (discovered via Bonjour _remotepairing._tcp)
 * 2. Perform handshake with wireProtocolVersion
 * 3. Validate pairing using stored Ed25519 keys and ephemeral X25519 key exchange
 * 4. Initialize encryption keys for tunnel communication
 */
import { logger } from '@appium/support';
import * as net from 'node:net';
import { hostname } from 'node:os';

import { PairingDataComponentType } from '../apple-tv/constants.js';
import {
  createEd25519Signature,
  decryptChaCha20Poly1305,
  encryptChaCha20Poly1305,
  generateX25519KeyPair,
  hkdf,
  x25519Exchange,
} from '../apple-tv/encryption/index.js';
import { decodeTLV8ToDict, encodeTLV8 } from '../apple-tv/tlv/index.js';
import type { TLV8Item } from '../apple-tv/types.js';
import { generateHostId } from '../apple-tv/utils/uuid-generator.js';
import {
  getRemotePairingStorage,
  type RemotePairingRecord,
} from './remote-pairing-storage.js';

const log = logger.getLogger('RemotePairingTunnelService');

// Protocol constants
const WIRE_PROTOCOL_VERSION = 19;
const REPAIRING_PACKET_MAGIC = 'RPPairing';
const TIMEOUT = 30000;

// Pairing message constants
const PAIR_VERIFY_ENCRYPT_SALT = 'Pair-Verify-Encrypt-Salt';
const PAIR_VERIFY_ENCRYPT_INFO = 'Pair-Verify-Encrypt-Info';

/**
 * Result of a successful tunnel connection
 */
export interface RemotePairingTunnelResult {
  /** The connected socket */
  socket: net.Socket;
  /** Encryption key for client-to-server communication */
  clientEncryptionKey: Buffer;
  /** Encryption key for server-to-client communication */
  serverEncryptionKey: Buffer;
  /** Remote device identifier (UDID) */
  remoteIdentifier: string;
  /** Device hostname/IP */
  hostname: string;
  /** Device port */
  port: number;
  /** Shared encryption key for tunnel (can be used as PSK) */
  encryptionKey: Buffer;
}

/**
 * Result of createListener request
 */
export interface ListenerResult {
  /** Port to connect to for tunnel */
  port: number;
  /** Additional parameters */
  [key: string]: any;
}

/**
 * Remote Pairing Tunnel Service
 *
 * Establishes WiFi tunnel connections to iOS devices using stored pairing credentials.
 */
export class RemotePairingTunnelService {
  private socket: net.Socket | null = null;
  private _sequenceNumber = 0;
  private readBuffer: Buffer = Buffer.alloc(0);
  private encryptionKey: Buffer | null = null;
  private clientCipher: { key: Buffer } | null = null;
  private serverCipher: { key: Buffer } | null = null;
  private handshakeInfo: any = null;
  private readonly identifier: string;
  private readonly x25519KeyPair = generateX25519KeyPair();

  constructor(
    private readonly deviceIdentifier: string,
    private readonly targetHostname: string,
    private readonly targetPort: number,
  ) {
    this.identifier = generateHostId(hostname());
  }

  /**
   * Gets the remote device identifier from handshake
   */
  get remoteIdentifier(): string {
    return this.handshakeInfo?.peerDeviceInfo?.identifier ?? this.deviceIdentifier;
  }

  /**
   * Connects to the device and verifies pairing
   * @returns TunnelResult with socket and encryption keys
   */
  async connect(): Promise<RemotePairingTunnelResult> {
    try {
      log.info(`Connecting to ${this.targetHostname}:${this.targetPort}`);

      // Load pairing record
      const pairingRecord = await this.loadPairingRecord();
      if (!pairingRecord) {
        throw new Error(
          `No pairing record found for device ${this.deviceIdentifier}. ` +
            'Device must be paired over USB first.',
        );
      }

      // Establish TCP connection
      await this.connectSocket();

      // Perform handshake
      await this.attemptPairVerify();

      // Validate pairing with stored credentials
      const pairingValid = await this.validatePairing(pairingRecord);
      if (!pairingValid) {
        throw new Error('Pairing validation failed');
      }

      // Initialize encryption keys
      this.initClientServerMainEncryptionKeys();

      log.info(`Successfully connected to ${this.remoteIdentifier} over WiFi`);

      return {
        socket: this.socket!,
        clientEncryptionKey: this.clientCipher!.key,
        serverEncryptionKey: this.serverCipher!.key,
        remoteIdentifier: this.remoteIdentifier,
        hostname: this.targetHostname,
        port: this.targetPort,
        encryptionKey: this.encryptionKey!,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Creates a TCP listener on the device for tunnel connection
   * This must be called after connect() succeeds
   * @returns Listener parameters including the port to connect to
   */
  async createTcpListener(): Promise<ListenerResult> {
    if (!this.encryptionKey || !this.clientCipher || !this.serverCipher) {
      throw new Error('Not connected. Call connect() first.');
    }

    log.info('Creating TCP listener on device...');

    const request = {
      request: {
        _0: {
          createListener: {
            key: this.encryptionKey.toString('base64'),
            peerConnectionsInfo: [
              { owningPID: process.pid, owningProcessName: 'appium-remotexpc' },
            ],
            transportProtocolType: 'tcp',
          },
        },
      },
    };

    const response = await this.sendReceiveEncryptedRequest(request);
    const listenerResult = response.createListener;

    log.info(`TCP listener created on port: ${listenerResult.port}`);

    return listenerResult;
  }

  /**
   * Sends an encrypted request and receives response
   */
  private async sendReceiveEncryptedRequest(request: any): Promise<any> {
    if (!this.clientCipher || !this.serverCipher) {
      throw new Error('Encryption not initialized');
    }

    const nonce = this.createSequenceNonce(this._encryptedSequenceNumber);
    const plaintext = Buffer.from(JSON.stringify(request), 'utf8');

    const encryptedData = encryptChaCha20Poly1305({
      plaintext,
      key: this.clientCipher.key,
      nonce,
      aad: Buffer.alloc(0),
    });

    await this.sendRequest({
      message: { streamEncrypted: { _0: encryptedData.toString('base64') } },
      originatedBy: 'host',
      sequenceNumber: this._sequenceNumber++,
    });

    const response = await this.receiveResponse();
    this._encryptedSequenceNumber++;

    // Decrypt the response
    const encryptedResponseData = Buffer.from(
      response.message.streamEncrypted._0,
      'base64',
    );

    const decrypted = decryptChaCha20Poly1305({
      ciphertext: encryptedResponseData,
      key: this.serverCipher.key,
      nonce,
    });

    const decryptedResponse = JSON.parse(decrypted.toString('utf8'));
    const result = decryptedResponse.response?._1;

    if (result?.errorExtended) {
      throw new Error(
        result.errorExtended._0?.userInfo?.NSLocalizedDescription ||
          'Unknown error',
      );
    }

    return result;
  }

  /**
   * Creates a sequence-based nonce for encrypted communication
   */
  private createSequenceNonce(sequenceNumber: number): Buffer {
    const nonce = Buffer.alloc(12);
    // Write sequence number as little-endian 64-bit integer
    nonce.writeBigUInt64LE(BigInt(sequenceNumber), 0);
    return nonce;
  }

  private _encryptedSequenceNumber = 0;

  /**
   * Closes the connection
   */
  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Loads the pairing record for the device
   */
  private async loadPairingRecord(): Promise<RemotePairingRecord | null> {
    const storage = getRemotePairingStorage();
    return storage.load(this.deviceIdentifier);
  }

  /**
   * Establishes TCP connection to the device
   */
  private async connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Connection timeout after ${TIMEOUT}ms`));
      }, TIMEOUT);

      this.socket = new net.Socket();

      this.socket.once('connect', () => {
        clearTimeout(timeoutId);
        log.debug('TCP connection established');
        resolve();
      });

      this.socket.once('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      this.socket.connect(this.targetPort, this.targetHostname);
    });
  }

  /**
   * Performs handshake with attemptPairVerify flag
   */
  private async attemptPairVerify(): Promise<void> {
    const handshakeData = {
      hostOptions: { attemptPairVerify: true },
      wireProtocolVersion: WIRE_PROTOCOL_VERSION,
    };

    const response = await this.sendReceiveHandshake(handshakeData);
    this.handshakeInfo = response;
    log.debug('Handshake completed');
  }

  /**
   * Validates pairing using X25519 key exchange and Ed25519 signature
   * @param pairingRecord - Stored pairing record with Ed25519 keys
   * @returns True if pairing is valid
   */
  private async validatePairing(pairingRecord: RemotePairingRecord): Promise<boolean> {
    // Step 1: Send our X25519 public key
    const pairingData = encodeTLV8([
      { type: PairingDataComponentType.STATE, data: Buffer.from([0x01]) },
      {
        type: PairingDataComponentType.PUBLIC_KEY,
        data: this.x25519KeyPair.publicKey,
      },
    ]);

    const response = await this.sendReceivePairingData({
      data: pairingData.toString('base64'),
      kind: 'verifyManualPairing',
      startNewSession: true,
    });

    const data = decodeTLV8ToDict(Buffer.from(response, 'base64'));

    // Check for error
    if (data[PairingDataComponentType.ERROR]) {
      await this.sendPairVerifyFailed();
      return false;
    }

    // Step 2: Perform X25519 key exchange
    const peerPublicKey = data[PairingDataComponentType.PUBLIC_KEY];
    if (!peerPublicKey) {
      log.error('No peer public key in response');
      await this.sendPairVerifyFailed();
      return false;
    }

    this.encryptionKey = x25519Exchange(
      this.x25519KeyPair.privateKey,
      peerPublicKey,
    );

    // Step 3: Derive encryption key
    const derivedKey = hkdf({
      ikm: this.encryptionKey,
      salt: Buffer.from(PAIR_VERIFY_ENCRYPT_SALT, 'utf8'),
      info: Buffer.from(PAIR_VERIFY_ENCRYPT_INFO, 'utf8'),
      length: 32,
    });

    // Step 4: Sign with Ed25519 key
    const signBuf = Buffer.concat([
      this.x25519KeyPair.publicKey,
      Buffer.from(this.identifier, 'utf8'),
      peerPublicKey,
    ]);

    const signature = createEd25519Signature(signBuf, pairingRecord.privateKey);

    // Step 5: Encrypt and send signature
    const tlvData = encodeTLV8([
      {
        type: PairingDataComponentType.IDENTIFIER,
        data: Buffer.from(this.identifier, 'utf8'),
      },
      { type: PairingDataComponentType.SIGNATURE, data: signature },
    ]);

    const nonce = this.createNonce('PV-Msg03');
    const encryptedData = encryptChaCha20Poly1305({
      plaintext: tlvData,
      key: derivedKey,
      nonce,
      aad: Buffer.alloc(0),
    });

    const verifyData = encodeTLV8([
      { type: PairingDataComponentType.STATE, data: Buffer.from([0x03]) },
      { type: PairingDataComponentType.ENCRYPTED_DATA, data: encryptedData },
    ]);

    const verifyResponse = await this.sendReceivePairingData({
      data: verifyData.toString('base64'),
      kind: 'verifyManualPairing',
      startNewSession: false,
    });

    const verifyParsed = decodeTLV8ToDict(Buffer.from(verifyResponse, 'base64'));

    if (verifyParsed[PairingDataComponentType.ERROR]) {
      await this.sendPairVerifyFailed();
      return false;
    }

    log.info('Pairing validation successful');
    return true;
  }

  /**
   * Initializes client and server encryption keys for tunnel communication
   */
  private initClientServerMainEncryptionKeys(): void {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }

    const clientKey = hkdf({
      ikm: this.encryptionKey,
      salt: null,
      info: Buffer.from('ClientEncrypt-main', 'utf8'),
      length: 32,
    });

    const serverKey = hkdf({
      ikm: this.encryptionKey,
      salt: null,
      info: Buffer.from('ServerEncrypt-main', 'utf8'),
      length: 32,
    });

    this.clientCipher = { key: clientKey };
    this.serverCipher = { key: serverKey };

    log.debug('Encryption keys initialized');
  }

  /**
   * Sends pair verify failed event
   */
  private async sendPairVerifyFailed(): Promise<void> {
    await this.sendPlainRequest({ event: { _0: { pairVerifyFailed: {} } } });
  }

  /**
   * Creates a 12-byte nonce with 4-byte prefix
   */
  private createNonce(nonceString: string): Buffer {
    return Buffer.concat([Buffer.alloc(4), Buffer.from(nonceString, 'utf8')]);
  }

  // ========== Protocol Communication Methods ==========

  /**
   * Sends a handshake request and receives response
   */
  private async sendReceiveHandshake(handshakeData: any): Promise<any> {
    const response = await this.sendReceivePlainRequest({
      request: { _0: { handshake: { _0: handshakeData } } },
    });
    return response.response?._1?.handshake?._0;
  }

  /**
   * Sends pairing data and receives response
   */
  private async sendReceivePairingData(pairingData: any): Promise<string> {
    await this.sendPairingData(pairingData);
    return this.receivePairingData();
  }

  /**
   * Sends pairing data event
   */
  private async sendPairingData(pairingData: any): Promise<void> {
    await this.sendPlainRequest({
      event: { _0: { pairingData: { _0: pairingData } } },
    });
  }

  /**
   * Receives pairing data from response
   */
  private async receivePairingData(): Promise<string> {
    const response = await this.receivePlainResponse();
    const event = response?.event?._0;

    if (event?.pairingData?._0?.data) {
      return event.pairingData._0.data;
    }

    if (event?.pairingRejectedWithError) {
      const errorInfo = event.pairingRejectedWithError?.wrappedError?.userInfo;
      throw new Error(
        errorInfo?.NSLocalizedDescription ?? 'Pairing rejected',
      );
    }

    throw new Error(`Unexpected response: ${JSON.stringify(response)}`);
  }

  /**
   * Sends a plain request and receives response
   */
  private async sendReceivePlainRequest(plainRequest: any): Promise<any> {
    await this.sendPlainRequest(plainRequest);
    return this.receivePlainResponse();
  }

  /**
   * Sends a plain (unencrypted) request
   */
  private async sendPlainRequest(plainRequest: any): Promise<void> {
    await this.sendRequest({
      message: { plain: { _0: plainRequest } },
      originatedBy: 'host',
      sequenceNumber: this._sequenceNumber++,
    });
  }

  /**
   * Receives a plain response
   */
  private async receivePlainResponse(): Promise<any> {
    const response = await this.receiveResponse();
    return response?.message?.plain?._0;
  }

  /**
   * Sends a request packet
   */
  private async sendRequest(data: any): Promise<void> {
    const packet = this.createRPPairingPacket(data);
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket not connected'));
        return;
      }

      this.socket.write(packet, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Receives a response packet
   */
  private async receiveResponse(): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket not connected'));
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Response timeout after ${TIMEOUT}ms`));
      }, TIMEOUT);

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.socket?.removeListener('data', onData);
        this.socket?.removeListener('error', onError);
      };

      const onData = (chunk: Buffer) => {
        this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

        // Check for complete packet
        const magicLen = REPAIRING_PACKET_MAGIC.length;
        if (this.readBuffer.length < magicLen + 2) {
          return;
        }

        const magic = this.readBuffer.subarray(0, magicLen).toString('ascii');
        if (magic !== REPAIRING_PACKET_MAGIC) {
          cleanup();
          reject(new Error(`Invalid protocol magic: ${magic}`));
          return;
        }

        const expectedLength = this.readBuffer.readUInt16BE(magicLen);
        const totalLength = magicLen + 2 + expectedLength;

        if (this.readBuffer.length >= totalLength) {
          const bodyBytes = this.readBuffer.subarray(magicLen + 2, totalLength);
          this.readBuffer = this.readBuffer.subarray(totalLength);

          try {
            const response = JSON.parse(bodyBytes.toString('utf8'));
            cleanup();
            resolve(response);
          } catch (error) {
            cleanup();
            reject(new Error(`Failed to parse response: ${error}`));
          }
        }
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      this.socket.on('data', onData);
      this.socket.once('error', onError);
    });
  }

  /**
   * Creates an RPPairing protocol packet
   */
  private createRPPairingPacket(jsonData: any): Buffer {
    const jsonString = JSON.stringify(jsonData);
    const bodyBytes = Buffer.from(jsonString, 'utf8');
    const magic = Buffer.from(REPAIRING_PACKET_MAGIC, 'ascii');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bodyBytes.length, 0);
    return Buffer.concat([magic, length, bodyBytes]);
  }
}

