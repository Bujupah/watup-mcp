import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, safeEqual } from '../src/crypto.js';
import { testKey } from './helpers.js';

describe('crypto', () => {
  it('round-trips and uses a fresh IV per call', () => {
    const key = testKey();
    const a = encrypt('hello', key);
    const b = encrypt('hello', key);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, key).toString()).toBe('hello');
  });

  it('rejects tampered ciphertext, wrong key and wrong AAD', () => {
    const key = testKey();
    const blob = encrypt('secret', key, 'row-1');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decrypt(tampered, key, 'row-1')).toThrow();
    expect(() => decrypt(blob, testKey(), 'row-1')).toThrow();
    expect(() => decrypt(blob, key, 'row-2')).toThrow();
  });

  it('compares tokens', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
