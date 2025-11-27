/**
 * X25519 (Curve25519) key exchange implementation
 * Used for ephemeral key agreement in remote pairing verification
 */
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';

import { getLogger } from '../../logger.js';
import { CryptographyError } from '../errors.js';

const log = getLogger('X25519');

const X25519_KEY_LENGTH = 32;

// DER prefix for X25519 private key in PKCS#8 format
const X25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b656e04220420',
  'hex',
);

// DER prefix for X25519 public key in SPKI format
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface X25519KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/**
 * Generates a new X25519 key pair for key exchange
 * @returns X25519KeyPair object containing 32-byte public and private key buffers
 * @throws CryptographyError if key generation fails
 */
export function generateX25519KeyPair(): X25519KeyPair {
  try {
    const keyPair = generateKeyPairSync('x25519');

    const publicKeyDer = keyPair.publicKey.export({
      type: 'spki',
      format: 'der',
    }) as Buffer;

    const privateKeyDer = keyPair.privateKey.export({
      type: 'pkcs8',
      format: 'der',
    }) as Buffer;

    // Extract raw 32-byte keys from DER format
    const publicKeyBuffer = publicKeyDer.subarray(
      publicKeyDer.length - X25519_KEY_LENGTH,
    );
    const privateKeyBuffer = privateKeyDer.subarray(
      privateKeyDer.length - X25519_KEY_LENGTH,
    );

    return {
      publicKey: publicKeyBuffer,
      privateKey: privateKeyBuffer,
    };
  } catch (error) {
    log.error('Failed to generate X25519 key pair:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(
      `Failed to generate X25519 key pair: ${message}`,
    );
  }
}

/**
 * Performs X25519 Diffie-Hellman key exchange
 * @param privateKey - 32-byte X25519 private key
 * @param peerPublicKey - 32-byte X25519 public key from peer
 * @returns 32-byte shared secret
 * @throws CryptographyError if key exchange fails
 */
export function x25519Exchange(
  privateKey: Buffer,
  peerPublicKey: Buffer,
): Buffer {
  if (!privateKey || privateKey.length !== X25519_KEY_LENGTH) {
    throw new CryptographyError(
      `Private key must be ${X25519_KEY_LENGTH} bytes`,
    );
  }

  if (!peerPublicKey || peerPublicKey.length !== X25519_KEY_LENGTH) {
    throw new CryptographyError(
      `Peer public key must be ${X25519_KEY_LENGTH} bytes`,
    );
  }

  try {
    // Convert raw private key to KeyObject
    const privateKeyDer = Buffer.concat([X25519_PKCS8_PREFIX, privateKey]);
    const privateKeyObject = createPrivateKey({
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8',
    });

    // Convert raw public key to KeyObject
    const publicKeyDer = Buffer.concat([X25519_SPKI_PREFIX, peerPublicKey]);
    const publicKeyObject = createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
    });

    // Perform key exchange
    const sharedSecret = diffieHellman({
      privateKey: privateKeyObject,
      publicKey: publicKeyObject,
    });

    return sharedSecret;
  } catch (error) {
    log.error('X25519 key exchange failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new CryptographyError(`X25519 key exchange failed: ${message}`);
  }
}

