import { describe, expect, it } from 'vitest';
import { useSqliteAuthState } from '../src/whatsapp/authStore.js';
import { memDb, testKey } from './helpers.js';

describe('useSqliteAuthState', () => {
  it('initialises fresh creds when nothing is stored', async () => {
    const db = memDb();
    const { state, hasStoredCreds } = await useSqliteAuthState(db, 'a', testKey());
    expect(hasStoredCreds()).toBe(false);
    expect(Buffer.isBuffer(state.creds.noiseKey.private) || state.creds.noiseKey.private instanceof Uint8Array).toBe(true);
  });

  it('round-trips creds and keys including Buffers', async () => {
    const db = memDb();
    const key = testKey();
    const first = await useSqliteAuthState(db, 'a', key);
    first.state.creds.registered = true;
    await first.saveCreds();
    const sessionBytes = Buffer.from([1, 2, 3, 250, 0, 7]);
    await first.state.keys.set({
      session: { 'peer.0': sessionBytes },
      'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } },
      'app-state-sync-key': { AAAA: { keyData: Buffer.from('kd'), timestamp: 5 } },
    });

    const second = await useSqliteAuthState(db, 'a', key);
    expect(second.hasStoredCreds()).toBe(true);
    expect(second.state.creds.registered).toBe(true);
    expect(Buffer.from(second.state.creds.noiseKey.private).equals(Buffer.from(first.state.creds.noiseKey.private))).toBe(true);

    const sessions = await second.state.keys.get('session', ['peer.0', 'missing']);
    expect(Buffer.isBuffer(sessions['peer.0'])).toBe(true);
    expect(Buffer.from(sessions['peer.0']!).equals(sessionBytes)).toBe(true);
    expect(sessions.missing).toBeUndefined();

    const pre = await second.state.keys.get('pre-key', ['1']);
    expect(Buffer.from(pre['1']!.private).toString()).toBe('priv');

    const app = await second.state.keys.get('app-state-sync-key', ['AAAA']);
    expect(Buffer.from(app.AAAA!.keyData!).toString()).toBe('kd');
    expect(typeof (app.AAAA as { toJSON?: unknown }).toJSON).toBe('function'); // proto instance
  });

  it('null deletes a key', async () => {
    const db = memDb();
    const { state } = await useSqliteAuthState(db, 'a', testKey());
    await state.keys.set({ session: { x: Buffer.from('1') } });
    await state.keys.set({ session: { x: null } });
    expect((await state.keys.get('session', ['x'])).x).toBeUndefined();
  });

  it('stores values encrypted and detects tampering', async () => {
    const db = memDb();
    const key = testKey();
    const s = await useSqliteAuthState(db, 'a', key);
    await s.saveCreds();
    await s.state.keys.set({ session: { x: Buffer.from('plaintext-marker') } });
    const raw = db.prepare('SELECT value FROM auth_keys').get() as { value: Buffer };
    expect(raw.value.includes(Buffer.from('plaintext-marker'))).toBe(false);

    raw.value[raw.value.length - 1]! ^= 1;
    db.prepare('UPDATE auth_keys SET value = ?').run(raw.value);
    await expect(s.state.keys.get('session', ['x'])).rejects.toThrow();

    const c = db.prepare('SELECT value FROM auth_creds').get() as { value: Buffer };
    c.value[20]! ^= 1;
    db.prepare('UPDATE auth_creds SET value = ?').run(c.value);
    await expect(useSqliteAuthState(db, 'a', key)).rejects.toThrow();
  });

  it('wrong master key cannot decrypt', async () => {
    const db = memDb();
    const s = await useSqliteAuthState(db, 'a', testKey());
    await s.saveCreds();
    await expect(useSqliteAuthState(db, 'a', testKey())).rejects.toThrow();
  });

  it('clear() wipes only this account', async () => {
    const db = memDb();
    const key = testKey();
    const a = await useSqliteAuthState(db, 'a', key);
    const b = await useSqliteAuthState(db, 'b', key);
    await a.saveCreds();
    await b.saveCreds();
    await a.state.keys.set({ session: { x: Buffer.from('1') } });
    await b.state.keys.set({ session: { x: Buffer.from('2') } });
    await a.clear();
    expect(a.hasStoredCreds()).toBe(false);
    expect((await a.state.keys.get('session', ['x'])).x).toBeUndefined();
    expect((await useSqliteAuthState(db, 'a', key)).hasStoredCreds()).toBe(false);
    expect((await b.state.keys.get('session', ['x'])).x).toBeDefined();
    expect((await useSqliteAuthState(db, 'b', key)).hasStoredCreds()).toBe(true);
  });
});
