import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean, got "${v}"` });
      return z.NEVER;
    });

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? String(def) : v))
    .pipe(z.coerce.number<string>().int().min(min).max(max));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

const EnvSchema = z.object({
  WA_MCP_PORT: int(8787, 1, 65535),
  WA_MCP_HOST: z.string().trim().min(1).default('127.0.0.1'),
  WA_MCP_ALLOW_REMOTE: bool(false),
  WA_MCP_ALLOW_URL_TOKEN: bool(false),
  WA_MCP_TOKEN: z
    .string({ error: 'WA_MCP_TOKEN is required (bearer token for /mcp)' })
    .min(16, 'WA_MCP_TOKEN must be at least 16 characters'),
  WA_MCP_MASTER_KEY: z.string({ error: 'WA_MCP_MASTER_KEY is required' }).min(1),
  WA_MCP_DB_PATH: z.string().trim().min(1).default('~/.whatsapp-mcp/data.db'),
  WA_MCP_REQUIRE_CONFIRM: bool(true),
  WA_MCP_ALLOWLIST: list,
  WA_MCP_RATE_PER_MIN: int(10, 1, 1000),
  WA_MCP_NEW_CONTACTS_PER_DAY: int(20, 0, 10000),
  WA_MCP_SYNC_FULL_HISTORY: bool(false),
  ELEVENLABS_API_KEY: z.string().trim().optional(),
  // Default: "Rachel", a premade ElevenLabs voice. Use list_voices to pick a better one for your language.
  WA_MCP_TTS_VOICE_ID: z.string().trim().min(1).default('21m00Tcm4TlvDq8ikWAM'),
  WA_MCP_TTS_MODEL: z.string().trim().min(1).default('eleven_multilingual_v2'),
  WA_MCP_STT_MODEL: z.string().trim().min(1).default('scribe_v1'),
  WA_MCP_VOICE_MAX_CHARS: int(1000, 1, 5000),
  WA_MCP_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  WA_MCP_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  WA_MCP_BAILEYS_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('warn'),
});

export interface Config {
  port: number;
  host: string;
  allowRemote: boolean;
  /** Also accept the bearer token as a path segment: /mcp/<token> (for clients that can't send headers). */
  allowUrlToken: boolean;
  token: string;
  masterKey: Buffer;
  dbPath: string;
  requireConfirm: boolean;
  allowlist: string[];
  ratePerMin: number;
  newContactsPerDay: number;
  syncFullHistory: boolean;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  baileysLogLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** ElevenLabs settings; undefined when ELEVENLABS_API_KEY is not set (voice tools disabled). */
  voice:
    | { apiKey: string; voiceId: string; ttsModel: string; sttModel: string; maxChars: number }
    | undefined;
  /** Externally reachable base URL (no trailing slash), used for links such as the QR page. */
  publicUrl: string | undefined;
  accountId: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly missingMasterKey = false,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

export function decodeMasterKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new ConfigError(
      `WA_MCP_MASTER_KEY must be 32 bytes encoded as base64 (got ${key.length} bytes). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.WA_MCP_MASTER_KEY || env.WA_MCP_MASTER_KEY.trim() === '') {
    throw new ConfigError('WA_MCP_MASTER_KEY is not set.', true);
  }
  // Hosting platforms: Render (and others) inject PORT and RENDER_EXTERNAL_URL.
  const parsed = EnvSchema.safeParse({
    ...env,
    WA_MCP_PORT: env.WA_MCP_PORT || env.PORT,
    WA_MCP_PUBLIC_URL: env.WA_MCP_PUBLIC_URL || env.RENDER_EXTERNAL_URL || undefined,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${msg}`);
  }
  const e = parsed.data;
  if (!isLoopbackHost(e.WA_MCP_HOST) && !e.WA_MCP_ALLOW_REMOTE) {
    throw new ConfigError(
      `Refusing to bind to ${e.WA_MCP_HOST}: anyone who can reach this server can message as you. ` +
        'Set WA_MCP_ALLOW_REMOTE=true to override (and put it behind a TLS reverse proxy).',
    );
  }
  return {
    port: e.WA_MCP_PORT,
    host: e.WA_MCP_HOST,
    allowRemote: e.WA_MCP_ALLOW_REMOTE,
    allowUrlToken: e.WA_MCP_ALLOW_URL_TOKEN,
    token: e.WA_MCP_TOKEN,
    masterKey: decodeMasterKey(e.WA_MCP_MASTER_KEY),
    dbPath: expandHome(e.WA_MCP_DB_PATH),
    requireConfirm: e.WA_MCP_REQUIRE_CONFIRM,
    allowlist: e.WA_MCP_ALLOWLIST,
    ratePerMin: e.WA_MCP_RATE_PER_MIN,
    newContactsPerDay: e.WA_MCP_NEW_CONTACTS_PER_DAY,
    syncFullHistory: e.WA_MCP_SYNC_FULL_HISTORY,
    logLevel: e.WA_MCP_LOG_LEVEL,
    baileysLogLevel: e.WA_MCP_BAILEYS_LOG_LEVEL,
    voice: e.ELEVENLABS_API_KEY
      ? {
          apiKey: e.ELEVENLABS_API_KEY,
          voiceId: e.WA_MCP_TTS_VOICE_ID,
          ttsModel: e.WA_MCP_TTS_MODEL,
          sttModel: e.WA_MCP_STT_MODEL,
          maxChars: e.WA_MCP_VOICE_MAX_CHARS,
        }
      : undefined,
    publicUrl: e.WA_MCP_PUBLIC_URL?.replace(/\/+$/, ''),
    accountId: 'default',
  };
}
