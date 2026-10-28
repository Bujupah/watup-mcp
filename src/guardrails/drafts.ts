import { randomUUID } from 'node:crypto';
import type { DB } from '../db/db.js';

export type DraftStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';

export interface Draft {
  id: string;
  to_jid: string;
  text: string;
  created_at: number;
  expires_at: number;
  status: DraftStatus;
}

export type ClaimResult =
  | { ok: true; draft: Draft }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_sent' | 'cancelled' | 'in_progress' | 'failed'; draft?: Draft };

export const DRAFT_TTL_MS = 10 * 60 * 1000;

/** Two-step send drafts. A draft can be confirmed at most once and only before it expires. */
export class DraftStore {
  private readonly stmts;

  constructor(
    db: DB,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DRAFT_TTL_MS,
  ) {
    this.stmts = {
      insert: db.prepare<[string, string, string, number, number]>(
        "INSERT INTO drafts (id, to_jid, text, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      ),
      get: db.prepare<[string], Draft>('SELECT * FROM drafts WHERE id = ?'),
      claim: db.prepare<[string, number]>(
        "UPDATE drafts SET status = 'sending' WHERE id = ? AND status = 'pending' AND expires_at > ?",
      ),
      setStatus: db.prepare<[DraftStatus, string]>('UPDATE drafts SET status = ? WHERE id = ?'),
      purge: db.prepare<[number]>("DELETE FROM drafts WHERE expires_at < ? AND status IN ('pending', 'cancelled')"),
    };
  }

  create(toJid: string, text: string): Draft {
    const t = this.now();
    // Drafts that expired over a day ago carry no value; drop them opportunistically.
    this.stmts.purge.run(t - 24 * 60 * 60 * 1000);
    const id = `d_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.stmts.insert.run(id, toJid, text, t, t + this.ttlMs);
    return this.stmts.get.get(id)!;
  }

  get(id: string): Draft | undefined {
    return this.stmts.get.get(id);
  }

  /** Atomically moves a pending, unexpired draft to "sending". */
  claim(id: string): ClaimResult {
    const changed = this.stmts.claim.run(id, this.now()).changes;
    const draft = this.stmts.get.get(id);
    if (changed === 1 && draft) return { ok: true, draft };
    if (!draft) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: reasonFor(draft), draft };
  }


  /** Returns a claimed draft to pending (e.g. a guardrail re-check failed before sending). */
  release(id: string): void {
    this.stmts.setStatus.run('pending', id);
  }

  markSent(id: string): void {
    this.stmts.setStatus.run('sent', id);
  }

  markFailed(id: string): void {
    this.stmts.setStatus.run('failed', id);
  }

  cancel(id: string): ClaimResult {
    const d = this.stmts.get.get(id);
    if (!d) return { ok: false, reason: 'not_found' };
    if (d.status !== 'pending') return { ok: false, reason: reasonFor(d), draft: d };
    this.stmts.setStatus.run('cancelled', id);
    return { ok: true, draft: { ...d, status: 'cancelled' } };
  }
}

function reasonFor(d: Draft): Exclude<ClaimResult, { ok: true }>['reason'] {
  switch (d.status) {
    case 'pending':
      return 'expired';
    case 'sent':
      return 'already_sent';
    case 'cancelled':
      return 'cancelled';
    case 'sending':
      return 'in_progress';
    default:
      return 'failed';
  }
}
