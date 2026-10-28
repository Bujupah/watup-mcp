import { JidError, isGroupJid, isLidJid, normalizeJid, normalizePhone, phoneFromJid } from '../whatsapp/jid.js';

/**
 * Recipient allowlist. Entries may be phone numbers (any format with a country code) or JIDs.
 * An empty allowlist allows everyone.
 */
export class Allowlist {
  private readonly phones = new Set<string>();
  private readonly jids = new Set<string>();

  constructor(entries: string[]) {
    for (const raw of entries) {
      try {
        if (raw.includes('@')) {
          const jid = normalizeJid(raw);
          const p = phoneFromJid(jid);
          if (p) this.phones.add(p);
          else this.jids.add(jid);
        } else {
          this.phones.add(normalizePhone(raw));
        }
      } catch (err) {
        throw new JidError(`Invalid WA_MCP_ALLOWLIST entry "${raw}": ${(err as Error).message}`);
      }
    }
  }

  get isEmpty(): boolean {
    return this.phones.size === 0 && this.jids.size === 0;
  }

  get size(): number {
    return this.phones.size + this.jids.size;
  }

  /**
   * @param jid recipient JID
   * @param pnForLid resolves a LID to its phone JID so phone entries also match LID recipients
   */
  allows(jid: string, pnForLid?: (lid: string) => string | undefined): boolean {
    if (this.isEmpty) return true;
    if (this.jids.has(jid)) return true;
    let phone = phoneFromJid(jid);
    if (!phone && isLidJid(jid) && pnForLid) phone = phoneFromJid(pnForLid(jid));
    if (phone && this.phones.has(phone)) return true;
    return false;
  }

  explainRejection(jid: string): string {
    const what = isGroupJid(jid) ? `the group JID ${jid}` : phoneFromJid(jid) ? `+${phoneFromJid(jid)}` : jid;
    return (
      `Recipient ${what} is not on the allowlist. ` +
      `To allow it, add ${isGroupJid(jid) || !phoneFromJid(jid) ? jid : `+${phoneFromJid(jid)}`} to WA_MCP_ALLOWLIST ` +
      '(comma-separated) and restart the server.'
    );
  }
}
