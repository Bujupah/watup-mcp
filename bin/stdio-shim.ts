#!/usr/bin/env node
/**
 * whatsapp-mcp-stdio: a thin stdio MCP server that proxies tools/list and tools/call to the
 * whatsapp-mcp daemon over Streamable HTTP. It never owns a WhatsApp socket itself.
 *
 * stdout carries JSON-RPC only. Every diagnostic goes to stderr.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INSTRUCTIONS } from '../src/instructions.js';
import { VERSION } from '../src/version.js';

// Guard stdout: anything that accidentally calls console.log goes to stderr instead.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const log = (msg: string) => process.stderr.write(`[whatsapp-mcp-stdio] ${msg}\n`);

const url = new URL(process.env.WA_MCP_URL ?? `http://127.0.0.1:${process.env.WA_MCP_PORT ?? '8787'}/mcp`);
const token = process.env.WA_MCP_TOKEN;
if (!token) {
  log('WA_MCP_TOKEN is not set. Set it to the same bearer token the daemon uses.');
  process.exit(1);
}

let client: Client | undefined;
let connecting: Promise<Client> | undefined;

async function upstream(): Promise<Client> {
  if (client) return client;
  connecting ??= (async () => {
    const c = new Client({ name: 'whatsapp-mcp-stdio', version: VERSION });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    c.onerror = (err) => log(`upstream error: ${err.message}`);
    c.onclose = () => {
      client = undefined;
    };
    await c.connect(transport);
    client = c;
    return c;
  })().finally(() => {
    connecting = undefined;
  });
  return connecting;
}

function unreachable(err: unknown): string {
  return (
    `Cannot reach the whatsapp-mcp daemon at ${url.href}: ${(err as Error).message}. ` +
    'Start it with `whatsapp-mcp` (or `npm start`) and make sure WA_MCP_TOKEN matches.'
  );
}

const server = new Server(
  { name: 'whatsapp-mcp', version: VERSION },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

// Requests still being proxied; on stdin EOF we drain these before exiting.
let inFlight = 0;
let drained: (() => void) | undefined;
async function track<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    if (inFlight === 0) drained?.();
  }
}

server.setRequestHandler(ListToolsRequestSchema, (req) => track(async () => {
  try {
    return await (await upstream()).listTools(req.params);
  } catch (err) {
    client = undefined;
    log(unreachable(err));
    throw new Error(unreachable(err));
  }
}));

server.setRequestHandler(CallToolRequestSchema, (req) => track(async (): Promise<CallToolResult> => {
  try {
    return (await (await upstream()).callTool(req.params)) as CallToolResult;
  } catch (err) {
    client = undefined;
    log(unreachable(err));
    return { content: [{ type: 'text', text: unreachable(err) }], isError: true };
  }
}));

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready; proxying to ${url.href}`);

const shutdown = async () => {
  if (inFlight > 0) await new Promise<void>((r) => (drained = r));
  // Let the transport flush the last responses to stdout.
  await new Promise<void>((r) => setImmediate(r));
  await client?.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.stdin.on('end', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
