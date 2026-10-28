import { describe, expect, it } from 'vitest';
import { MediaError, fetchMedia, isPublicAddress } from '../src/media/fetchMedia.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.7\n...');
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(16)]);

type Route = { status?: number; body?: Buffer; headers?: Record<string, string> };
function server(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    return new Response(r.body ?? null, { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { fetchImpl, seen };
}
const publicDns = async () => ['93.184.216.34'];
const opts = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof fetchMedia>[2]> = {}) => ({
  maxBytes: 1024,
  fetch: fetchImpl,
  lookup: publicDns,
  ...extra,
});

describe('fetchMedia', () => {
  it('downloads images and detects type from bytes', async () => {
    const s = server({ 'https://ex.com/cat': { body: PNG, headers: { 'content-type': 'application/octet-stream' } } });
    const m = await fetchMedia('https://ex.com/cat', 'image', opts(s.fetchImpl));
    expect(m).toMatchObject({ kind: 'image', mimetype: 'image/png', fileName: 'cat.png' });
    expect(m.data.equals(PNG)).toBe(true);
  });

  it('sends PDFs and other files as documents with their name', async () => {
    const s = server({ 'https://ex.com/files/report%20Q3.pdf': { body: PDF } });
    expect(await fetchMedia('https://ex.com/files/report%20Q3.pdf', 'document', opts(s.fetchImpl))).toMatchObject({
      kind: 'document',
      mimetype: 'application/pdf',
      fileName: 'report Q3.pdf',
    });
  });

  it('refuses audio and video by bytes, content type or extension', async () => {
    const s = server({
      'https://ex.com/a': { body: OGG },
      'https://ex.com/b.pdf': { body: MP4 },
      'https://ex.com/c': { body: PDF, headers: { 'content-type': 'audio/mpeg' } },
      'https://ex.com/d.mp3': { body: PDF },
    });
    for (const u of ['https://ex.com/a', 'https://ex.com/b.pdf', 'https://ex.com/c', 'https://ex.com/d.mp3']) {
      await expect(fetchMedia(u, 'document', opts(s.fetchImpl)), u).rejects.toThrow(/Audio and video/);
    }
  });

  it('rejects non-images sent as image, web pages, empty and oversized files', async () => {
    const s = server({
      'https://ex.com/doc': { body: PDF },
      'https://ex.com/page': { body: Buffer.from('<html>'), headers: { 'content-type': 'text/html' } },
      'https://ex.com/empty': { body: Buffer.alloc(0) },
      'https://ex.com/big': { body: Buffer.alloc(2048, 1) },
      'https://ex.com/bigdecl': { body: PNG, headers: { 'content-length': '999999' } },
    });
    await expect(fetchMedia('https://ex.com/doc', 'image', opts(s.fetchImpl))).rejects.toThrow(/not a JPEG, PNG or WebP/);
    await expect(fetchMedia('https://ex.com/page', 'document', opts(s.fetchImpl))).rejects.toThrow(/web page/);
    await expect(fetchMedia('https://ex.com/empty', 'document', opts(s.fetchImpl))).rejects.toThrow(/empty/);
    await expect(fetchMedia('https://ex.com/big', 'document', opts(s.fetchImpl))).rejects.toThrow(/too large/);
    await expect(fetchMedia('https://ex.com/bigdecl', 'image', opts(s.fetchImpl))).rejects.toThrow(/too large/);
  });

  it('blocks http, credentials and private addresses, including after redirects', async () => {
    const s = server({
      'https://ex.com/r': { status: 302, headers: { location: 'https://internal.example/secret' } },
      'https://ex.com/ok': { status: 301, headers: { location: '/final.png' } },
      'https://ex.com/final.png': { body: PNG },
    });
    const lookup = async (h: string) => (h === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);
    await expect(fetchMedia('http://ex.com/x', 'image', opts(s.fetchImpl))).rejects.toThrow(/https/);
    await expect(fetchMedia('https://u:p@ex.com/x', 'image', opts(s.fetchImpl))).rejects.toThrow(/credentials/);
    await expect(fetchMedia('https://127.0.0.1/x', 'image', opts(s.fetchImpl))).rejects.toThrow(/private/);
    await expect(fetchMedia('https://ex.com/r', 'image', opts(s.fetchImpl, { lookup }))).rejects.toThrow(/private/);
    expect(s.seen).not.toContain('https://internal.example/secret');
    expect((await fetchMedia('https://ex.com/ok', 'image', opts(s.fetchImpl))).fileName).toBe('final.png');
    await expect(fetchMedia('not a url', 'image', opts(s.fetchImpl))).rejects.toBeInstanceOf(MediaError);
  });

  it('classifies addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });
});
