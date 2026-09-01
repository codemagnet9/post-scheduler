// src/vault/crypto.ts
// Authenticated encryption (AES-256-GCM) with a VERSIONED keyring, so keys rotate without a
// downtime migration: new writes use the current key; old ciphertext stays readable via the key id
// stored alongside it. The reencrypt routine (vault/tokens.ts) migrates rows in the background.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

interface Keyring { current: string; keys: Record<string, Buffer> }

let cached: Keyring | null = null;

function loadKeyring(): Keyring {
  const raw = process.env.MERIDIAN_KEYRING;       // JSON: { "v1": "<base64 32 bytes>", "v2": "..." }
  const current = process.env.MERIDIAN_KEY_CURRENT; // e.g. "v2"
  if (!raw || !current) throw new Error('MERIDIAN_KEYRING and MERIDIAN_KEY_CURRENT are required');
  const parsed = JSON.parse(raw) as Record<string, string>;
  const keys: Record<string, Buffer> = {};
  for (const [id, b64] of Object.entries(parsed)) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`key '${id}' must be 32 bytes (got ${key.length})`);
    keys[id] = key;
  }
  if (!keys[current]) throw new Error(`current key '${current}' is not in the keyring`);
  return { current, keys };
}

function keyring(): Keyring {
  return (cached ??= loadKeyring());
}

export function currentKeyId(): string {
  return keyring().current;
}

// ciphertext layout: iv(12) || authTag(16) || data
export function encrypt(plaintext: string): { ciphertext: Buffer; keyId: string } {
  const { current, keys } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys[current], iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), enc]), keyId: current };
}

export function decrypt(ciphertext: Buffer, keyId: string): string {
  const { keys } = keyring();
  const key = keys[keyId];
  if (!key) throw new Error(`unknown key id '${keyId}'`);
  const iv = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(12, 28);
  const data = ciphertext.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Tests rotate MERIDIAN_KEY_CURRENT at runtime; reset the cache so the change takes effect.
export function _resetKeyringForTest(): void {
  cached = null;
}
