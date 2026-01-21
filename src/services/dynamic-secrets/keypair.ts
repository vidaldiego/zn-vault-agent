// Path: zn-vault-agent/src/services/dynamic-secrets/keypair.ts
// RSA keypair management for dynamic secrets encryption/decryption

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../lib/logger.js';

const log = createLogger({ module: 'dynamic-secrets-keypair' });

// ============================================================================
// Constants
// ============================================================================

const KEY_BITS = 2048;
const KEY_DIR = process.env.ZNVAULT_AGENT_KEY_DIR ?? '/var/lib/zn-vault-agent';
const PRIVATE_KEY_FILE = 'dynamic-secrets.key';
const PUBLIC_KEY_FILE = 'dynamic-secrets.pub';

// ============================================================================
// Types
// ============================================================================

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

// ============================================================================
// State
// ============================================================================

let cachedKeyPair: KeyPair | null = null;

// ============================================================================
// Keypair Management
// ============================================================================

/**
 * Get the key directory path, creating it if necessary
 */
function getKeyDir(): string {
  // For development, use ~/.zn-vault-agent/keys
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  const devKeyDir = path.join(homeDir, '.zn-vault-agent', 'keys');

  // Use production path if it exists and is writable, otherwise use dev path
  if (fs.existsSync(KEY_DIR)) {
    try {
      fs.accessSync(KEY_DIR, fs.constants.W_OK);
      return KEY_DIR;
    } catch {
      // Not writable, fall through to dev path
    }
  }

  // Ensure dev key directory exists
  if (!fs.existsSync(devKeyDir)) {
    fs.mkdirSync(devKeyDir, { recursive: true, mode: 0o700 });
    log.info({ keyDir: devKeyDir }, 'Created key directory');
  }

  return devKeyDir;
}

/**
 * Generate a new RSA keypair
 */
function generateKeyPair(): KeyPair {
  log.info('Generating new RSA keypair for dynamic secrets');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: KEY_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return { publicKey, privateKey };
}

/**
 * Load keypair from disk, or generate and save if not exists
 */
function loadOrGenerateKeyPair(): KeyPair {
  const keyDir = getKeyDir();
  const privateKeyPath = path.join(keyDir, PRIVATE_KEY_FILE);
  const publicKeyPath = path.join(keyDir, PUBLIC_KEY_FILE);

  // Try to load existing keypair
  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    try {
      const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
      const publicKey = fs.readFileSync(publicKeyPath, 'utf8');

      // Validate the keys work together
      const testData = Buffer.from('test');
      const encrypted = crypto.publicEncrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        testData
      );
      const decrypted = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        encrypted
      );

      if (decrypted.toString() !== 'test') {
        throw new Error('Key validation failed');
      }

      log.info({ keyDir }, 'Loaded existing RSA keypair');
      return { publicKey, privateKey };
    } catch (err) {
      log.warn({ err }, 'Failed to load existing keypair, generating new one');
    }
  }

  // Generate new keypair
  const keyPair = generateKeyPair();

  // Save to disk
  try {
    fs.writeFileSync(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, keyPair.publicKey, { mode: 0o644 });
    log.info({ keyDir }, 'Saved new RSA keypair');
  } catch (err) {
    log.warn({ err, keyDir }, 'Failed to save keypair to disk (using in-memory only)');
  }

  return keyPair;
}

/**
 * Get the agent's RSA keypair (loads from disk or generates)
 */
export function getKeyPair(): KeyPair {
  cachedKeyPair ??= loadOrGenerateKeyPair();
  return cachedKeyPair;
}

/**
 * Get the agent's public key (for sending to vault)
 */
export function getPublicKey(): string {
  return getKeyPair().publicKey;
}

/**
 * Get the agent's private key (for decrypting configs)
 */
export function getPrivateKey(): string {
  return getKeyPair().privateKey;
}

// ============================================================================
// Decryption
// ============================================================================

/**
 * Decrypt AES key using agent's RSA private key
 */
export function decryptAesKey(encryptedKeyBase64: string): Buffer {
  const privateKey = getPrivateKey();
  const encrypted = Buffer.from(encryptedKeyBase64, 'base64');

  return crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    encrypted
  );
}

/**
 * Decrypt config using AES-256-GCM
 */
export function decryptConfig(
  ciphertextBase64: string,
  aesKey: Buffer,
  nonceBase64: string,
  authTagBase64: string
): string {
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');
  const nonce = Buffer.from(nonceBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// ============================================================================
// Encryption (for sending encrypted passwords to vault)
// ============================================================================

/**
 * Encrypt password using vault's public key (RSA-OAEP)
 */
export function encryptPassword(password: string, vaultPublicKey: string): string {
  const encrypted = crypto.publicEncrypt(
    {
      key: vaultPublicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(password, 'utf8')
  );

  return encrypted.toString('base64');
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize keypair (call on agent startup)
 */
export function initializeKeyPair(): void {
  getKeyPair();
  log.info('Dynamic secrets keypair initialized');
}
