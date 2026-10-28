import type { DB } from '../db/db.js';

export type AuditAction = 'prepare' | 'confirm' | 'send' | 'cancel' | 'login' | 'logout' | 'logged_out';

export interface AuditEntry {
  action: AuditAction;
  toJid?: string | null;
  draftId?: string | null;
  result: 'ok' | 'error' | 'rejected';
  error?: string | null;
  newRecipient?: boolean;
}

export interface AuditRow {
  id: number;
  ts: number;
  action: string;
  to_jid: string | null;
  draft_id: string | null;
  result: string | null;
  error: string | null;
  new_recipient: number;
}

/** Append-only audit log. Never stores message content. */
export class AuditLog {
  private readonly insert;
  private readonly recent;
  private readonly sentTo;

  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {
    this.insert = db.prepare<[number, string, string | null, string | null, string, string | null, number]>(
      'INSERT INTO audit_log (ts, action, to_jid, draft_id, result, error, new_recipient) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.recent = db.prepare<[number], AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?');
    this.sentTo = db.prepare<[string], { n: number }>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'send' AND result = 'ok' AND to_jid = ?",
    );
  }

  record(e: AuditEntry): void {
    this.insert.run(this.now(), e.action, e.toJid ?? null, e.draftId ?? null, e.result, e.error ?? null, e.newRecipient ? 1 : 0);
  }

  hasSuccessfulSendTo(jid: string): boolean {
    return this.sentTo.get(jid)!.n > 0;
  }

  latest(limit = 50): AuditRow[] {
    return this.recent.all(limit);
  }
}
