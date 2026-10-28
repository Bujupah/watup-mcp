import { initAuthCreds, type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap } from 'baileys';
import type pg from 'pg';
import { authCodec, type AuthStore, type KeyType } from './authStore.js';

/** The slice of a Postgres client the auth store needs (satisfied by node-postgres and PGlite). */
export interface PgQueryable {
  query<R extends object = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PgDatabase extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
}

/** Adapts a node-postgres Pool to PgDatabase. */
export function fromPgPool(pool: pg.Pool): PgDatabase {
  return {
    query: async <R extends object>(text: string, params?: unknown[]) => {
      const res = await pool.query(text, params);
      return { rows: res.rows as R[] };
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async <R extends object>(text: string, params?: unknown[]) => {
            const res = await client.query(text, params);
            return { rows: res.rows as R[] };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Tables live in their own schema, which Supabase does not expose through its REST API.
 * RLS is enabled with no policies, so only the owning role (used by this server) can read them.
 */
const SCHEMA = 'whatsapp_mcp';
const MIGRATIONS = [
  `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA}.auth_creds (
     account_id TEXT PRIMARY KEY,
     value BYTEA NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ${SCHEMA}.auth_keys (
     account_id TEXT NOT NULL,
     type TEXT NOT NULL,
     id TEXT NOT NULL,
     value BYTEA NOT NULL,
     PRIMARY KEY (account_id, type, id)
   )`,
  `ALTER TABLE ${SCHEMA}.auth_creds ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${SCHEMA}.auth_keys ENABLE ROW LEVEL SECURITY`,
];

export async function migratePg(db: PgQueryable): Promise<void> {
  for (const sql of MIGRATIONS) await db.query(sql);
}

const toBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array));

/**
 * A Baileys AuthenticationState persisted in Postgres (e.g. Supabase), so a host without a
 * persistent disk keeps the WhatsApp link across restarts. Values are encrypted with the
 * master key before they leave the process (see authCodec).
 */
export async function usePgAuthState(db: PgDatabase, accountId: string, masterKey: Buffer): Promise<AuthStore> {
  await migratePg(db);
  const codec = authCodec(accountId, masterKey);

  const { rows } = await db.query<{ value: unknown }>(`SELECT value FROM ${SCHEMA}.auth_creds WHERE account_id = $1`, [accountId]);
  let stored = rows.length > 0;
  let creds: AuthenticationCreds = rows[0] ? codec.openCreds(toBuffer(rows[0].value)) : initAuthCreds();

  const state: AuthenticationState = {
    get creds() {
      return creds;
    },
    set creds(c: AuthenticationCreds) {
      creds = c;
    },
    keys: {
      get: async <T extends KeyType>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (ids.length === 0) return out;
        const res = await db.query<{ id: string; value: unknown }>(
          `SELECT id, value FROM ${SCHEMA}.auth_keys WHERE account_id = $1 AND type = $2 AND id = ANY($3::text[])`,
          [accountId, type, ids],
        );
        for (const r of res.rows) out[r.id] = codec.openKey(type, r.id, toBuffer(r.value));
        return out;
      },
      // One statement per key type and operation, not one round trip per key.
      set: async (data: SignalDataSet) => {
        await db.transaction(async (tx) => {
          for (const type of Object.keys(data) as KeyType[]) {
            const entries = data[type];
            if (!entries) continue;
            const del: string[] = [];
            const upIds: string[] = [];
            const upVals: Buffer[] = [];
            for (const [id, value] of Object.entries(entries)) {
              if (value === null || value === undefined) del.push(id);
              else {
                upIds.push(id);
                upVals.push(codec.sealKey(type, id, value));
              }
            }
            if (del.length) {
              await tx.query(`DELETE FROM ${SCHEMA}.auth_keys WHERE account_id = $1 AND type = $2 AND id = ANY($3::text[])`, [
                accountId,
                type,
                del,
              ]);
            }
            if (upIds.length) {
              await tx.query(
                `INSERT INTO ${SCHEMA}.auth_keys (account_id, type, id, value)
                 SELECT $1, $2, k.id, k.value FROM unnest($3::text[], $4::bytea[]) AS k(id, value)
                 ON CONFLICT (account_id, type, id) DO UPDATE SET value = EXCLUDED.value`,
                [accountId, type, upIds, upVals],
              );
            }
          }
        });
      },
      clear: async () => {
        await db.query(`DELETE FROM ${SCHEMA}.auth_keys WHERE account_id = $1`, [accountId]);
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await db.query(
        `INSERT INTO ${SCHEMA}.auth_creds (account_id, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (account_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [accountId, codec.sealCreds(creds)],
      );
      stored = true;
    },
    clear: async () => {
      await db.transaction(async (tx) => {
        await tx.query(`DELETE FROM ${SCHEMA}.auth_keys WHERE account_id = $1`, [accountId]);
        await tx.query(`DELETE FROM ${SCHEMA}.auth_creds WHERE account_id = $1`, [accountId]);
      });
      creds = initAuthCreds();
      stored = false;
    },
    hasStoredCreds: () => stored,
  };
}
