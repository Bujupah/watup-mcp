import type { DB } from '../db/db.js';

export type RateDecision = { ok: true } | { ok: false; reason: string; retryAfterMs: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Two limits:
 *  - a token bucket of `perMinute` sends, refilled continuously;
 *  - at most `newPerDay` distinct never-messaged recipients in any rolling 24h window
 *    (computed from successful sends in the audit log, so it survives restarts).
 * Violations are reported with a retry time; nothing is ever queued silently.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly newRecipientsStmt;

  constructor(
    db: DB,
    private readonly perMinute: number,
    private readonly newPerDay: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.last = now();
    this.newRecipientsStmt = db.prepare<[number], { to_jid: string; first_ts: number }>(
      `SELECT to_jid, MIN(ts) AS first_ts FROM audit_log
       WHERE action = 'send' AND result = 'ok' AND new_recipient = 1 AND ts > ?
       GROUP BY to_jid ORDER BY first_ts ASC`,
    );
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.tokens = Math.min(this.perMinute, this.tokens + (elapsed * this.perMinute) / 60_000);
    this.last = t;
  }

  /** Checks both limits without consuming anything. */
  check(jid: string, isNewRecipient: boolean): RateDecision {
    this.refill();
    if (this.tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute);
      return {
        ok: false,
        reason: `Rate limit reached: at most ${this.perMinute} messages per minute.`,
        retryAfterMs,
      };
    }
    if (isNewRecipient) {
      const t = this.now();
      const rows = this.newRecipientsStmt.all(t - DAY_MS);
      if (!rows.some((r) => r.to_jid === jid) && rows.length >= this.newPerDay) {
        const oldest = rows[rows.length - this.newPerDay];
        const retryAfterMs = oldest ? Math.max(1000, oldest.first_ts + DAY_MS - t) : DAY_MS;
        return {
          ok: false,
          reason: `New-contact limit reached: at most ${this.newPerDay} never-messaged recipients per 24 hours.`,
          retryAfterMs,
        };
      }
    }
    return { ok: true };
  }

  /** Consumes one send token. Call only after check() passed and right before sending. */
  consume(): void {
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

export function formatRetry(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.ceil(m / 60)} h`;
}
