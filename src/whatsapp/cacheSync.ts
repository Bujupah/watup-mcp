import {
  BufferJSON,
  getContentType,
  normalizeMessageContent,
  toNumber,
  type BaileysEventEmitter,
  type Chat,
  type ChatUpdate,
  type Contact,
  type WAMessage,
  type proto,
} from 'baileys';
import type { Logger } from 'pino';
import type { CacheStore, MessageUpsert } from '../db/cache.js';
import { isGroupJid, isLidJid, isPnJid } from './jid.js';

/** Content types that carry no user-visible content and are not cached. */
const SKIP_TYPES = new Set<string>([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'keepInChatMessage',
  'pinInChatMessage',
  'encReactionMessage',
  'pollUpdateMessage',
]);

const TYPE_NAMES: Record<string, string> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  reactionMessage: 'reaction',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
  eventMessage: 'event',
};

export interface ExtractedContent {
  type: string;
  text: string | null;
}

/** Extracts a cacheable type + text from a WhatsApp message. Returns undefined for messages we don't store. */
export function extractContent(message: proto.IMessage | null | undefined): ExtractedContent | undefined {
  const content = normalizeMessageContent(message);
  if (!content) return undefined;
  const ct = getContentType(content);
  if (!ct || SKIP_TYPES.has(ct)) return undefined;
  const type = TYPE_NAMES[ct] ?? ct.replace(/Message$/, '');
  let text: string | null | undefined;
  switch (ct) {
    case 'conversation':
      text = content.conversation;
      break;
    case 'extendedTextMessage':
      text = content.extendedTextMessage?.text;
      break;
    case 'imageMessage':
      text = content.imageMessage?.caption;
      break;
    case 'videoMessage':
      text = content.videoMessage?.caption;
      break;
    case 'documentMessage':
      text = content.documentMessage?.caption ?? content.documentMessage?.fileName;
      break;
    case 'documentWithCaptionMessage': {
      const d = content.documentWithCaptionMessage?.message?.documentMessage;
      text = d?.caption ?? d?.fileName;
      break;
    }
    case 'locationMessage':
      text = content.locationMessage?.name ?? content.locationMessage?.address;
      break;
    case 'contactMessage':
      text = content.contactMessage?.displayName;
      break;
    case 'reactionMessage':
      text = content.reactionMessage?.text;
      break;
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      text = (content[ct] as proto.Message.IPollCreationMessage | null | undefined)?.name;
      break;
    case 'buttonsResponseMessage':
      text = content.buttonsResponseMessage?.selectedDisplayText;
      break;
    case 'listResponseMessage':
      text = content.listResponseMessage?.title;
      break;
    default:
      text = null;
  }
  return { type, text: text ?? null };
}

/** Converts a Baileys WAMessage into a cache row, or undefined if it should be skipped. */
export function toMessageRow(msg: WAMessage): MessageUpsert | undefined {
  const key = msg.key;
  if (!key?.id || !key.remoteJid) return undefined;
  if (key.remoteJid === 'status@broadcast' || key.remoteJid.endsWith('@broadcast') || key.remoteJid.endsWith('@newsletter')) {
    return undefined;
  }
  const extracted = extractContent(msg.message);
  if (!extracted) return undefined;
  const fromMe = !!key.fromMe;
  const sender = fromMe ? null : (key.participantAlt ?? key.participant ?? key.remoteJidAlt ?? key.remoteJid);
  const tsSec = msg.messageTimestamp ? toNumber(msg.messageTimestamp) : 0;
  return {
    id: key.id,
    chatJid: key.remoteJid,
    fromMe,
    senderJid: sender ?? null,
    ts: tsSec > 0 ? tsSec * 1000 : null,
    type: extracted.type,
    text: extracted.text,
    raw: msg.message ? Buffer.from(JSON.stringify(msg.message, BufferJSON.replacer)) : null,
  };
}

function chatTimestamp(c: Partial<Chat>): number | null {
  const t = c.conversationTimestamp ? toNumber(c.conversationTimestamp) : (c.lastMessageRecvTimestamp ?? 0);
  return t > 0 ? t * 1000 : null;
}

export interface CacheSyncOptions {
  /** Fetches a group's subject; used to name groups we first see without a name. */
  fetchGroupName?: (jid: string) => Promise<string | undefined>;
  logger: Logger;
  /** Minimum delay between group-metadata fetches. */
  groupFetchIntervalMs?: number;
}

/**
 * Persists contacts, chats and messages from Baileys events into the cache.
 * Returns a function that detaches all listeners.
 */
export function attachCacheSync(ev: BaileysEventEmitter, cache: CacheStore, opts: CacheSyncOptions): () => void {
  const log = opts.logger;
  const groupQueue: string[] = [];
  const groupSeen = new Set<string>();
  let groupTimer: NodeJS.Timeout | undefined;
  let detached = false;

  const ensureGroupName = (jid: string, name: string | null | undefined) => {
    if (!opts.fetchGroupName || !isGroupJid(jid) || name || groupSeen.has(jid)) return;
    if (cache.getChat(jid)?.name) {
      groupSeen.add(jid);
      return;
    }
    groupSeen.add(jid);
    groupQueue.push(jid);
    pumpGroups();
  };

  const pumpGroups = () => {
    if (groupTimer || detached) return;
    const next = groupQueue.shift();
    if (!next) return;
    opts.fetchGroupName!(next)
      .then((subject) => {
        if (subject && !detached) cache.upsertChats([{ jid: next, name: subject, isGroup: true }]);
      })
      .catch((err: unknown) => log.debug({ err, jid: next }, 'groupMetadata fetch failed'))
      .finally(() => {
        groupTimer = setTimeout(() => {
          groupTimer = undefined;
          pumpGroups();
        }, opts.groupFetchIntervalMs ?? 1000);
        groupTimer.unref?.();
      });
  };

  const learnLids = (msgs: WAMessage[]) => {
    for (const m of msgs) {
      const k = m.key;
      if (!k) continue;
      if (k.remoteJid && k.remoteJidAlt) learnPair(k.remoteJid, k.remoteJidAlt);
      if (k.participant && k.participantAlt) learnPair(k.participant, k.participantAlt);
    }
  };
  const learnPair = (a: string, b: string) => {
    if (isLidJid(a) && isPnJid(b)) cache.setLidMapping(a, b);
    else if (isLidJid(b) && isPnJid(a)) cache.setLidMapping(b, a);
  };

  const saveContacts = (contacts: Array<Partial<Contact>>) => {
    const rows = contacts
      .filter((c): c is Partial<Contact> & { id: string } => typeof c.id === 'string')
      .filter((c) => !isGroupJid(c.id))
      .map((c) => ({
        jid: c.id,
        name: c.name ?? null,
        notify: c.notify ?? c.verifiedName ?? null,
        phone: c.phoneNumber ?? null,
        lid: c.lid ?? null,
      }));
    if (rows.length) cache.upsertContacts(rows);
  };

  const saveChats = (chats: Array<Partial<Chat> | ChatUpdate>) => {
    const rows = chats
      .filter((c): c is Partial<Chat> & { id: string } => typeof c.id === 'string')
      .filter((c) => !c.id.endsWith('@broadcast') && !c.id.endsWith('@newsletter'))
      .map((c) => ({
        jid: c.id,
        name: c.name ?? null,
        isGroup: isGroupJid(c.id),
        lastMessageAt: chatTimestamp(c),
        unread: typeof c.unreadCount === 'number' ? Math.max(0, c.unreadCount) : null,
      }));
    if (rows.length) cache.upsertChats(rows);
    for (const r of rows) ensureGroupName(r.jid, r.name);
  };

  const saveMessages = (msgs: WAMessage[]) => {
    learnLids(msgs);
    const rows = msgs.map(toMessageRow).filter((r): r is MessageUpsert => !!r);
    if (rows.length) cache.upsertMessages(rows);
    for (const r of rows) ensureGroupName(r.chatJid, null);
    // Learn push names of senders we have no contact entry for.
    const pushNames = msgs
      .filter((m) => !m.key?.fromMe && m.pushName)
      .map((m) => {
        const k = m.key!;
        const jid = isGroupJid(k.remoteJid ?? '') ? (k.participantAlt ?? k.participant) : (k.remoteJidAlt ?? k.remoteJid);
        return jid ? { id: jid, notify: m.pushName! } : undefined;
      })
      .filter((c): c is { id: string; notify: string } => !!c);
    if (pushNames.length) saveContacts(pushNames);
  };

  const onHistory = ({ chats, contacts, messages, lidPnMappings }: {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings?: Array<{ lid: string; pn: string }>;
  }) => {
    try {
      for (const m of lidPnMappings ?? []) cache.setLidMapping(m.lid, m.pn);
      saveContacts(contacts);
      saveChats(chats);
      saveMessages(messages);
      log.info({ chats: chats.length, contacts: contacts.length, messages: messages.length }, 'history sync chunk cached');
    } catch (err) {
      log.error({ err }, 'failed to cache history chunk');
    }
  };
  const onLid = (m: { lid: string; pn: string }) => cache.setLidMapping(m.lid, m.pn);
  const onContactsUpsert = (c: Contact[]) => safe(() => saveContacts(c));
  const onContactsUpdate = (c: Array<Partial<Contact>>) => safe(() => saveContacts(c));
  const onChatsUpsert = (c: Chat[]) => safe(() => saveChats(c));
  const onChatsUpdate = (c: ChatUpdate[]) => safe(() => saveChats(c));
  const onChatsDelete = (ids: string[]) => safe(() => cache.deleteChats(ids));
  const onMessagesUpsert = ({ messages }: { messages: WAMessage[] }) => safe(() => saveMessages(messages));
  const onMessagesDelete = (d: { keys: proto.IMessageKey[] } | { jid: string; all: true }) =>
    safe(() => {
      if ('all' in d) cache.clearChatMessages(d.jid);
      else
        cache.deleteMessages(
          d.keys.filter((k) => k.remoteJid && k.id).map((k) => ({ chatJid: k.remoteJid!, id: k.id! })),
        );
    });
  const onGroupsUpsert = (groups: Array<{ id: string; subject?: string }>) =>
    safe(() => cache.upsertChats(groups.map((g) => ({ jid: g.id, name: g.subject ?? null, isGroup: true }))));
  const onGroupsUpdate = (groups: Array<{ id?: string; subject?: string }>) =>
    safe(() =>
      cache.upsertChats(
        groups.filter((g) => g.id && g.subject).map((g) => ({ jid: g.id!, name: g.subject!, isGroup: true })),
      ),
    );

  function safe(fn: () => void) {
    try {
      fn();
    } catch (err) {
      log.error({ err }, 'cache sync handler failed');
    }
  }

  ev.on('messaging-history.set', onHistory);
  ev.on('lid-mapping.update', onLid);
  ev.on('contacts.upsert', onContactsUpsert);
  ev.on('contacts.update', onContactsUpdate);
  ev.on('chats.upsert', onChatsUpsert);
  ev.on('chats.update', onChatsUpdate);
  ev.on('chats.delete', onChatsDelete);
  ev.on('messages.upsert', onMessagesUpsert);
  ev.on('messages.delete', onMessagesDelete);
  ev.on('groups.upsert', onGroupsUpsert);
  ev.on('groups.update', onGroupsUpdate);

  return () => {
    detached = true;
    if (groupTimer) clearTimeout(groupTimer);
    ev.off('messaging-history.set', onHistory);
    ev.off('lid-mapping.update', onLid);
    ev.off('contacts.upsert', onContactsUpsert);
    ev.off('contacts.update', onContactsUpdate);
    ev.off('chats.upsert', onChatsUpsert);
    ev.off('chats.update', onChatsUpdate);
    ev.off('chats.delete', onChatsDelete);
    ev.off('messages.upsert', onMessagesUpsert);
    ev.off('messages.delete', onMessagesDelete);
    ev.off('groups.upsert', onGroupsUpsert);
    ev.off('groups.update', onGroupsUpdate);
  };
}
