import crypto from 'crypto';

// The encryption key is derived from a master secret.
// Only ChainClone and L2aaS backends know this key — ChainClone encrypts, L2aaS decrypts.
const L2AAS_MASTER_KEY = crypto.createHash('sha256').update('l2aas-data-exchange-v1-mesa-ops').digest();

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
 * Encrypt data into .l2aas format (AES-256-GCM).
 *
 * File layout:
 *   magic(6) + version(1) + iv(12) + tag(16) + ciphertext(rest)
 */
export function encryptL2aasFile(data: L2aasFileContent): Buffer {
  const json = JSON.stringify(data);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', L2AAS_MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const magic = Buffer.from('L2AAS\0'); // 6 bytes magic header
  const version = Buffer.from([0x01]);   // version 1
  return Buffer.concat([magic, version, iv, tag, ct]);
}

/**
 * Decrypt .l2aas file — used by L2aaS import.
 */
export function decryptL2aasFile(fileBuffer: Buffer): L2aasFileContent {
  // Verify magic header
  const magic = fileBuffer.subarray(0, 6).toString();
  if (magic !== 'L2AAS\0') throw new Error('Invalid .l2aas file — not a valid export');

  const version = fileBuffer[6];
  if (version !== 1) throw new Error('Unsupported .l2aas file version');

  const iv = fileBuffer.subarray(7, 19);
  const tag = fileBuffer.subarray(19, 35);
  const ct = fileBuffer.subarray(35);

  const decipher = crypto.createDecipheriv('aes-256-gcm', L2AAS_MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);

  return JSON.parse(plain.toString('utf8'));
}
