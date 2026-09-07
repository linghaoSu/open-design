import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for GitLab access/refresh tokens at rest (PLAN §5.3).
 * AES-256-GCM via node:crypto; the ciphertext blob is
 * `<12-byte iv><16-byte tag><ciphertext>` and the row stores `key_id` so a
 * future key rotation can decrypt old rows with the previous key.
 *
 * The key id is bound into the GCM tag as additional authenticated data, so a
 * blob copied next to a different `key_id` (or a `key_id` column edited to
 * point at another key) fails authentication instead of decrypting.
 */
export interface TokenCipher {
  readonly keyId: string;
  encrypt(plaintext: string): Buffer;
  decrypt(blob: Buffer, keyId: string): string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createTokenCipher(key: Buffer): TokenCipher {
  if (key.length !== 32) throw new Error('token cipher key must be 32 bytes');
  const keyId = `k_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  const aad = Buffer.from(keyId, 'utf8');
  return {
    keyId,
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(blob, rowKeyId) {
      if (rowKeyId !== keyId) throw new Error(`token encrypted with unknown key ${rowKeyId}`);
      if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('token blob too short');
      const iv = blob.subarray(0, IV_BYTES);
      const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const body = blob.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

/**
 * Without TOKEN_ENC_KEY the hub still runs, but with a process-lifetime random
 * key: tokens survive only until restart, after which the refresh path fails
 * and the user is asked to log in again. Logged once at startup.
 */
export function createEphemeralTokenCipher(): TokenCipher {
  return createTokenCipher(randomBytes(32));
}
