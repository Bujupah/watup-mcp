import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { CacheStore } from '../src/db/cache.js';
import { Guardrails } from '../src/guardrails/index.js';
import { createMcpServer } from '../src/http/mcp.js';
import { QrTokens } from '../src/http/qrTokens.js';
import type { ToolContext } from '../src/tools/index.js';
import { useSqliteAuthState } from '../src/whatsapp/authStore.js';
import { SessionManager } from '../src/whatsapp/session.js';
import { fakeFactory, flush } from './fakeSocket.js';
import { memDb, silentLogger, testKey } from './helpers.js';

const MOM = '14155550123@s.whatsapp.net';

async function setup(opts: { requireConfirm?: boolean; allowlist?: string[]; ratePerMin?: number; newPerDay?: number } = {}) {
  const db = memDb();
  const cache = new CacheStore(db);
  const auth = await useSqliteAuthState(db, 'default', testKey());
  const fake = fakeFactory({ autoQr: true });
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const session = new SessionManager({ auth, cache, logger: silentLogger, socketFactory: fake.factory, pacingMs: [0, 0] });
  const guardrails = new Guardrails(db, cache, {
    allowlist: opts.allowlist ?? [],
    ratePerMin: opts.ratePerMin ?? 10,
    newContactsPerDay: opts.newPerDay ?? 20,
    now: clock.now,
  });
  const ctx: ToolContext = {
    session,
    cache,
    guardrails,
    qrTokens: new QrTokens(),
    logger: silentLogger,
    requireConfirm: opts.requireConfirm ?? true,
    qrUrl: (t) => `http://127.0.0.1:8787/qr?t=${t}`,
  };
  const server = createMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  const json = <T = Record<string, unknown>>(r: CallToolResult): T => {
    const t = text(r);
    return JSON.parse(t.slice(t.indexOf('\n\n') + 2)) as T;
  };

  /** Links via QR using the fake socket and seeds the cache. */
  const link = async () => {
    const r = await call('whatsapp_login');
    fake.last().pairSuccess();
    fake.last().close(515);
    await flush();
    fake.last().open();
    await flush();
    return r;
  };
  const seed = () => {
    cache.upsertContacts([
      { jid: MOM, name: 'Mom' },
      { jid: '14155550124@s.whatsapp.net', name: 'Alex Smith' },
      { jid: '14155550125@s.whatsapp.net', name: 'Alex Jones' },
    ]);
    cache.upsertChats([{ jid: '120363000000000001@g.us', name: 'Family', isGroup: true }]);
    cache.upsertMessages([
      { id: 'm1', chatJid: MOM, fromMe: false, senderJid: MOM, ts: 1000, type: 'text', text: 'Are you coming for dinner?', raw: null },
      { id: 'm2', chatJid: MOM, fromMe: true, senderJid: null, ts: 2000, type: 'text', text: 'Yes, at eight', raw: null },
      { id: 'm3', chatJid: MOM, fromMe: false, senderJid: MOM, ts: 3000, type: 'image', text: null, raw: null },
    ]);
  };
  return { db, cache, session, guardrails, fake, client, call, text, json, link, seed, clock, ctx };
}

describe('tools: auth', () => {
  it('lists the expected tools (no send_message by default)', async () => {
    const t = await setup();
    const names = (await t.client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual([
      'whatsapp_status', 'whatsapp_login', 'whatsapp_logout', 'search_contacts', 'list_chats',
      'read_messages', 'prepare_message', 'prepare_media', 'confirm_send', 'cancel_draft',
    ]);
    const t2 = await setup({ requireConfirm: false });
    expect((await t2.client.listTools()).tools.map((x) => x.name)).toContain('send_message');
  });

  it('status reports disconnected before linking', async () => {
    const t = await setup();
    const r = await t.call('whatsapp_status');
    expect(r.isError).toBeFalsy();
    expect(t.json(r)).toMatchObject({ state: 'disconnected', cacheStats: { contacts: 0, chats: 0, messages: 0 } });
    expect(t.text(r)).toMatch(/whatsapp_login/);
  });

  it('QR login returns an image block and a live URL; then reports already connected', async () => {
    const t = await setup();
    const r = await t.link();
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from((img as { data: string }).data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(t.text(r)).toMatch(/http:\/\/127\.0\.0\.1:8787\/qr\?t=\S+/);
    const token = /qr\?t=(\S+)/.exec(t.text(r))![1]!;
    expect(t.ctx.qrTokens.isValid(token)).toBe(true);
    expect(t.json(await t.call('whatsapp_status'))).toMatchObject({ state: 'connected', linkedAs: '+14155550123' });
    expect(t.text(await t.call('whatsapp_login'))).toMatch(/Already linked/);
  });

  it('pairing code login', async () => {
    const t = await setup();
    const r = await t.call('whatsapp_login', { method: 'pairing_code', phone: '+1 415 555 0123' });
    expect(t.text(r)).toMatch(/ABCD-1234/);
    const bad = await t.call('whatsapp_login', { method: 'pairing_code' });
    expect(bad.isError).toBe(true);
    expect(t.text(bad)).toMatch(/phone number/);
  });

  it('logout requires confirm: true and unlinks', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    const no = await t.call('whatsapp_logout', {});
    expect(no.isError).toBe(true);
    expect(t.text(no)).toMatch(/confirm/);
    const r = await t.call('whatsapp_logout', { confirm: true, wipeCache: true });
    expect(t.text(r)).toMatch(/Unlinked/);
    expect(t.session.isLinked()).toBe(false);
    expect(t.cache.stats().contacts).toBe(0);
  });
});

describe('tools: read', () => {
  it('requires a link', async () => {
    const t = await setup();
    for (const [name, args] of [
      ['search_contacts', { query: 'mom' }],
      ['list_chats', {}],
      ['read_messages', { chat: 'Mom' }],
      ['prepare_message', { to: 'Mom', text: 'hi' }],
    ] as const) {
      const r = await t.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(t.text(r)).toBe('Not linked. Call whatsapp_login.');
    }
  });

  it('validates inputs with zod', async () => {
    const t = await setup();
    const r = await t.call('read_messages', { chat: 'Mom', limit: 0 });
    expect(r.isError).toBe(true);
    expect(t.text(r)).toMatch(/limit/);
    const r2 = await t.call('prepare_message', { to: 'Mom' });
    expect(r2.isError).toBe(true);
    expect(t.text(r2)).toMatch(/text/);
  });

  it('search_contacts fuzzy-matches names and phone digits', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    const r = t.json<Array<{ name: string; jid: string; phone: string }>>(await t.call('search_contacts', { query: 'alex' }));
    expect(r.map((x) => x.name).sort()).toEqual(['Alex Jones', 'Alex Smith']);
    const byPhone = t.json<Array<{ name: string }>>(await t.call('search_contacts', { query: '555 0123' }));
    expect(byPhone[0]!.name).toBe('Mom');
    const grp = t.json<Array<{ name: string; isGroup: boolean }>>(await t.call('search_contacts', { query: 'fam' }));
    expect(grp[0]).toMatchObject({ name: 'Family', isGroup: true });
    expect(t.text(await t.call('search_contacts', { query: 'zzzz' }))).toMatch(/No contacts/);
  });

  it('list_chats shows previews', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    const chats = t.json<Array<{ name: string; lastMessage: { preview: string } | null }>>(await t.call('list_chats', {}));
    const mom = chats.find((c) => c.name === 'Mom')!;
    expect(mom.lastMessage?.preview).toBe('[image]');
  });

  it('read_messages by name, phone, with FTS and paging', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    const r = t.json<{ messages: Array<{ id: string; from: string; text: string }> }>(await t.call('read_messages', { chat: 'mom' }));
    expect(r.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(r.messages[0]!.from).toBe('Mom');
    expect(r.messages[1]!.from).toBe('me');
    expect(r.messages[2]!.text).toBe('[image]');
    const byPhone = t.json<{ messages: unknown[] }>(await t.call('read_messages', { chat: '+1 415 555 0123', query: 'dinner' }));
    expect(byPhone.messages).toHaveLength(1);
    const paged = t.json<{ messages: Array<{ id: string }>; nextBefore: number }>(await t.call('read_messages', { chat: MOM, limit: 2 }));
    expect(paged.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    const older = t.json<{ messages: Array<{ id: string }> }>(await t.call('read_messages', { chat: MOM, limit: 2, before: paged.nextBefore }));
    expect(older.messages.map((m) => m.id)).toEqual(['m1']);
    const amb = await t.call('read_messages', { chat: 'Alex' });
    expect(amb.isError).toBe(true);
    const unknown = await t.call('read_messages', { chat: 'Alex Smyth' });
    expect(t.text(unknown)).toMatch(/search_contacts.*Alex Smith/s);
    const ambExact = await t.call('read_messages', { chat: 'alex smith' });
    expect(ambExact.isError).toBeFalsy();
  });
});

describe('tools: send', () => {
  it('prepare → confirm sends once; second confirm fails', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    const p = await t.call('prepare_message', { to: 'Mom', text: 'On my way' });
    expect(p.isError).toBeFalsy();
    const d = t.json<{ draftId: string; jid: string; resolvedName: string; preview: string; firstMessageToThisRecipient: boolean }>(p);
    expect(d).toMatchObject({ jid: MOM, resolvedName: 'Mom', preview: 'On my way', firstMessageToThisRecipient: false });
    expect(t.fake.last().sent).toHaveLength(0); // nothing sent yet
    const c = await t.call('confirm_send', { draftId: d.draftId });
    expect(c.isError).toBeFalsy();
    expect(t.json(c)).toMatchObject({ messageId: 'MSG1', jid: MOM });
    expect(t.fake.last().sent).toEqual([{ jid: MOM, content: { text: 'On my way' } }]);
    const again = await t.call('confirm_send', { draftId: d.draftId });
    expect(again.isError).toBe(true);
    expect(t.text(again)).toMatch(/already sent/);
    expect(t.fake.last().sent).toHaveLength(1);
    const actions = t.guardrails.audit.latest().map((a) => `${a.action}:${a.result}`).reverse();
    expect(actions).toEqual(expect.arrayContaining(['prepare:ok', 'confirm:ok', 'send:ok', 'confirm:rejected']));
  });

  it('expired and cancelled drafts cannot be sent', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    const d1 = t.json<{ draftId: string }>(await t.call('prepare_message', { to: MOM, text: 'a' }));
    t.clock.advance(10 * 60_000 + 1);
    expect(t.text(await t.call('confirm_send', { draftId: d1.draftId }))).toMatch(/expired/);
    const d2 = t.json<{ draftId: string }>(await t.call('prepare_message', { to: MOM, text: 'b' }));
    expect(t.text(await t.call('cancel_draft', { draftId: d2.draftId }))).toMatch(/cancelled/);
    expect(t.text(await t.call('confirm_send', { draftId: d2.draftId }))).toMatch(/cancelled/);
    expect((await t.call('confirm_send', { draftId: 'nope' })).isError).toBe(true);
    expect(t.fake.last().sent).toHaveLength(0);
  });

  it('enforces the allowlist', async () => {
    const t = await setup({ allowlist: ['+14155550123'] });
    await t.link();
    t.seed();
    expect((await t.call('prepare_message', { to: 'Mom', text: 'ok' })).isError).toBeFalsy();
    const r = await t.call('prepare_message', { to: 'Alex Smith', text: 'no' });
    expect(r.isError).toBe(true);
    expect(t.text(r)).toMatch(/not on the allowlist.*WA_MCP_ALLOWLIST/s);
  });

  it('enforces the per-minute rate limit with a retry time', async () => {
    const t = await setup({ ratePerMin: 2 });
    await t.link();
    t.seed();
    for (let i = 0; i < 2; i++) {
      const d = t.json<{ draftId: string }>(await t.call('prepare_message', { to: MOM, text: `m${i}` }));
      expect((await t.call('confirm_send', { draftId: d.draftId })).isError).toBeFalsy();
    }
    const r = await t.call('prepare_message', { to: MOM, text: 'too many' });
    expect(r.isError).toBe(true);
    expect(t.text(r)).toMatch(/Rate limit.*Try again in 30s/s);
  });

  it('re-checks the rate limit at confirm time and keeps the draft usable', async () => {
    const t = await setup({ ratePerMin: 1 });
    await t.link();
    t.seed();
    const d1 = t.json<{ draftId: string }>(await t.call('prepare_message', { to: MOM, text: '1' }));
    const d2 = t.json<{ draftId: string }>(await t.call('prepare_message', { to: MOM, text: '2' }));
    expect((await t.call('confirm_send', { draftId: d1.draftId })).isError).toBeFalsy();
    expect(t.text(await t.call('confirm_send', { draftId: d2.draftId }))).toMatch(/Rate limit/);
    t.clock.advance(60_000);
    expect((await t.call('confirm_send', { draftId: d2.draftId })).isError).toBeFalsy();
  });

  it('limits new recipients per day', async () => {
    const t = await setup({ newPerDay: 1 });
    await t.link();
    t.fake.last().registered.add('14155550901');
    t.fake.last().registered.add('14155550902');
    const d = t.json<{ draftId: string; firstMessageToThisRecipient: boolean }>(await t.call('prepare_message', { to: '+14155550901', text: 'hi' }));
    expect(d.firstMessageToThisRecipient).toBe(true);
    expect((await t.call('confirm_send', { draftId: d.draftId })).isError).toBeFalsy();
    const r = await t.call('prepare_message', { to: '+14155550902', text: 'hi' });
    expect(t.text(r)).toMatch(/New-contact limit/);
    // the already-messaged one is fine
    expect((await t.call('prepare_message', { to: '+14155550901', text: 'again' })).isError).toBeFalsy();
  });

  it('rejects numbers not on WhatsApp and overlong messages', async () => {
    const t = await setup();
    await t.link();
    const r = await t.call('prepare_message', { to: '+14155550999', text: 'hi' });
    expect(t.text(r)).toMatch(/not registered on WhatsApp/);
    t.seed();
    const long = await t.call('prepare_message', { to: MOM, text: 'x'.repeat(5000) });
    expect(t.text(long)).toMatch(/limit is 4096.*Split/s);
  });

  it('send_message (no-confirm mode) sends in one step', async () => {
    const t = await setup({ requireConfirm: false });
    await t.link();
    t.seed();
    const r = await t.call('send_message', { to: 'Mom', text: 'quick one' });
    expect(r.isError).toBeFalsy();
    expect(t.fake.last().sent).toHaveLength(1);
  });

  it('confirm_send fails cleanly when disconnected', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    const d = t.json<{ draftId: string }>(await t.call('prepare_message', { to: MOM, text: 'x' }));
    await t.session.stop();
    const r = await t.call('confirm_send', { draftId: d.draftId });
    expect(r.isError).toBe(true);
    expect(t.text(r)).toMatch(/not connected/);
  });
});

describe('tools: media', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

  it('prepare_media previews an image, then confirm_send sends it once with its caption', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    t.ctx.fetchMedia = async (_url, kind) => ({ kind, data: PNG, mimetype: 'image/png', fileName: 'cat.png' });
    const p = await t.call('prepare_media', { to: 'Mom', url: 'https://ex.com/cat.png', kind: 'image', caption: 'Look!' });
    expect(p.isError).toBeFalsy();
    expect(p.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const d = t.json<{ draftId: string; kind: string; fileName: string; caption: string }>({ content: p.content.slice(1) } as CallToolResult);
    expect(d).toMatchObject({ kind: 'image', fileName: 'cat.png', caption: 'Look!' });
    expect(t.fake.last().sent).toHaveLength(0);

    expect((await t.call('confirm_send', { draftId: d.draftId })).isError).toBeFalsy();
    const sent = t.fake.last().sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.jid).toBe(MOM);
    const content = sent[0]!.content as { image: Buffer; caption: string; mimetype: string };
    expect(Buffer.from(content.image).equals(PNG)).toBe(true);
    expect(content).toMatchObject({ caption: 'Look!', mimetype: 'image/png' });
    expect((await t.call('confirm_send', { draftId: d.draftId })).isError).toBe(true);
  });

  it('sends documents with their file name and surfaces download errors', async () => {
    const t = await setup();
    await t.link();
    t.seed();
    t.ctx.fetchMedia = async (url, kind) => {
      if (url.includes('song')) {
        const { MediaError } = await import('../src/media/fetchMedia.js');
        throw new MediaError('Audio and video files are not supported. Send an image or a document.');
      }
      return { kind, data: Buffer.from('%PDF-1.7'), mimetype: 'application/pdf', fileName: 'invoice.pdf' };
    };
    const bad = await t.call('prepare_media', { to: MOM, url: 'https://ex.com/song.mp3', kind: 'document' });
    expect(bad.isError).toBe(true);
    expect(t.text(bad)).toMatch(/Audio and video files are not supported/);
    const d = t.json<{ draftId: string }>(await t.call('prepare_media', { to: MOM, url: 'https://ex.com/invoice.pdf', kind: 'document' }));
    await t.call('confirm_send', { draftId: d.draftId });
    expect(t.fake.last().sent[0]!.content).toMatchObject({ fileName: 'invoice.pdf', mimetype: 'application/pdf' });
  });
});
