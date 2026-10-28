import pg from 'pg';
import type { Logger } from 'pino';

/**
 * Creates a small Postgres pool for the auth store. TLS is always on. With a CA certificate
 * (WA_MCP_AUTH_DATABASE_CA, e.g. Supabase's "Download certificate") the server is verified;
 * without one the connection is encrypted but unverified. Every stored value is already
 * AES-256-GCM encrypted and authenticated with the master key, so the database (or anyone in
 * between) only ever sees ciphertext and any tampering is detected.
 */
export function createAuthPool(url: string, ca: string | undefined, logger: Logger): pg.Pool {
  const u = new URL(url);
  // TLS is configured below; ssl* query parameters would override it.
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('ssl')) u.searchParams.delete(k);
  if (!ca) {
    logger.warn(
      'WA_MCP_AUTH_DATABASE_CA is not set: the Postgres TLS certificate is not verified. Stored values are still ' +
        'encrypted and authenticated with WA_MCP_MASTER_KEY.',
    );
  }
  const pool = new pg.Pool({
    connectionString: u.toString(),
    ssl: ca ? { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => logger.error({ err: err.message }, 'Postgres pool error'));
  return pool;
}

/** Host and database name only, for logs (never the password). */
export function describeDbUrl(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || 5432}${u.pathname}`;
}
