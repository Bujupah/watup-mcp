import { EventEmitter } from 'node:events';
import type { BaileysEventEmitter, WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { CacheStore, toFtsQuery } from '../src/db/cache.js';
import { attachCacheSync, extractContent } from '../src/whatsapp/cacheSync.js';
import { memDb, silentLogger } from './helpers.js';

const msg = (o: { id: string; jid: string; text?: string; fromMe?: boolean; ts?: number; alt?: string; participant?: string; push?: string; message?: object }): WAMessage =>
  ({
    key: { id: o.id, remoteJid: o.jid, fromMe: !!o.fromMe, ...(o.alt ? { remoteJidAlt: o.alt } : {}), ...(o.participant ? { participant: o.participant } : {}) },
    message: o.message ?? { conversation: o.text ?? '' },
    messageTimestamp: o.ts ?? 1_700_000_000,
    ...(o.push ? { pushName: o.push } : {}),
  }) as WAMessage;

function setup() {
  const db = memDb();
  const cache = new CacheStore(db);
  const ev = new EventEmitter() as unknown as BaileysEventEmitter;
  const detach = attachCacheSync(ev, cache, {
    logger: silentLogger,
    fetchGroupName: async (jid) => `Group ${jid.slice(0, 3)}`,
    groupFetchIntervalMs: 0,
  });
  return { db, cache, ev, detach };
}

describe('extractContent', () => {
  it('extracts text, captions and types', () => {
    expect(extractContent({ conversation: 'hi' })).toEqual({ type: 'text', text: 'hi' });
    expect(extractContent({ extendedTextMessage: { text: 'link' } })).toEqual({ type: 'text', text: 'link' });
    expect(extractContent({ imageMessage: { caption: 'pic' } })).toEqual({ type: 'image', text: 'pic' });
    expect(extractContent({ videoMessage: {} })).toEqual({ type: 'video', text: null });
    expect(extractContent({ audioMessage: {} })).toEqual({ type: 'audio', text: null });
    expect(extractContent({ stickerMessage: {} })).toEqual({ type: 'sticker', text: null });
    expect(extractContent({ documentMessage: { fileName: 'a.pdf' } })).toEqual({ type: 'document', text: 'a.pdf' });
    expect(extractContent({ ephemeralMessage: { message: { conversation: 'eph' } } })).toEqual({ type: 'text', text: 'eph' });
    expect(extractContent({ protocolMessage: {} })).toBeUndefined();
    expect(extractContent(null)).toBeUndefined();
  });
});

describe('attachCacheSync', () => {
  it('persists history: contacts, chats, messages and LID mappings', () => {
    const { ev, cache } = setup();
    ev.emit('messaging-history.set', {
      chats: [{ id: '14155550123@s.whatsapp.net', name: undefined, conversationTimestamp: 1_700_000_100, unreadCount: 2 }],
      contacts: [
        { id: '14155550123@s.whatsapp.net', name: 'Mom' },
        { id: '555@lid', phoneNumber: '447700900123@s.whatsapp.net', notify: 'Dave' },
      ],
      messages: [msg({ id: 'A', jid: '14155550123@s.whatsapp.net', text: 'dinner at eight?' })],
      lidPnMappings: [{ lid: '777@lid', pn: '14155550999@s.whatsapp.net' }],
      isLatest: true,
    });
    expect(cache.getContact('14155550123@s.whatsapp.net')?.name).toBe('Mom');
    expect(cache.getContact('447700900123@s.whatsapp.net')).toMatchObject({ notify: 'Dave', lid: '555@lid', phone: '447700900123' });
    expect(cache.canonical('555@lid')).toBe('447700900123@s.whatsapp.net');
    expect(cache.canonical('777@lid')).toBe('14155550999@s.whatsapp.net');
    expect(cache.getChat('14155550123@s.whatsapp.net')).toMatchObject({ unread: 2, last_message_at: 1_700_000_100_000 });
    expect(cache.readMessages({ chatJid: '14155550123@s.whatsapp.net', limit: 10 })[0]).toMatchObject({ id: 'A', text: 'dinner at eight?' });
    expect(cache.stats()).toEqual({ contacts: 2, chats: 1, messages: 1 });
  });

  it('stores LID-addressed messages under the phone JID when the mapping is known', () => {
    const { ev, cache } = setup();
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [msg({ id: 'L1', jid: '999@lid', alt: '14155550111@s.whatsapp.net', text: 'from lid', push: 'Zed' })],
    });
    const rows = cache.readMessages({ chatJid: '14155550111@s.whatsapp.net', limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chat_jid).toBe('14155550111@s.whatsapp.net');
    expect(cache.displayName('14155550111@s.whatsapp.net')).toBe('Zed');
  });

  it('keeps FTS in sync with inserts, updates and deletes', () => {
    const { ev, cache } = setup();
    const jid = '14155550123@s.whatsapp.net';
    ev.emit('messages.upsert', { type: 'notify', messages: [msg({ id: 'F1', jid, text: 'the quick brown fox' }), msg({ id: 'F2', jid, text: 'lazy dog', ts: 1_700_000_001 })] });
    expect(cache.readMessages({ chatJid: jid, limit: 10, query: 'quick' }).map((m) => m.id)).toEqual(['F1']);
    expect(cache.readMessages({ chatJid: jid, limit: 10, query: 'do' }).map((m) => m.id)).toEqual(['F2']); // prefix
    ev.emit('messages.upsert', { type: 'notify', messages: [msg({ id: 'F1', jid, text: 'edited text' })] });
    expect(cache.readMessages({ chatJid: jid, limit: 10, query: 'quick' })).toHaveLength(0);
    expect(cache.readMessages({ chatJid: jid, limit: 10, query: 'edited' })).toHaveLength(1);
    ev.emit('messages.delete', { keys: [{ remoteJid: jid, id: 'F1' }] });
    expect(cache.readMessages({ chatJid: jid, limit: 10, query: 'edited' })).toHaveLength(0);
    expect(cache.readMessages({ chatJid: jid, limit: 10, query: '"; DROP' })).toHaveLength(0); // safe query
  });

  it('pages with before and orders newest first', () => {
    const { ev, cache } = setup();
    const jid = '14155550123@s.whatsapp.net';
    ev.emit('messages.upsert', { type: 'append', messages: [1, 2, 3, 4].map((i) => msg({ id: `P${i}`, jid, text: `m${i}`, ts: 1_700_000_000 + i })) });
    const page1 = cache.readMessages({ chatJid: jid, limit: 2 });
    expect(page1.map((m) => m.id)).toEqual(['P4', 'P3']);
    const page2 = cache.readMessages({ chatJid: jid, limit: 2, before: page1[1]!.ts! });
    expect(page2.map((m) => m.id)).toEqual(['P2', 'P1']);
  });

  it('fetches group names on first sight and handles chat updates/deletes', async () => {
    const { ev, cache } = setup();
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [msg({ id: 'G1', jid: '120363000000000001@g.us', participant: '14155550123@s.whatsapp.net', text: 'hello group' })],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.getChat('120363000000000001@g.us')).toMatchObject({ name: 'Group 120', is_group: 1 });
    expect(cache.readMessages({ chatJid: '120363000000000001@g.us', limit: 1 })[0]!.sender_jid).toBe('14155550123@s.whatsapp.net');
    ev.emit('chats.update', [{ id: '120363000000000001@g.us', unreadCount: 5 }]);
    expect(cache.getChat('120363000000000001@g.us')?.unread).toBe(5);
    ev.emit('chats.delete', ['120363000000000001@g.us']);
    expect(cache.getChat('120363000000000001@g.us')).toBeUndefined();
  });

  it('ignores status broadcasts and detaches cleanly', () => {
    const { ev, cache, detach } = setup();
    ev.emit('messages.upsert', { type: 'notify', messages: [msg({ id: 'S', jid: 'status@broadcast', text: 'story' })] });
    expect(cache.stats().messages).toBe(0);
    detach();
    ev.emit('messages.upsert', { type: 'notify', messages: [msg({ id: 'X', jid: '14155550123@s.whatsapp.net', text: 'x' })] });
    expect(cache.stats().messages).toBe(0);
  });
});

describe('toFtsQuery', () => {
  it('quotes tokens', () => {
    expect(toFtsQuery('hello world')).toBe('"hello" "world"*');
    expect(toFtsQuery('  ')).toBeUndefined();
    expect(toFtsQuery('a"b')).toBe('"ab"*');
  });
});
