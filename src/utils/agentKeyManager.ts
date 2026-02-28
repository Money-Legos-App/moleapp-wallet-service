import crypto from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { type Hex, type Address } from 'viem';
import { logger } from './logger.js';

/**
 * Agent Key Manager
 *
 * Generates and manages per-mission agent keypairs for Hyperliquid trading.
 * Each mission gets a unique agent wallet for security isolation.
 *
 * Security model:
 * - Private key is encrypted with AES-256-GCM before storage
 * - Encryption key is derived from AGENT_KEY_ENCRYPTION_SECRET env var
 * - Each encryption uses a unique IV (stored alongside ciphertext)
 * - GCM auth tag prevents tampering
 *
 * Why per-mission keys:
 * - If one mission's logic bugs out, it cannot sign trades for another mission
 * - Each agent approval on Hyperliquid is scoped to one agent address
 * - Clean revocation: revoking one mission doesn't affect others
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_SALT = 'moleapp-agent-key-encryption-v1';

/**
 * Get the encryption key from environment.
 * Derives a 32-byte key from the secret using HKDF (RFC 5869)
 * with SHA-256 as the hash function and a fixed application salt.
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.AGENT_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('AGENT_KEY_ENCRYPTION_SECRET is required for agent key management');
  }
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    secret,
    HKDF_SALT,
    'agent-key-enc',
    KEY_LENGTH,
  ));
}

/**
 * Generate a new random agent keypair.
 *
 * @returns Agent address and encrypted private key components
 */
export function generateAgentKey(): {
  address: Address;
  privateKeyEncrypted: string;
  iv: string;
  authTag: string;
} {
  // Generate a random 32-byte private key
  const privateKeyBytes = crypto.randomBytes(32);
  const privateKey = ('0x' + privateKeyBytes.toString('hex')) as Hex;

  // Derive the address from the private key
  const account = privateKeyToAccount(privateKey);
  const address = account.address;

  // Encrypt the private key
  const encryptionKey = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  logger.info('Agent key generated', {
    address,
    keyLength: privateKeyBytes.length,
  });

  return {
    address,
    privateKeyEncrypted: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt an agent private key.
 *
 * @param encrypted - AES-256-GCM encrypted private key (hex)
 * @param iv - Initialization vector (hex)
 * @param authTag - GCM authentication tag (hex)
 * @returns Decrypted private key as Hex string
 */
export function decryptAgentKey(
  encrypted: string,
  iv: string,
  authTag: string,
): Hex {
  const encryptionKey = getEncryptionKey();
  const ivBuffer = Buffer.from(iv, 'hex');
  const authTagBuffer = Buffer.from(authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted as Hex;
}

/**
 * Encrypt an existing agent private key.
 * Used when agent-service sends back an SDK-generated agent key
 * that needs to be stored encrypted in the DB.
 *
 * @param privateKeyHex - Raw private key hex string (with or without 0x prefix)
 * @returns Encrypted key components for DB storage
 */
export function encryptAgentKey(privateKeyHex: string): {
  privateKeyEncrypted: string;
  iv: string;
  authTag: string;
} {
  // Normalize to 0x-prefixed
  const normalizedKey = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;

  const encryptionKey = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
  let encrypted = cipher.update(normalizedKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    privateKeyEncrypted: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Sign a message using a decrypted agent private key.
 * This is used for Hyperliquid trade order signing (local, zero-latency).
 *
 * @param privateKey - Decrypted private key
 * @param message - Message to sign
 * @returns Signature
 */
export async function signWithAgentKey(
  privateKey: Hex,
  typedData: {
    domain: any;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, any>;
  },
): Promise<string> {
  const { signTypedData } = await import('viem/accounts');

  // Remove EIP712Domain from types if present
  const types = { ...typedData.types };
  delete types['EIP712Domain'];

  const signature = await signTypedData({
    privateKey,
    domain: typedData.domain,
    types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });

  return signature;
}
