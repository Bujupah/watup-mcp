import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { CacheStore, ContactRow } from '../db/cache.js';
import { GuardrailError, type Guardrails } from '../guardrails/index.js';
import type { QrTokens } from '../http/qrTokens.js';
import type { FetchedMedia, MediaKind } from '../media/fetchMedia.js';
import type { MediaShare } from '../media/mediaShare.js';
import type { ElevenLabsCalls } from '../voice/calls.js';
import type { ElevenLabs } from '../voice/elevenlabs.js';
import { JidError, displayJid, isGroupJid, parseRecipient, phoneFromJid } from '../whatsapp/jid.js';
import { SessionError, type SessionManager } from '../whatsapp/session.js';

export interface ToolContext {
  session: SessionManager;
  cache: CacheStore;
  guardrails: Guardrails;
  qrTokens: QrTokens;
  logger: Logger;
  requireConfirm: boolean;
  /** Builds the browser URL of the live QR page for a token. */
  qrUrl: (token: string) => string;
  /** ElevenLabs client; voice tools are only registered when this is set. */
  voice?: ElevenLabs;
  /** Max characters per synthesized voice note. */
  voiceMaxChars?: number;
  /** Downloads a file for prepare_media (defaults to fetchMedia with a 16 MB cap). */
  fetchMedia?: (url: string, kind: MediaKind) => Promise<FetchedMedia>;
  /** Serves downloaded media at short-lived public links (get_media). */
  mediaShare?: MediaShare;
  /** Outbound phone calls via an ElevenLabs agent; call tools are only registered when this is set. */
  calls?: ElevenLabsCalls;
}

export type ZodShape = Record<string, z.ZodType>;

export interface ToolDef<S extends ZodShape = ZodShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}

export function defineTool<S extends ZodShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** An error whose message is safe and useful to show the agent. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(summary: string, data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Converts thrown errors into MCP tool errors with actionable text. */
export function toErrorResult(err: unknown, log: Logger): CallToolResult {
  if (
    err instanceof ToolError ||
    err instanceof GuardrailError ||
    err instanceof JidError ||
    err instanceof SessionError ||
    (err instanceof Error && (err.name === 'ElevenLabsError' || err.name === 'MediaError'))
  ) {
    return errorResult(err.message);
  }
  log.error({ err }, 'tool failed');
  return errorResult(`Unexpected error: ${(err as Error)?.message ?? String(err)}`);
}

export function requireLinked(ctx: ToolContext): void {
  if (!ctx.session.isLinked()) throw new ToolError('Not linked. Call whatsapp_login.');
}

export function requireConnected(ctx: ToolContext): void {
  requireLinked(ctx);
  const st = ctx.session.getState();
  if (st !== 'connected') {
    throw new ToolError(`WhatsApp is ${st}, not connected. Wait a few seconds and retry; check whatsapp_status for details.`);
  }
}

export function formatTs(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

// ---- fuzzy matching ---------------------------------------------------------

export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/** Scores how well `query` matches `candidate` (0 = no match, 100 = exact). */
export function fuzzyScore(query: string, candidate: string | null | undefined): number {
  if (!candidate) return 0;
  const q = fold(query);
  const c = fold(candidate);
  if (!q) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 85;
  const cWords = c.split(/[\s\-_.]+/).filter(Boolean);
  if (cWords.some((w) => w.startsWith(q))) return 75;
  if (c.includes(q)) return 60;
  const words = q.split(/\s+/).filter(Boolean);
  // All query words appear somewhere.
  if (words.length > 1 && words.every((w) => c.includes(w))) return 55;
  // Some query word starts a candidate word (tolerates a typo in another word).
  if (words.length > 1 && words.some((w) => w.length >= 3 && cWords.some((cw) => cw.startsWith(w)))) return 40;
  // Subsequence match (e.g. "jdoe" → "john doe").
  let i = 0;
  for (const ch of c) if (ch === q[i]) i++;
  if (i === q.length && q.length >= 3) return 20 + Math.round((q.length / c.length) * 20);
  return 0;
}

export interface ContactMatch {
  name: string | null;
  jid: string;
  phone: string | null;
  isGroup: boolean;
  score: number;
}

export function searchContacts(cache: CacheStore, query: string, limit: number): ContactMatch[] {
  const digits = query.replace(/[^\d]/g, '');
  const isPhoneQuery = digits.length >= 4 && /^[\d\s+\-().]+$/.test(query.trim());
  const out = new Map<string, ContactMatch>();

  const consider = (jid: string, names: Array<string | null>, phone: string | null, isGroup: boolean) => {
    let score = 0;
    for (const n of names) score = Math.max(score, fuzzyScore(query, n));
    if (isPhoneQuery && phone && phone.includes(digits)) score = Math.max(score, phone === digits ? 100 : 90);
    if (score <= 0) return;
    const name = names.find((n) => !!n) ?? null;
    const prev = out.get(jid);
    if (!prev || prev.score < score) out.set(jid, { name, jid, phone: phone ? `+${phone}` : null, isGroup, score });
  };

  for (const c of cache.allContacts()) consider(c.jid, [c.name, c.notify], c.phone, false);
  for (const chat of cache.listChats({ limit: 5000, unreadOnly: false })) {
    if (!chat.name) continue;
    consider(chat.jid, [chat.name], phoneFromJid(chat.jid) ?? null, isGroupJid(chat.jid));
  }
  return [...out.values()].sort((a, b) => b.score - a.score || (a.name ?? '').localeCompare(b.name ?? '')).slice(0, limit);
}

// ---- recipient resolution ---------------------------------------------------

export interface ResolvedRecipient {
  jid: string;
  name: string | null;
  display: string;
}

function contactLabel(c: ContactRow): string {
  return `${c.name ?? c.notify ?? '(no name)'} — ${c.phone ? `+${c.phone}` : c.jid}`;
}

/**
 * Resolves a JID, phone number or exact contact/group name to a JID.
 * Names must match exactly (case-insensitive); ambiguous or unknown names produce an actionable error.
 */
export function resolveRecipient(input: string, cache: CacheStore): ResolvedRecipient {
  const parsed = parseRecipient(input);
  if (parsed.kind === 'jid' || parsed.kind === 'phone') {
    const jid = cache.canonical(parsed.jid);
    const name = cache.displayName(jid) ?? null;
    return { jid, name, display: name ? `${name} (${displayJid(jid)})` : displayJid(jid) };
  }
  const want = fold(parsed.name);
  const contacts = cache.allContacts().filter((c) => fold(c.name ?? '') === want || fold(c.notify ?? '') === want);
  // Prefer saved names over push names when both exist.
  const saved = contacts.filter((c) => fold(c.name ?? '') === want);
  const pool = saved.length > 0 ? saved : contacts;
  const groups = cache.groupChatsByName(parsed.name);
  const total = pool.length + groups.length;
  if (total === 1) {
    if (pool[0]) {
      const c = pool[0];
      const name = c.name ?? c.notify;
      return { jid: c.jid, name, display: `${name} (${displayJid(c.jid)})` };
    }
    const g = groups[0]!;
    return { jid: g.jid, name: g.name, display: `${g.name} (group)` };
  }
  if (total === 0) {
    const suggestions = searchContacts(cache, parsed.name, 5);
    const hint = suggestions.length
      ? ` Close matches: ${suggestions.map((s) => `${s.name ?? '(no name)'} (${s.phone ?? s.jid})`).join('; ')}.`
      : '';
    throw new ToolError(
      `No contact or group named "${parsed.name}". Use search_contacts to find the right one, then pass its JID or phone.${hint}`,
    );
  }
  const options = [...pool.map(contactLabel), ...groups.map((g) => `${g.name} — ${g.jid} (group)`)];
  throw new ToolError(
    `"${parsed.name}" matches ${total} chats. Ask the user which one and pass its JID or phone:\n- ${options.join('\n- ')}`,
  );
}
