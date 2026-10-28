import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheStore } from '../src/db/cache.js';
import { Guardrails } from '../src/guardrails/index.js';
import { QrTokens } from '../src/http/qrTokens.js';
import { createApp, isLoopbackAddress } from '../src/http/server.js';
import type { ToolContext } from '../src/tools/index.js';
import { useSqliteAuthState } from '../src/whatsapp/authStore.js';
import { SessionManager } from '../src/whatsapp/session.js';
import { fakeFactory } from './fakeSocket.js';
import { memDb, silentLogger, testKey } from './helpers.js';

const TOKEN = 'test-token-0123456789';
let server: Server;
let base: string;
let ctx: ToolContext;
let fake: ReturnType<typeof fakeFactory>;

beforeAll(async () => {
  const db = memDb();
  const cache = new CacheStore(db);
  fake = fakeFactory({ autoQr: true });
  const session = new SessionManager({
    auth: await useSqliteAuthState(db, 'default', testKey()),
    cache,
    logger: silentLogger,
    socketFactory: fake.factory,
  });
  ctx = {
    session,
    cache,
    guardrails: new Guardrails(db, cache, { allowlist: [], ratePerMin: 10, newContactsPerDay: 10 }),
    qrTokens: new QrTokens(),
    logger: silentLogger,
    requireConfirm: true,
    qrUrl: (t) => `${base}/qr?t=${t}`,
  };
  const app = createApp(ctx, { host: '127.0.0.1', port: 0, token: TOKEN, allowRemote: false });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await ctx.session.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const rpc = (body: unknown, token = TOKEN) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });

describe('HTTP server', () => {
  it('serves /health', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, state: 'disconnected' });
  });

  it('requires the bearer token on /mcp', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong')).status).toBe(401);
    const res = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
  });

  it('answers MCP tools/call statelessly', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whatsapp_status', arguments: {} } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toMatch(/Not linked/);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}/health`, { headers: { Host: 'attacker.example' } }, (res) => resolve(res.statusCode!));
      req.end();
    });
    expect(status).toBe(403);
  });

  it('protects /qr with a token and streams status over SSE', async () => {
    expect((await fetch(`${base}/qr`)).status).toBe(403);
    expect((await fetch(`${base}/qr?t=bogus`)).status).toBe(403);

    const login = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whatsapp_login', arguments: {} } });
    const body = (await login.json()) as { result: { content: Array<{ type: string; text?: string }> } };
    const url = /(http:\/\/\S+\/qr\?t=\S+)/.exec(body.result.content.find((c) => c.type === 'text')!.text!)![1]!;

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/);
    expect(await page.text()).toMatch(/Link WhatsApp/);

    const ac = new AbortController();
    const sse = await fetch(url.replace('/qr?', '/qr/events?'), { signal: ac.signal });
    expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = sse.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^event: status\ndata: /);
    const payload = JSON.parse(first.split('data: ')[1]!) as { state: string; qr?: string };
    expect(payload.state).toBe('awaiting_scan');
    expect(payload.qr).toMatch(/^data:image\/png;base64,/);

    // Scan → connected: stream sends final status and ends.
    fake.last().pairSuccess();
    fake.last().close(515);
    await new Promise((r) => setImmediate(r));
    fake.last().open();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toMatch(/"state":"connected","linkedAs":"\+14155550123"/);
    ac.abort();
  });

  it('recognises loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.2')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('stdio shim', () => {
  it('proxies to the daemon and writes only JSON-RPC to stdout', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/stdio-shim.ts'], {
      env: { ...process.env, WA_MCP_URL: `${base}/mcp`, WA_MCP_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whatsapp_status', arguments: {} } },
    ];
    child.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    const parsed = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id: number; result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } });
    expect(parsed.every((m) => m.jsonrpc === '2.0')).toBe(true);
    expect(parsed.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(parsed[1]!.result.tools!.map((t) => t.name)).toContain('prepare_message');
    expect(parsed[2]!.result.content![0]!.text).toMatch(/Connected as|Not linked/);
    expect(stderr).toMatch(/ready/);
  }, 20_000);
});

describe('URL token mode', () => {
  it('accepts /mcp/<token> only when enabled', async () => {
    const app = createApp(ctx, { host: '127.0.0.1', port: 0, token: TOKEN, allowRemote: false, allowUrlToken: true });
    const s = await new Promise<Server>((r) => {
      const x = app.listen(0, '127.0.0.1', () => r(x));
    });
    const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const ok = await fetch(`${u}/mcp/${TOKEN}`, { method: 'POST', headers, body });
    expect(ok.status).toBe(200);
    expect((await fetch(`${u}/mcp/wrong-token`, { method: 'POST', headers, body })).status).toBe(401);
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    // default server (beforeAll) has it disabled
    expect((await fetch(`${base}/mcp/${TOKEN}`, { method: 'POST', headers, body })).status).toBe(404);
  });
});

describe('media links', () => {
  it('serves shared images inline and other files as sandboxed downloads, then expire', async () => {
    const { MediaShare } = await import('../src/media/mediaShare.js');
    let now = 1_000;
    const share = new MediaShare(base, 60_000, 20, 1024 * 1024, () => now);
    ctx.mediaShare = share;
    const img = share.put(Buffer.from([0x89, 0x50]), 'image/png', 'cat.png');
    const doc = share.put(Buffer.from('<html><script>x</script>'), 'text/html', 'evil.html');
    const r1 = await fetch(img.url);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toBe('image/png');
    expect(r1.headers.get('content-disposition')).toMatch(/^inline/);
    const r2 = await fetch(doc.url);
    expect(r2.headers.get('content-type')).toMatch(/application\/octet-stream/);
    expect(r2.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(r2.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect((await fetch(`${base}/media/guess`)).status).toBe(404);
    now += 61_000;
    expect((await fetch(img.url)).status).toBe(404);
    delete ctx.mediaShare;
  });
});
