import type { CacheStore } from '../db/cache.js';
import type { DB } from '../db/db.js';
import { Allowlist } from './allowlist.js';
import { AuditLog } from './audit.js';
import { DraftStore } from './drafts.js';
import { RateLimiter, formatRetry } from './rateLimit.js';

export const MAX_MESSAGE_LENGTH = 4096;

export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export interface GuardrailOptions {
  allowlist: string[];
  ratePerMin: number;
  newContactsPerDay: number;
  now?: () => number;
}

/** Bundles allowlist, rate limiting, drafts and audit log behind one facade. */
export class Guardrails {
  readonly allowlist: Allowlist;
  readonly rate: RateLimiter;
  readonly drafts: DraftStore;
  readonly audit: AuditLog;

  constructor(
    db: DB,
    private readonly cache: CacheStore,
    opts: GuardrailOptions,
  ) {
    const now = opts.now ?? Date.now;
    this.allowlist = new Allowlist(opts.allowlist);
    this.rate = new RateLimiter(db, opts.ratePerMin, opts.newContactsPerDay, now);
    this.drafts = new DraftStore(db, now);
    this.audit = new AuditLog(db, now);
  }

  checkText(text: string): void {
    if (text.trim().length === 0) throw new GuardrailError('Message text is empty.');
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new GuardrailError(
        `Message is ${text.length} characters; the limit is ${MAX_MESSAGE_LENGTH}. Split it into several shorter messages ` +
          '(each needs its own prepare_message / confirm_send).',
      );
    }
  }

  /** True when we have never sent anything to this recipient. */
  isNewRecipient(jid: string): boolean {
    return !this.cache.hasMessagedBefore(jid) && !this.audit.hasSuccessfulSendTo(jid);
  }

  /** Throws a GuardrailError if the recipient is not allowed or a rate limit is hit. Consumes nothing. */
  check(jid: string): { isNewRecipient: boolean } {
    if (!this.allowlist.allows(jid, (lid) => this.cache.pnForLid(lid))) {
      throw new GuardrailError(this.allowlist.explainRejection(jid));
    }
    const isNewRecipient = this.isNewRecipient(jid);
    const decision = this.rate.check(jid, isNewRecipient);
    if (!decision.ok) {
      throw new GuardrailError(`${decision.reason} Try again in ${formatRetry(decision.retryAfterMs)}. Nothing was queued.`);
    }
    return { isNewRecipient };
  }
}

export { Allowlist, AuditLog, DraftStore, RateLimiter, formatRetry };
