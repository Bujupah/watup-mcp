import { randomToken, safeEqual } from '../crypto.js';

/** Short-lived tokens that grant access to the /qr page. */
export class QrTokens {
  private readonly tokens = new Map<string, number>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): { token: string; expiresAt: number } {
    this.prune();
    const token = randomToken(18);
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    this.prune();
    for (const t of this.tokens.keys()) if (safeEqual(t, token)) return true;
    return false;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.tokens) if (exp <= t) this.tokens.delete(k);
  }
}
