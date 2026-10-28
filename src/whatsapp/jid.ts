import { jidDecode, jidNormalizedUser } from 'baileys';

export const USER_SERVER = 's.whatsapp.net';
export const GROUP_SERVER = 'g.us';
export const LID_SERVER = 'lid';

const SUPPORTED_SERVERS = new Set([USER_SERVER, GROUP_SERVER, LID_SERVER]);

export class JidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JidError';
  }
}

/**
 * Normalizes a phone number to digits only, international format without "+".
 * Accepts "+1 (555) 123-4567", "0044 20 ...", etc. A country code is required.
 */
export function normalizePhone(input: string): string {
  let s = input.trim();
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  const hasPlus = s.startsWith('+');
  const stripped = s.replace(/[\s+\-().]/g, '');
  if (!/^\d+$/.test(stripped)) {
    throw new JidError(`"${input}" is not a valid phone number. Use international format, e.g. +14155550123.`);
  }
  if (!hasPlus && stripped.startsWith('0')) {
    throw new JidError(
      `"${input}" looks like a national number (leading 0). Include the country code, e.g. +44 7700 900123.`,
    );
  }
  if (stripped.length < 8 || stripped.length > 15) {
    throw new JidError(`"${input}" must have 8–15 digits including the country code (got ${stripped.length}).`);
  }
  return stripped;
}

export function toUserJid(phone: string): string {
  return `${normalizePhone(phone)}@${USER_SERVER}`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(`@${GROUP_SERVER}`);
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith(`@${LID_SERVER}`);
}

export function isPnJid(jid: string): boolean {
  return jid.endsWith(`@${USER_SERVER}`);
}

/** Returns the phone digits of a phone-number JID (device suffix stripped), or undefined. */
export function phoneFromJid(jid: string | null | undefined): string | undefined {
  if (!jid || !isPnJid(jid)) return undefined;
  const user = jidDecode(jid)?.user;
  return user && /^\d+$/.test(user) ? user : undefined;
}

/**
 * Validates and normalizes a raw JID (strips device suffixes like ":12").
 * Supports @s.whatsapp.net, @g.us and @lid.
 */
export function normalizeJid(input: string): string {
  const raw = input.trim().toLowerCase();
  const decoded = jidDecode(raw);
  if (!decoded || !decoded.user || !SUPPORTED_SERVERS.has(decoded.server)) {
    throw new JidError(`"${input}" is not a supported JID. Expected <digits>@s.whatsapp.net, <id>@g.us or <id>@lid.`);
  }
  if (decoded.server === GROUP_SERVER) {
    if (!/^[\d-]+$/.test(decoded.user)) throw new JidError(`"${input}" is not a valid group JID.`);
    return `${decoded.user}@${GROUP_SERVER}`;
  }
  if (!/^\d+$/.test(decoded.user)) throw new JidError(`"${input}" is not a valid user JID.`);
  if (decoded.server === USER_SERVER) normalizePhone(decoded.user);
  return jidNormalizedUser(raw);
}

export type RecipientInput =
  | { kind: 'jid'; jid: string }
  | { kind: 'phone'; digits: string; jid: string }
  | { kind: 'name'; name: string };

/** Classifies free-form recipient input as a JID, a phone number, or a contact name. */
export function parseRecipient(input: string): RecipientInput {
  const s = input.trim();
  if (s.length === 0) throw new JidError('Recipient is empty.');
  if (s.includes('@')) return { kind: 'jid', jid: normalizeJid(s) };
  if (/^[\d\s+\-().]+$/.test(s) && /\d/.test(s)) {
    const digits = normalizePhone(s);
    return { kind: 'phone', digits, jid: `${digits}@${USER_SERVER}` };
  }
  return { kind: 'name', name: s };
}

/** Formats a JID for humans: "+14155550123" for phone JIDs, the JID otherwise. */
export function displayJid(jid: string): string {
  const p = phoneFromJid(jid);
  return p ? `+${p}` : jid;
}
