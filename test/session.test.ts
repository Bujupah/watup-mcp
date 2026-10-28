import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheStore } from '../src/db/cache.js';
import { useSqliteAuthState } from '../src/whatsapp/authStore.js';
import { SessionManager, type SessionManagerOptions } from '../src/whatsapp/session.js';
import { fakeFactory, flush } from './fakeSocket.js';
import { memDb, silentLogger, testKey } from './helpers.js';

async function setup(over: Partial<SessionManagerOptions> = {}) {
  const db = memDb();
  const key = testKey();
  const auth = await useSqliteAuthState(db, 'default', key);
  const fake = fakeFactory();
  const session = new SessionManager({
    auth,
    cache: new CacheStore(db),
    logger: silentLogger,
    socketFactory: fake.factory,
    pacingMs: [0, 0],
    backoffBaseMs: 1000,
    random: () => 0.5,
    ...over,
  });
  return { db, key, auth, fake, session };
}

/** Runs the QR flow up to a connected session. */
async function linkViaQr(ctx: Awaited<ReturnType<typeof setup>>) {
  const p = ctx.session.login({ method: 'qr' });
  await flush();
  ctx.fake.last().qr('QR-1');
  const res = await p;
  ctx.fake.last().pairSuccess();
  ctx.fake.last().close(515);
  await flush();
  ctx.fake.last().open();
  await flush();
  return res;
}

afterEach(() => vi.useRealTimers());

describe('SessionManager', () => {
  it('stays disconnected on boot when not linked (no QR spam)', async () => {
    const { session, fake } = await setup();
    await session.start();
    expect(session.getState()).toBe('disconnected');
    expect(fake.sockets).toHaveLength(0);
  });

  it('QR login → restartRequired → connected, and creds persisted', async () => {
    const ctx = await setup();
    const states: string[] = [];
    ctx.session.on('state', (s) => states.push(s.state));
    const res = await linkViaQr(ctx);
    expect(res).toMatchObject({ status: 'qr', qr: 'QR-1' });
    expect(ctx.fake.sockets).toHaveLength(2); // recreated after 515
    expect(ctx.session.getState()).toBe('connected');
    expect(ctx.session.getStatus().linkedAs).toBe('+14155550123');
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual(['connecting', 'awaiting_scan', 'connecting', 'connected']);
    expect(ctx.auth.hasStoredCreds()).toBe(true);
  });

  it('QR rotation updates the current QR and emits qr events', async () => {
    const ctx = await setup();
    const seen: string[] = [];
    ctx.session.on('qr', (q) => seen.push(q));
    const p = ctx.session.login({ method: 'qr' });
    await flush();
    ctx.fake.last().qr('QR-1');
    await p;
    ctx.fake.last().qr('QR-2');
    expect(seen).toEqual(['QR-1', 'QR-2']);
    expect(ctx.session.getCurrentQr()).toBe('QR-2');
    expect(ctx.session.getStatus().qrAvailable).toBe(true);
  });

  it('reconnects silently with stored creds after restart', async () => {
    const ctx = await setup();
    await linkViaQr(ctx);
    // New process, same DB.
    const auth2 = await useSqliteAuthState(ctx.db, 'default', ctx.key);
    const fake2 = fakeFactory();
    const s2 = new SessionManager({ auth: auth2, cache: new CacheStore(ctx.db), logger: silentLogger, socketFactory: fake2.factory });
    await s2.start();
    expect(s2.getState()).toBe('connecting');
    fake2.last().open();
    await flush();
    expect(s2.getState()).toBe('connected');
  });

  it('loggedOut wipes creds and returns to disconnected', async () => {
    const ctx = await setup();
    await linkViaQr(ctx);
    const states: string[] = [];
    ctx.session.on('state', (s) => states.push(s.state));
    ctx.fake.last().close(401);
    await flush();
    expect(states).toEqual(['logged_out', 'disconnected']);
    expect(ctx.session.isLinked()).toBe(false);
    expect(ctx.auth.hasStoredCreds()).toBe(false);
    expect((await useSqliteAuthState(ctx.db, 'default', ctx.key)).hasStoredCreds()).toBe(false);
    expect(ctx.session.getStatus().lastError).toMatch(/unlinked/);
  });

  it('transient close reconnects with exponential backoff, reset after open', async () => {
    const ctx = await setup();
    await linkViaQr(ctx);
    vi.useFakeTimers();
    const n = ctx.fake.sockets.length;
    ctx.fake.last().close(428);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.session.getState()).toBe('connecting');
    expect(ctx.session.reconnectAttempt).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(ctx.fake.sockets.length).toBe(n);
    await vi.advanceTimersByTimeAsync(2);
    expect(ctx.fake.sockets.length).toBe(n + 1);
    // second failure: 2s
    ctx.fake.last().close(408);
    await vi.advanceTimersByTimeAsync(1999);
    expect(ctx.fake.sockets.length).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(2);
    expect(ctx.fake.sockets.length).toBe(n + 2);
    ctx.fake.last().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.session.getState()).toBe('connected');
    expect(ctx.session.reconnectAttempt).toBe(0);
  });

  it('backoff is capped at 60s', async () => {
    const ctx = await setup({ random: () => 1 });
    await linkViaQr(ctx);
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) {
      ctx.fake.last().close(500);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const before = ctx.fake.sockets.length;
    ctx.fake.last().close(500);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.fake.sockets.length).toBe(before + 1);
  });

  it('connectionReplaced (440) stops without reconnect loop and keeps creds', async () => {
    const ctx = await setup();
    await linkViaQr(ctx);
    vi.useFakeTimers();
    const n = ctx.fake.sockets.length;
    ctx.fake.last().close(440);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ctx.fake.sockets.length).toBe(n);
    expect(ctx.session.getState()).toBe('disconnected');
    expect(ctx.session.getStatus().lastError).toMatch(/another client/);
    expect(ctx.session.isLinked()).toBe(true);
  });

  it('QR timeout without scan returns to disconnected', async () => {
    const ctx = await setup({ scanTimeoutMs: 5000 });
    vi.useFakeTimers();
    const p = ctx.session.login({ method: 'qr' });
    await vi.advanceTimersByTimeAsync(0);
    ctx.fake.last().qr('QR-1');
    await p;
    expect(ctx.session.getState()).toBe('awaiting_scan');
    await vi.advanceTimersByTimeAsync(5001);
    expect(ctx.session.getState()).toBe('disconnected');
    expect(ctx.fake.last().ended).toBe(true);
    expect(ctx.session.getCurrentQr()).toBeUndefined();
  });

  it('closing during an unlinked QR session does not reconnect', async () => {
    const ctx = await setup();
    vi.useFakeTimers();
    const p = ctx.session.login({ method: 'qr' });
    await vi.advanceTimersByTimeAsync(0);
    ctx.fake.last().qr();
    await p;
    ctx.fake.last().close(408); // Baileys: QR refs attempts ended
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ctx.fake.sockets).toHaveLength(1);
    expect(ctx.session.getState()).toBe('disconnected');
  });

  it('login fails clearly when no QR arrives', async () => {
    const ctx = await setup({ firstQrTimeoutMs: 1000 });
    vi.useFakeTimers();
    const p = ctx.session.login({ method: 'qr' });
    const assertion = expect(p).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(ctx.session.getState()).toBe('disconnected');
  });

  it('pairing code login requests a code for the normalized phone', async () => {
    const ctx = await setup();
    const p = ctx.session.login({ method: 'pairing_code', phone: '+1 (415) 555-0123' });
    await flush();
    ctx.fake.last().qr();
    const res = await p;
    expect(res).toMatchObject({ status: 'pairing_code', pairingCode: 'ABCD1234' });
    expect(ctx.fake.last().pairingCodeRequests).toEqual(['14155550123']);
    expect(ctx.session.getStatus()).toMatchObject({ state: 'awaiting_scan', pairingCode: 'ABCD1234', qrAvailable: false });
    expect(ctx.session.getCurrentQr()).toBeUndefined();
  });

  it('pairing code requires a phone', async () => {
    const ctx = await setup();
    await expect(ctx.session.login({ method: 'pairing_code' })).rejects.toThrow(/phone/);
  });

  it('login when connected says so', async () => {
    const ctx = await setup();
    await linkViaQr(ctx);
    expect(await ctx.session.login({ method: 'qr' })).toEqual({ status: 'already_connected' });
  });

  it('logout calls sock.logout and wipes creds', async () => {
    const ctx = await setup();
    await linkViaQr(ctx);
    const sock = ctx.fake.last();
    const res = await ctx.session.logout();
    expect(res.remoteUnlinked).toBe(true);
    expect(sock.loggedOut).toBe(true);
    expect(ctx.session.getState()).toBe('disconnected');
    expect(ctx.session.isLinked()).toBe(false);
    expect(ctx.auth.hasStoredCreds()).toBe(false);
  });

  it('sendText requires a connection and serializes sends', async () => {
    const ctx = await setup();
    await expect(ctx.session.sendText('1@s.whatsapp.net', 'x')).rejects.toThrow(/Not linked/);
    await linkViaQr(ctx);
    const [a, b] = await Promise.all([
      ctx.session.sendText('14155550199@s.whatsapp.net', 'one'),
      ctx.session.sendText('14155550199@s.whatsapp.net', 'two'),
    ]);
    expect(a.id).toBe('MSG1');
    expect(b.id).toBe('MSG2');
    expect(ctx.fake.last().sent.map((s) => (s.content as { text: string }).text)).toEqual(['one', 'two']);
    expect(ctx.fake.last().presences).toContain('composing');
  });

  it('onWhatsApp checks registration', async () => {
    const ctx = await setup();
    await linkViaQr(ctx);
    ctx.fake.last().registered.add('14155550199');
    expect(await ctx.session.onWhatsApp('+1 415 555 0199')).toEqual({ exists: true, jid: '14155550199@s.whatsapp.net' });
    expect(await ctx.session.onWhatsApp('+1 415 555 0100')).toEqual({ exists: false });
  });
});
