import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { CacheStore } from '../src/db/cache.js';
import { Guardrails } from '../src/guardrails/index.js';
import { createMcpServer } from '../src/http/mcp.js';
import { QrTokens } from '../src/http/qrTokens.js';
import type { ToolContext } from '../src/tools/index.js';
import { ElevenLabsCalls } from '../src/voice/calls.js';
import { useSqliteAuthState } from '../src/whatsapp/authStore.js';
import { SessionManager } from '../src/whatsapp/session.js';
import { fakeFactory } from './fakeSocket.js';
import { memDb, silentLogger, testKey } from './helpers.js';

type Req = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeElevenLabs(opts: { fail?: number } = {}) {
  const requests: Req[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (opts.fail) return new Response(JSON.stringify({ detail: { message: 'Phone number not found' } }), { status: opts.fail });
    if (url.includes('/outbound-call')) {
      return Response.json({ success: true, message: 'ok', conversation_id: 'conv_123', callSid: 'CA999' });
    }
    if (url.includes('/v1/convai/conversations/')) {
      return Response.json({
        conversation_id: 'conv_123',
        status: 'done',
        metadata: { call_duration_secs: 42 },
        transcript: [
          { role: 'agent', message: 'عسلامة!', time_in_call_secs: 0 },
          { role: 'user', message: 'Ahla', time_in_call_secs: 2 },
          { role: 'agent', message: null },
        ],
        analysis: { transcript_summary: 'Short greeting.' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

async function setup(opts: { allowlist?: string[]; ratePerMin?: number; fail?: number; withCalls?: boolean } = {}) {
  const db = memDb();
  const cache = new CacheStore(db);
  const el = fakeElevenLabs({ ...(opts.fail ? { fail: opts.fail } : {}) });
  const ctx: ToolContext = {
    session: new SessionManager({
      auth: await useSqliteAuthState(db, 'default', testKey()),
      cache,
      logger: silentLogger,
      socketFactory: fakeFactory().factory,
    }),
    cache,
    guardrails: new Guardrails(db, cache, { allowlist: opts.allowlist ?? [], ratePerMin: opts.ratePerMin ?? 10, newContactsPerDay: 20 }),
    qrTokens: new QrTokens(),
    logger: silentLogger,
    requireConfirm: true,
    qrUrl: (t) => t,
    ...(opts.withCalls === false
      ? {}
      : {
          calls: new ElevenLabsCalls({
            apiKey: 'k',
            agentId: 'agent_1',
            phoneNumberId: 'phnum_1',
            provider: 'twilio',
            fetch: el.fetchImpl,
          }),
        }),
  };
  const server = createMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  const json = <T>(r: CallToolResult): T => {
    const t = text(r);
    return JSON.parse(t.slice(t.indexOf('\n\n') + 2)) as T;
  };
  return { ctx, client, call, text, json, el, cache };
}

describe('phone call tools', () => {
  it('are only registered when calls are configured', async () => {
    const off = await setup({ withCalls: false });
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain('prepare_call');
    const on = await setup();
    expect((await on.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['prepare_call', 'confirm_call', 'get_call']));
  });

  it('prepare → confirm dials once via ElevenLabs, then get_call returns the transcript', async () => {
    const t = await setup();
    t.cache.upsertContacts([{ jid: '21698123456@s.whatsapp.net', name: 'Amel' }]);
    const p = await t.call('prepare_call', { to: 'Amel', purpose: 'Remind about the clinic visit tomorrow' });
    expect(p.isError).toBeFalsy();
    const d = t.json<{ draftId: string; phone: string; resolvedName: string }>(p);
    expect(d).toMatchObject({ phone: '+21698123456', resolvedName: 'Amel' });
    expect(t.el.requests).toHaveLength(0); // not dialed yet

    const c = await t.call('confirm_call', { draftId: d.draftId });
    expect(c.isError).toBeFalsy();
    expect(t.json(c)).toMatchObject({ callId: 'conv_123', phone: '+21698123456', providerCallId: 'CA999' });
    expect(t.el.requests).toHaveLength(1);
    const req = t.el.requests[0]!;
    expect(req.url).toBe('https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
    expect(req.headers['xi-api-key']).toBe('k');
    expect(req.body).toEqual({
      agent_id: 'agent_1',
      agent_phone_number_id: 'phnum_1',
      to_number: '+21698123456',
      conversation_initiation_client_data: {
        dynamic_variables: { call_purpose: 'Remind about the clinic visit tomorrow', contact_name: 'Amel' },
      },
    });

    const again = await t.call('confirm_call', { draftId: d.draftId });
    expect(again.isError).toBe(true);
    expect(t.el.requests).toHaveLength(1);

    const g = t.json<{ status: string; durationSecs: number; transcript: Array<{ role: string; message: string }>; summary: string }>(
      await t.call('get_call', { callId: 'conv_123' }),
    );
    expect(g).toMatchObject({ status: 'done', durationSecs: 42, summary: 'Short greeting.' });
    expect(g.transcript).toEqual([
      { role: 'agent', message: 'عسلامة!', atSecs: 0 },
      { role: 'user', message: 'Ahla', atSecs: 2 },
    ]);
    const actions = t.ctx.guardrails.audit.latest().map((a) => `${a.action}:${a.result}`);
    expect(actions).toContain('call:ok');
  });

  it('enforces the allowlist and rate limit, and does not mix drafts', async () => {
    const t = await setup({ allowlist: ['+21698123456'], ratePerMin: 1 });
    const no = await t.call('prepare_call', { to: '+21698000000', purpose: 'x' });
    expect(t.text(no)).toMatch(/not on the allowlist/);
    const d = t.json<{ draftId: string }>(await t.call('prepare_call', { to: '+216 98 123 456', purpose: 'x' }));
    expect(t.text(await t.call('confirm_send', { draftId: d.draftId }))).toMatch(/phone call. Use confirm_call/);
    expect((await t.call('confirm_call', { draftId: d.draftId })).isError).toBeFalsy();
    const r = await t.call('prepare_call', { to: '+21698123456', purpose: 'again' });
    expect(t.text(r)).toMatch(/Rate limit/);
  });

  it('rejects group recipients and reports API errors without retrying', async () => {
    const t = await setup({ fail: 404 });
    t.cache.upsertChats([{ jid: '120363000000000001@g.us', name: 'Family', isGroup: true }]);
    expect(t.text(await t.call('prepare_call', { to: 'Family', purpose: 'x' }))).toMatch(/no known phone number/);
    const d = t.json<{ draftId: string }>(await t.call('prepare_call', { to: '+21698123456', purpose: 'x' }));
    const c = await t.call('confirm_call', { draftId: d.draftId });
    expect(c.isError).toBe(true);
    expect(t.text(c)).toMatch(/not placed: ElevenLabs returned 404: Phone number not found/);
    expect(t.el.requests).toHaveLength(1);
  });

  it('uses the SIP trunk endpoint when configured', async () => {
    const el = fakeElevenLabs();
    const calls = new ElevenLabsCalls({ apiKey: 'k', agentId: 'a', phoneNumberId: 'p', provider: 'sip_trunk', fetch: el.fetchImpl });
    await calls.placeCall('+21698123456');
    expect(el.requests[0]!.url).toBe('https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call');
  });
});
