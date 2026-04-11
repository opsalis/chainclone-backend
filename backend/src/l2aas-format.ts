import crypto from 'crypto';
import { ethers } from 'ethers';

// Our service keypair (shared between ChainClone and L2aaS)
// In production: load from env var or secret manager
const SERVICE_PRIVATE_KEY = '0x' + crypto.createHash('sha256').update('l2aas-service-key-v1-mesa-ops').digest('hex');
const SERVICE_WALLET = new ethers.Wallet(SERVICE_PRIVATE_KEY);
const SERVICE_PUBLIC_KEY = SERVICE_WALLET.signingKey.compressedPublicKey;

export interface L2aasFileContent {
  version: 1;
  sourceChain: string;
  extractedAt: string;
  contracts: Array<{
    address: string;
    bytecode: string;
    storage: Record<string, string>;
    balance: string;
  }>;
  metadata: {
    contractCount: number;
    totalStorageSlots: number;
    sourceChainId: number;
  };
}

/**
 * Derive shared secret via ECDH with customer's public key.
 * Uses HKDF to produce a proper AES-256 key from the raw shared secret.
 */
function deriveSharedKey(customerPublicKey: string): Buffer {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(SERVICE_PRIVATE_KEY.replace('0x', ''), 'hex'));
  const customerPubBuf = Buffer.from(customerPublicKey.replace('0x', ''), 'hex');
  const shared = ecdh.computeSecret(customerPubBuf);
  // Derive AES key via HKDF
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(32), 'l2aas-file-encrypt-v1', 32));
}

/**
 * Encrypt data into .l2aas format (AES-256-GCM) using ECDH with customer's wallet public key.
 *
 * File layout:
 *   magic(6) + version(1) + iv(12) + tag(16) + ciphertext(rest)
 */
export function encryptL2aasFile(data: L2aasFileContent, customerPublicKey: string): Buffer {
  const aesKey = deriveSharedKey(customerPublicKey);
  const iv = crypto.randomBytes(12);
  const json = JSON.stringify(data);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const magic = Buffer.from('L2AAS\0'); // 6 bytes magic header
  const version = Buffer.from([0x01]);   // version 1
  return Buffer.concat([magic, version, iv, tag, ct]);
}

/**
 * Decrypt .l2aas file using ECDH with customer's wallet public key.
 * Same customer wallet on both ChainClone and L2aaS produces the same shared secret.
 */
export function decryptL2aasFile(fileBuffer: Buffer, customerPublicKey: string): L2aasFileContent {
  // Verify magic header
  const magic = fileBuffer.subarray(0, 6).toString();
  if (magic !== 'L2AAS\0') throw new Error('Invalid .l2aas file — not a valid export');

  const version = fileBuffer[6];
  if (version !== 1) throw new Error('Unsupported .l2aas file version');

  const aesKey = deriveSharedKey(customerPublicKey);
  const iv = fileBuffer.subarray(7, 19);
  const tag = fileBuffer.subarray(19, 35);
  const ct = fileBuffer.subarray(35);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);

  return JSON.parse(plain.toString('utf8'));
}

/**
 * Get our service public key (useful for verification, not needed by customers).
 */
export function getServicePublicKey(): string {
  return SERVICE_PUBLIC_KEY;
}
