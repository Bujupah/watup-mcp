import { randomToken } from '../crypto.js';

export interface SharedFile {
  data: Buffer;
  mimetype: string;
  fileName: string;
  expiresAt: number;
}

/**
 * Short-lived, unguessable links to downloaded media, so other tools (image/video generators)
 * that only accept an https URL can use a file received on WhatsApp. In memory only; capped in
 * count and total size; links expire.
 */
export class MediaShare {
  private readonly files = new Map<string, SharedFile>();

  constructor(
    private readonly baseUrl: string,
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly maxFiles = 20,
    private readonly maxTotalBytes = 64 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  put(data: Buffer, mimetype: string, fileName: string): { url: string; expiresAt: number } {
    this.prune();
    const token = randomToken(24);
    const expiresAt = this.now() + this.ttlMs;
    this.files.set(token, { data, mimetype, fileName, expiresAt });
    // Evict oldest entries beyond the caps.
    let total = [...this.files.values()].reduce((n, f) => n + f.data.length, 0);
    for (const [k, f] of this.files) {
      if (this.files.size <= this.maxFiles && total <= this.maxTotalBytes) break;
      if (k === token) continue;
      this.files.delete(k);
      total -= f.data.length;
    }
    return { url: `${this.baseUrl}/media/${token}`, expiresAt };
  }

  get(token: string): SharedFile | undefined {
    this.prune();
    return this.files.get(token);
  }

  private prune(): void {
    const t = this.now();
    for (const [k, f] of this.files) if (f.expiresAt <= t) this.files.delete(k);
  }
}
