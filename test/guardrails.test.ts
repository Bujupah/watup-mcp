import { describe, expect, it } from 'vitest';
import { CacheStore } from '../src/db/cache.js';
import { Allowlist } from '../src/guardrails/allowlist.js';
import { AuditLog } from '../src/guardrails/audit.js';
import { DraftStore } from '../src/guardrails/drafts.js';
import { GuardrailError, Guardrails } from '../src/guardrails/index.js';
import { RateLimiter, formatRetry } from '../src/guardrails/rateLimit.js';
import { memDb } from './helpers.js';

const clock = (start = 1_000_000_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('Allowlist', () => {
  it('allows everyone when empty', () => {
    expect(new Allowlist([]).allows('123@s.whatsapp.net')).toBe(true);
  });
  it('matches phones in any format, JIDs and LIDs via mapping', () => {
    const a = new Allowlist(['+1 (415) 555-0123', '120363012345678901@g.us', '447700900123@s.whatsapp.net']);
    expect(a.allows('14155550123@s.whatsapp.net')).toBe(true);
    expect(a.allows('447700900123@s.whatsapp.net')).toBe(true);
    expect(a.allows('120363012345678901@g.us')).toBe(true);
    expect(a.allows('14155550999@s.whatsapp.net')).toBe(false);
    expect(a.allows('999@lid', () => '14155550123@s.whatsapp.net')).toBe(true);
    expect(a.allows('999@lid', () => undefined)).toBe(false);
    expect(a.explainRejection('14155550999@s.whatsapp.net')).toMatch(/WA_MCP_ALLOWLIST.*\+14155550999|\+14155550999.*WA_MCP_ALLOWLIST/);
  });
  it('rejects invalid entries at startup', () => {
    expect(() => new Allowlist(['not a number'])).toThrow(/WA_MCP_ALLOWLIST/);
  });
});

describe('RateLimiter', () => {
  it('enforces per-minute token bucket and refills', () => {
    const db = memDb();
    const c = clock();
    const r = new RateLimiter(db, 2, 100, c.now);
    expect(r.check('a', false).ok).toBe(true);
    r.consume();
    r.consume();
    const d = r.check('a', false);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.retryAfterMs).toBe(30_000);
    c.advance(30_000);
    expect(r.check('a', false).ok).toBe(true);
  });

  it('limits distinct new recipients per rolling 24h', () => {
    const db = memDb();
    const c = clock();
    const audit = new AuditLog(db, c.now);
    const r = new RateLimiter(db, 100, 2, c.now);
    audit.record({ action: 'send', toJid: 'a', result: 'ok', newRecipient: true });
    c.advance(60_000);
    audit.record({ action: 'send', toJid: 'b', result: 'ok', newRecipient: true });
    audit.record({ action: 'send', toJid: 'x', result: 'error', newRecipient: true }); // failures don't count
    const d = r.check('c', true);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.retryAfterMs).toBe(24 * 3600_000 - 60_000);
    expect(r.check('a', true).ok).toBe(true); // already counted
    expect(r.check('c', false).ok).toBe(true); // known recipients are fine
    c.advance(24 * 3600_000 - 60_000 + 1);
    expect(r.check('c', true).ok).toBe(true);
  });

  it('formats retry times', () => {
    expect(formatRetry(1500)).toBe('2s');
    expect(formatRetry(5 * 60_000)).toBe('5 min');
    expect(formatRetry(5 * 3600_000)).toBe('5 h');
  });
});

describe('DraftStore', () => {
  it('claims once, expires, cancels', () => {
    const db = memDb();
    const c = clock();
    const drafts = new DraftStore(db, c.now);
    const d = drafts.create('1@s.whatsapp.net', 'hi');
    expect(d.status).toBe('pending');
    expect(drafts.claim(d.id).ok).toBe(true);
    expect(drafts.claim(d.id)).toMatchObject({ ok: false, reason: 'in_progress' });
    drafts.markSent(d.id);
    expect(drafts.claim(d.id)).toMatchObject({ ok: false, reason: 'already_sent' });

    const e = drafts.create('1@s.whatsapp.net', 'later');
    c.advance(10 * 60_000 + 1);
    expect(drafts.claim(e.id)).toMatchObject({ ok: false, reason: 'expired' });

    const f = drafts.create('1@s.whatsapp.net', 'nope');
    expect(drafts.cancel(f.id).ok).toBe(true);
    expect(drafts.claim(f.id)).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(drafts.claim('missing')).toMatchObject({ ok: false, reason: 'not_found' });

    const g = drafts.create('1@s.whatsapp.net', 'retry');
    expect(drafts.claim(g.id).ok).toBe(true);
    drafts.release(g.id);
    expect(drafts.claim(g.id).ok).toBe(true);
  });
});

describe('Guardrails', () => {
  it('rejects overlong and empty text', () => {
    const db = memDb();
    const g = new Guardrails(db, new CacheStore(db), { allowlist: [], ratePerMin: 10, newContactsPerDay: 10 });
    expect(() => g.checkText('x'.repeat(4097))).toThrow(/split/i);
    expect(() => g.checkText('   ')).toThrow(GuardrailError);
    expect(() => g.checkText('x'.repeat(4096))).not.toThrow();
  });
  it('detects new recipients from cache and audit', () => {
    const db = memDb();
    const cache = new CacheStore(db);
    const g = new Guardrails(db, cache, { allowlist: [], ratePerMin: 10, newContactsPerDay: 10 });
    expect(g.isNewRecipient('1@s.whatsapp.net')).toBe(true);
    cache.upsertMessages([{ id: 'm', chatJid: '1@s.whatsapp.net', fromMe: true, senderJid: null, ts: 1, type: 'text', text: 'x', raw: null }]);
    expect(g.isNewRecipient('1@s.whatsapp.net')).toBe(false);
    g.audit.record({ action: 'send', toJid: '2@s.whatsapp.net', result: 'ok' });
    expect(g.isNewRecipient('2@s.whatsapp.net')).toBe(false);
  });
});
