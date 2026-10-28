import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { usePgAuthState, type PgDatabase } from '../src/whatsapp/pgAuthStore.js';
import { testKey } from './helpers.js';

const pglite = (): PgDatabase & { raw: PGlite } => {
  const raw = new PGlite();
  return {
    raw,
    query: async <R extends object>(text: string, params?: unknown[]) => ({ rows: (await raw.query<R>(text, params)).rows }),
    transaction: (fn) =>
      raw.transaction((tx) => fn({ query: async <R extends object>(t: string, p?: unknown[]) => ({ rows: (await tx.query<R>(t, p)).rows }) })),
  };
};

describe('usePgAuthState', () => {
  it('round-trips creds and keys (including Buffers and proto keys) across instances', async () => {
    const db = pglite();
    const key = testKey();
    const first = await usePgAuthState(db, 'a', key);
    expect(first.hasStoredCreds()).toBe(false);
    first.state.creds.registered = true;
    await first.saveCreds();
    const session = Buffer.from([0, 1, 2, 250, 255]);
    await first.state.keys.set({
      session: { 'peer.0': session, 'peer.1': Buffer.from('x') },
      'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } },
      'app-state-sync-key': { K1: { keyData: Buffer.from('kd'), timestamp: 3 } },
    });

    const second = await usePgAuthState(db, 'a', key); // e.g. after a restart
    expect(second.hasStoredCreds()).toBe(true);
    expect(second.state.creds.registered).toBe(true);
    expect(Buffer.from(second.state.creds.noiseKey.private).equals(Buffer.from(first.state.creds.noiseKey.private))).toBe(true);
    const s = await second.state.keys.get('session', ['peer.0', 'missing']);
    expect(Buffer.from(s['peer.0']!).equals(session)).toBe(true);
    expect(s.missing).toBeUndefined();
    expect(Buffer.from((await second.state.keys.get('pre-key', ['1']))['1']!.private).toString()).toBe('priv');
    const app = await second.state.keys.get('app-state-sync-key', ['K1']);
    expect(typeof (app.K1 as { toJSON?: unknown }).toJSON).toBe('function');
    expect(await second.state.keys.get('session', [])).toEqual({});
  });

  it('batches large key sets, deletes nulls, and stores only ciphertext', async () => {
    const db = pglite();
    const s = await usePgAuthState(db, 'a', testKey());
    const many: Record<string, { public: Buffer; private: Buffer }> = {};
    for (let i = 0; i < 900; i++) many[String(i)] = { public: Buffer.from(`pub${i}`), private: Buffer.from(`secret-marker-${i}`) };
    await s.state.keys.set({ 'pre-key': many });
    expect((await db.raw.query<{ n: number }>('SELECT count(*)::int AS n FROM whatsapp_mcp.auth_keys')).rows[0]!.n).toBe(900);
    const raw = (await db.raw.query<{ value: Uint8Array }>('SELECT value FROM whatsapp_mcp.auth_keys LIMIT 1')).rows[0]!.value;
    expect(Buffer.from(raw).includes(Buffer.from('secret-marker'))).toBe(false);
    await s.state.keys.set({ 'pre-key': { '0': null, '1': null } });
    expect(Object.keys(await s.state.keys.get('pre-key', ['0', '1', '2']))).toEqual(['2']);
  });

  it('detects tampering and a wrong master key', async () => {
    const db = pglite();
    const key = testKey();
    const s = await usePgAuthState(db, 'a', key);
    await s.saveCreds();
    await expect(usePgAuthState(db, 'a', testKey())).rejects.toThrow();
    await db.raw.query("UPDATE whatsapp_mcp.auth_creds SET value = set_byte(value, 20, get_byte(value, 20) # 1)");
    await expect(usePgAuthState(db, 'a', key)).rejects.toThrow();
  });

  it('clear() wipes only this account', async () => {
    const db = pglite();
    const key = testKey();
    const a = await usePgAuthState(db, 'a', key);
    const b = await usePgAuthState(db, 'b', key);
    await a.saveCreds();
    await b.saveCreds();
    await a.state.keys.set({ session: { x: Buffer.from('1') } });
    await b.state.keys.set({ session: { x: Buffer.from('2') } });
    await a.clear();
    expect(a.hasStoredCreds()).toBe(false);
    expect((await usePgAuthState(db, 'a', key)).hasStoredCreds()).toBe(false);
    expect((await b.state.keys.get('session', ['x'])).x).toBeDefined();
    expect((await usePgAuthState(db, 'b', key)).hasStoredCreds()).toBe(true);
  });
});
