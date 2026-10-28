import type { DB } from './db.js';
import { isGroupJid, isLidJid, phoneFromJid } from '../whatsapp/jid.js';

export interface ContactRow {
  jid: string;
  name: string | null;
  notify: string | null;
  phone: string | null;
  lid: string | null;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  last_message_at: number | null;
  unread: number;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  from_me: number;
  sender_jid: string | null;
  ts: number | null;
  type: string | null;
  text: string | null;
}

export interface ChatSummary extends ChatRow {
  last_text: string | null;
  last_type: string | null;
  last_from_me: number | null;
}

export interface ContactUpsert {
  jid: string;
  name?: string | null;
  notify?: string | null;
  phone?: string | null;
  lid?: string | null;
}

export interface ChatUpsert {
  jid: string;
  name?: string | null;
  isGroup?: boolean;
  lastMessageAt?: number | null;
  unread?: number | null;
}

export interface MessageUpsert {
  id: string;
  chatJid: string;
  fromMe: boolean;
  senderJid: string | null;
  ts: number | null;
  type: string;
  text: string | null;
  raw: Buffer | null;
}

export interface CacheStats {
  contacts: number;
  chats: number;
  messages: number;
}

/** Turns free text into a safe FTS5 query: every token is quoted and AND-ed; the last one is a prefix match. */
export function toFtsQuery(input: string): string | undefined {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

/** Read/write access to the local WhatsApp cache (contacts, chats, messages, LID map). */
export class CacheStore {
  private readonly stmts;

  constructor(private readonly db: DB) {
    this.stmts = {
      upsertContact: db.prepare<{ jid: string; name: string | null; notify: string | null; phone: string | null; lid: string | null; now: number }>(
        `INSERT INTO contacts (jid, name, notify, phone, lid, updated_at) VALUES (@jid, @name, @notify, @phone, @lid, @now)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           notify = COALESCE(excluded.notify, contacts.notify),
           phone = COALESCE(excluded.phone, contacts.phone),
           lid = COALESCE(excluded.lid, contacts.lid),
           updated_at = excluded.updated_at`,
      ),
      upsertChat: db.prepare<{ jid: string; name: string | null; isGroup: number; last: number | null; unread: number | null }>(
        `INSERT INTO chats (jid, name, is_group, last_message_at, unread) VALUES (@jid, @name, @isGroup, @last, COALESCE(@unread, 0))
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           last_message_at = MAX(COALESCE(chats.last_message_at, 0), COALESCE(excluded.last_message_at, 0)),
           unread = COALESCE(@unread, chats.unread)`,
      ),
      deleteChat: db.prepare<[string]>('DELETE FROM chats WHERE jid = ?'),
      upsertMessage: db.prepare<{
        id: string;
        chatJid: string;
        fromMe: number;
        senderJid: string | null;
        ts: number | null;
        type: string;
        text: string | null;
        raw: Buffer | null;
      }>(
        `INSERT INTO messages (id, chat_jid, from_me, sender_jid, ts, type, text, raw)
         VALUES (@id, @chatJid, @fromMe, @senderJid, @ts, @type, @text, @raw)
         ON CONFLICT(chat_jid, id) DO UPDATE SET
           from_me = excluded.from_me,
           sender_jid = COALESCE(excluded.sender_jid, messages.sender_jid),
           ts = COALESCE(excluded.ts, messages.ts),
           type = excluded.type,
           text = COALESCE(excluded.text, messages.text),
           raw = COALESCE(excluded.raw, messages.raw)`,
      ),
      deleteMessage: db.prepare<[string, string]>('DELETE FROM messages WHERE chat_jid = ? AND id = ?'),
      deleteChatMessages: db.prepare<[string]>('DELETE FROM messages WHERE chat_jid = ?'),
      upsertLid: db.prepare<[string, string]>(
        'INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn',
      ),
      pnForLid: db.prepare<[string], { pn: string }>('SELECT pn FROM lid_map WHERE lid = ?'),
      lidsForPn: db.prepare<[string], { lid: string }>('SELECT lid FROM lid_map WHERE pn = ?'),
      getRaw: db.prepare<[string, string], { raw: Buffer | null }>('SELECT raw FROM messages WHERE chat_jid = ? AND id = ?'),
      getRawById: db.prepare<[string], { raw: Buffer | null }>('SELECT raw FROM messages WHERE id = ? LIMIT 1'),
      allContacts: db.prepare<[], ContactRow>('SELECT jid, name, notify, phone, lid FROM contacts'),
      contactByJid: db.prepare<[string], ContactRow>('SELECT jid, name, notify, phone, lid FROM contacts WHERE jid = ?'),
      chatByJid: db.prepare<[string], ChatRow>('SELECT jid, name, is_group, last_message_at, unread FROM chats WHERE jid = ?'),
      groupChatsByName: db.prepare<[string], ChatRow>(
        'SELECT jid, name, is_group, last_message_at, unread FROM chats WHERE is_group = 1 AND name = ? COLLATE NOCASE',
      ),
      hasSentTo: db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND from_me = 1'),
      stats: db.prepare<[], CacheStats>(
        `SELECT (SELECT COUNT(*) FROM contacts) AS contacts, (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages) AS messages`,
      ),
    };
  }

  // ---- LID mapping -------------------------------------------------------

  setLidMapping(lid: string, pn: string): void {
    if (!isLidJid(lid) || !phoneFromJid(pn)) return;
    this.stmts.upsertLid.run(lid, `${phoneFromJid(pn)}@s.whatsapp.net`);
  }

  pnForLid(lid: string): string | undefined {
    return this.stmts.pnForLid.get(lid)?.pn;
  }

  /** Maps a LID JID to its phone-number JID when known; returns other JIDs unchanged. */
  canonical(jid: string): string {
    if (isLidJid(jid)) return this.pnForLid(jid) ?? jid;
    return jid;
  }

  /** Every JID this chat might be stored under (phone JID plus any known LIDs). */
  aliases(jid: string): string[] {
    const c = this.canonical(jid);
    const out = new Set([jid, c]);
    if (phoneFromJid(c)) for (const r of this.stmts.lidsForPn.all(c)) out.add(r.lid);
    return [...out];
  }

  // ---- writes ------------------------------------------------------------

  upsertContacts(rows: ContactUpsert[]): void {
    const now = Date.now();
    this.db.transaction(() => {
      for (const r of rows) {
        let jid = r.jid;
        let lid = r.lid ?? null;
        if (isLidJid(jid)) {
          lid = jid;
          const pn = r.phone && phoneFromJid(r.phone) ? r.phone : this.pnForLid(jid);
          if (pn) {
            this.setLidMapping(jid, pn);
            jid = `${phoneFromJid(pn)}@s.whatsapp.net`;
          }
        } else if (lid && isLidJid(lid)) {
          this.setLidMapping(lid, jid);
        }
        const phone = phoneFromJid(jid) ?? (r.phone ? phoneFromJid(r.phone) : undefined) ?? null;
        this.stmts.upsertContact.run({
          jid,
          name: clean(r.name),
          notify: clean(r.notify),
          phone,
          lid,
          now,
        });
      }
    })();
  }

  upsertChats(rows: ChatUpsert[]): void {
    this.db.transaction(() => {
      for (const r of rows) {
        const jid = this.canonical(r.jid);
        this.stmts.upsertChat.run({
          jid,
          name: clean(r.name),
          isGroup: (r.isGroup ?? isGroupJid(jid)) ? 1 : 0,
          last: r.lastMessageAt ?? null,
          unread: r.unread ?? null,
        });
      }
    })();
  }

  deleteChats(jids: string[]): void {
    this.db.transaction(() => {
      for (const j of jids) for (const a of this.aliases(j)) this.stmts.deleteChat.run(a);
    })();
  }

  upsertMessages(rows: MessageUpsert[]): void {
    this.db.transaction(() => {
      for (const r of rows) {
        const chatJid = this.canonical(r.chatJid);
        this.stmts.upsertMessage.run({
          id: r.id,
          chatJid,
          fromMe: r.fromMe ? 1 : 0,
          senderJid: r.senderJid ? this.canonical(r.senderJid) : null,
          ts: r.ts,
          type: r.type,
          text: r.text,
          raw: r.raw,
        });
        this.stmts.upsertChat.run({ jid: chatJid, name: null, isGroup: isGroupJid(chatJid) ? 1 : 0, last: r.ts, unread: null });
      }
    })();
  }

  deleteMessages(keys: Array<{ chatJid: string; id: string }>): void {
    this.db.transaction(() => {
      for (const k of keys) for (const a of this.aliases(k.chatJid)) this.stmts.deleteMessage.run(a, k.id);
    })();
  }

  clearChatMessages(chatJid: string): void {
    for (const a of this.aliases(chatJid)) this.stmts.deleteChatMessages.run(a);
  }

  /** Wipes contacts, chats, messages and the LID map. */
  wipe(): void {
    this.db.exec(`DELETE FROM messages; DELETE FROM chats; DELETE FROM contacts; DELETE FROM lid_map;
                  INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');`);
  }

  // ---- reads -------------------------------------------------------------

  getRawMessage(chatJid: string | undefined, id: string): Buffer | undefined {
    if (chatJid) {
      for (const a of this.aliases(chatJid)) {
        const r = this.stmts.getRaw.get(a, id);
        if (r?.raw) return r.raw;
      }
      return undefined;
    }
    return this.stmts.getRawById.get(id)?.raw ?? undefined;
  }

  stats(): CacheStats {
    return this.stmts.stats.get()!;
  }

  allContacts(): ContactRow[] {
    return this.stmts.allContacts.all();
  }

  getContact(jid: string): ContactRow | undefined {
    return this.stmts.contactByJid.get(this.canonical(jid));
  }

  getChat(jid: string): ChatRow | undefined {
    for (const a of this.aliases(jid)) {
      const c = this.stmts.chatByJid.get(a);
      if (c) return c;
    }
    return undefined;
  }

  groupChatsByName(name: string): ChatRow[] {
    return this.stmts.groupChatsByName.all(name);
  }

  /** Best display name we know for a JID. */
  displayName(jid: string): string | undefined {
    const c = this.getContact(jid);
    if (c?.name || c?.notify) return (c.name ?? c.notify)!;
    const chat = this.getChat(jid);
    return chat?.name ?? undefined;
  }

  hasMessagedBefore(jid: string): boolean {
    return this.aliases(jid).some((a) => this.stmts.hasSentTo.get(a)!.n > 0);
  }

  listChats(opts: { limit: number; unreadOnly: boolean }): ChatSummary[] {
    const sql = `
      SELECT c.jid, c.name, c.is_group, c.last_message_at, c.unread,
             m.text AS last_text, m.type AS last_type, m.from_me AS last_from_me
      FROM chats c
      LEFT JOIN messages m ON m.rowid = (
        SELECT rowid FROM messages WHERE chat_jid = c.jid ORDER BY ts DESC LIMIT 1
      )
      ${opts.unreadOnly ? 'WHERE c.unread > 0' : ''}
      ORDER BY COALESCE(c.last_message_at, 0) DESC
      LIMIT ?`;
    return this.db.prepare<[number], ChatSummary>(sql).all(opts.limit);
  }

  readMessages(opts: { chatJid: string; limit: number; before?: number; query?: string }): MessageRow[] {
    const aliases = this.aliases(opts.chatJid);
    const placeholders = aliases.map(() => '?').join(',');
    const params: Array<string | number> = [...aliases];
    let sql: string;
    const fts = opts.query ? toFtsQuery(opts.query) : undefined;
    if (fts) {
      sql = `SELECT m.id, m.chat_jid, m.from_me, m.sender_jid, m.ts, m.type, m.text
             FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
             WHERE messages_fts MATCH ? AND m.chat_jid IN (${placeholders})`;
      params.unshift(fts);
    } else {
      sql = `SELECT id, chat_jid, from_me, sender_jid, ts, type, text FROM messages m WHERE m.chat_jid IN (${placeholders})`;
    }
    if (opts.before !== undefined) {
      sql += ' AND m.ts < ?';
      params.push(opts.before);
    }
    sql += ' ORDER BY m.ts DESC LIMIT ?';
    params.push(opts.limit);
    return this.db.prepare<Array<string | number>, MessageRow>(sql).all(...params);
  }
}

function clean(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t.length ? t : null;
}
