import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type MediaKind = 'image' | 'document';

export interface FetchedMedia {
  kind: MediaKind;
  data: Buffer;
  mimetype: string;
  fileName: string;
}

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface FetchMediaOptions {
  maxBytes: number;
  fetch?: typeof fetch;
  /** Resolves a hostname to IP addresses (injectable for tests). */
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

const IMAGE_TYPES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** Audio and video are not sent by this server, whatever the file is called or claims to be. */
function looksLikeAudioOrVideo(b: Buffer, contentType: string, name: string): boolean {
  const ascii = (s: number, e: number) => b.subarray(s, e).toString('latin1');
  if (/^(audio|video)\//i.test(contentType)) return true;
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|amr|wma|mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(name)) return true;
  if (ascii(0, 4) === 'OggS' || ascii(0, 3) === 'ID3' || ascii(0, 4) === 'fLaC' || ascii(0, 6) === '#!AMR') return true;
  if (ascii(0, 4) === 'RIFF' && /^(WAVE|AVI )$/.test(ascii(8, 12))) return true;
  if (ascii(4, 8) === 'ftyp') return true; // MP4/M4A/MOV/3GP family
  if (b.length > 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true; // Matroska/WebM
  if (b.length > 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return true; // MPEG audio frame
  return false;
}

/** Rejects loopback, private, link-local, CGNAT and other non-public addresses (SSRF guard). */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return false;
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6)) return false;
  return isIP(v6) === 6;
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((r) => r.address);

async function assertPublicUrl(url: URL, lookup: (h: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== 'https:') throw new MediaError('Only https:// links are accepted.');
  if (url.username || url.password) throw new MediaError('Links with credentials are not accepted.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : await lookup(host).catch(() => [] as string[]);
  if (ips.length === 0) throw new MediaError(`Cannot resolve ${host}.`);
  if (!ips.every(isPublicAddress)) throw new MediaError('Links to private or local network addresses are not accepted.');
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new MediaError(`File is too large (${mb(declared)}; limit ${mb(maxBytes)}).`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new MediaError(`File is too large (over ${mb(maxBytes)}).`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function fileNameFrom(url: URL, contentDisposition: string | null): string {
  const cd = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  const raw = cd ? decodeURIComponent(cd) : decodeURIComponent(url.pathname.split('/').pop() ?? '');
  const clean = raw.replace(/[\\/\0]/g, '').trim();
  return clean.slice(0, 120) || 'file';
}

/**
 * Downloads a public https file for sending as an image or document. Every redirect hop is
 * checked against private addresses; size is capped while streaming; the type is decided from
 * the file's bytes. Audio and video are refused.
 */
export async function fetchMedia(rawUrl: string, kind: MediaKind, opts: FetchMediaOptions): Promise<FetchedMedia> {
  const fetchImpl = opts.fetch ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaError(`"${rawUrl}" is not a valid URL.`);
  }

  let res: Response | undefined;
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicUrl(url, lookup);
    try {
      res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    } catch (err) {
      throw new MediaError(`Could not download the file: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    break;
  }
  if (!res || (res.status >= 300 && res.status < 400)) throw new MediaError('Too many redirects.');
  if (!res.ok) throw new MediaError(`Download failed with HTTP ${res.status}.`);

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const fileName = fileNameFrom(url, res.headers.get('content-disposition'));
  const data = await readCapped(res, opts.maxBytes);
  if (data.length === 0) throw new MediaError('The file is empty.');
  if (looksLikeAudioOrVideo(data, contentType, fileName)) {
    throw new MediaError('Audio and video files are not supported. Send an image or a document.');
  }

  const image = IMAGE_TYPES.find((t) => t.test(data));
  if (kind === 'image') {
    if (!image) throw new MediaError('That file is not a JPEG, PNG or WebP image. Send it as a document instead.');
    return { kind, data, mimetype: image.mime, fileName: /\.\w+$/.test(fileName) ? fileName : `${fileName}.${image.ext}` };
  }
  const mimetype =
    image?.mime ??
    (data.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : contentType && contentType !== 'text/html' ? contentType : 'application/octet-stream');
  if (contentType === 'text/html' && !image && mimetype === 'application/octet-stream') {
    throw new MediaError('The link returned a web page, not a file. Use a direct download link.');
  }
  return { kind, data, mimetype, fileName };
}
