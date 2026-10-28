import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** Encrypts with AES-256-GCM. Output layout: iv (12) || authTag (16) || ciphertext. */
export function encrypt(plaintext: Buffer | string, key: Buffer, aad?: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Decrypts a blob produced by {@link encrypt}. Throws if the blob was tampered with or the key is wrong. */
export function decrypt(blob: Buffer, key: Buffer, aad?: string): Buffer {
  assertKey(key);
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('Ciphertext too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
}
