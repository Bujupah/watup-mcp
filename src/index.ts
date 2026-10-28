#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { ConfigError, isLoopbackHost, loadConfig } from './config.js';
import { CacheStore } from './db/cache.js';
import { openDatabase } from './db/db.js';
import { Guardrails } from './guardrails/index.js';
import { QrTokens } from './http/qrTokens.js';
import { createApp, listen } from './http/server.js';
import type { ToolContext } from './tools/index.js';
import { useSqliteAuthState } from './whatsapp/authStore.js';
import { SessionManager } from './whatsapp/session.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  // Everything we create (DB, WAL files) is private to this user.
  process.umask(0o077);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError && err.missingMasterKey) {
      const key = randomBytes(32).toString('base64');
      process.stderr.write(
        '\nWA_MCP_MASTER_KEY is not set. It encrypts your WhatsApp session at rest.\n\n' +
          'A fresh key was generated for you (it has NOT been saved anywhere):\n\n' +
          `  WA_MCP_MASTER_KEY=${key}\n\n` +
          'Store it in your password manager / secret store and set it in the environment, then start again.\n' +
          'Do not keep it next to the database file. If you lose it you will have to link the device again.\n\n',
      );
      process.exit(1);
    }
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  const logger = pino({ level: config.logLevel, base: { app: 'whatsapp-mcp' } }, pino.destination(2));
  logger.info({ version: VERSION, db: config.dbPath }, 'starting whatsapp-mcp');

  if (!isLoopbackHost(config.host)) {
    logger.warn(
      { host: config.host },
      'Binding to a non-loopback address. Anyone who can reach this port and has the token can message as you. ' +
        'Put it behind a TLS-terminating reverse proxy and restrict network access.',
    );
  }
  if (config.allowlist.length === 0) {
    logger.warn('WA_MCP_ALLOWLIST is empty: the agent may message ANY recipient (still rate-limited and confirmed).');
  }
  if (config.allowUrlToken) {
    logger.warn('WA_MCP_ALLOW_URL_TOKEN=true: /mcp/<token> is accepted. The token is part of the URL, so keep that URL secret.');
  }
  if (!config.requireConfirm) {
    logger.warn('WA_MCP_REQUIRE_CONFIRM=false: send_message sends in one step without a draft.');
  }

  const db = openDatabase(config.dbPath);
  const cache = new CacheStore(db);
  let auth;
  try {
    auth = await useSqliteAuthState(db, config.accountId, config.masterKey);
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      'Cannot decrypt the stored WhatsApp session. WA_MCP_MASTER_KEY differs from the key used when the device was linked ' +
        '(or the database is corrupted). Restore the original key, or point WA_MCP_DB_PATH at a fresh file and link again.',
    );
    process.exit(1);
  }
  const guardrails = new Guardrails(db, cache, {
    allowlist: config.allowlist,
    ratePerMin: config.ratePerMin,
    newContactsPerDay: config.newContactsPerDay,
  });
  const session = new SessionManager({ auth, cache, logger, syncFullHistory: config.syncFullHistory, baileysLogLevel: config.baileysLogLevel });
  const qrTokens = new QrTokens();
  const urlHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
  const baseUrl = config.publicUrl ?? `http://${urlHost}:${config.port}`;

  const ctx: ToolContext = {
    session,
    cache,
    guardrails,
    qrTokens,
    logger,
    requireConfirm: config.requireConfirm,
    qrUrl: (token) => `${baseUrl}/qr?t=${encodeURIComponent(token)}`,
  };

  session.on('qr', (qr: string) => {
    if (!process.stderr.isTTY || session.getStatus().pairingCode !== undefined) return;
    qrcodeTerminal.generate(qr, { small: true }, (out: string) => {
      process.stderr.write(`\nScan with WhatsApp → Linked devices → Link a device:\n${out}\n`);
    });
  });
  session.on('logged_out', () => guardrails.audit.record({ action: 'logged_out', result: 'ok' }));

  const httpOpts = {
    host: config.host,
    port: config.port,
    token: config.token,
    allowRemote: config.allowRemote,
    allowUrlToken: config.allowUrlToken,
  };
  const app = createApp(ctx, httpOpts);
  const server = await listen(app, httpOpts);
  logger.info({ url: `${baseUrl}/mcp` }, 'MCP endpoint listening (Streamable HTTP, bearer auth)');

  await session.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await session.stop();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
      db.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
