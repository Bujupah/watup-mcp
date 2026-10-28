import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys';
import type { DB } from '../db/db.js';
import { decrypt, encrypt } from '../crypto.js';

export interface SqliteAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Deletes all stored credentials and keys for the account. */
  clear: () => Promise<void>;
  /** True if credentials were loaded from disk (i.e. the device was linked before). */
  hasStoredCreds: () => boolean;
}

type KeyType = keyof SignalDataTypeMap;

/**
 * A Baileys AuthenticationState persisted in SQLite, with every value encrypted
 * using AES-256-GCM. The row identity (account/type/id) is bound as AAD so that
 * ciphertexts cannot be swapped between rows.
 */
export async function useSqliteAuthState(db: DB, accountId: string, masterKey: Buffer): Promise<SqliteAuthState> {
  const selCreds = db.prepare<[string], { value: Buffer }>('SELECT value FROM auth_creds WHERE account_id = ?');
  const upsertCreds = db.prepare<[string, Buffer, number]>(
    `INSERT INTO auth_creds (account_id, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const selKey = db.prepare<[string, string, string], { value: Buffer }>(
    'SELECT value FROM auth_keys WHERE account_id = ? AND type = ? AND id = ?',
  );
  const upsertKey = db.prepare<[string, string, string, Buffer]>(
    `INSERT INTO auth_keys (account_id, type, id, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, type, id) DO UPDATE SET value = excluded.value`,
  );
  const delKey = db.prepare<[string, string, string]>('DELETE FROM auth_keys WHERE account_id = ? AND type = ? AND id = ?');
  const delAllKeys = db.prepare<[string]>('DELETE FROM auth_keys WHERE account_id = ?');
  const delCreds = db.prepare<[string]>('DELETE FROM auth_creds WHERE account_id = ?');

  const credsAad = `${accountId}:creds`;
  const keyAad = (type: string, id: string) => `${accountId}:key:${type}:${id}`;

  const seal = (value: unknown, aad: string): Buffer => encrypt(JSON.stringify(value, BufferJSON.replacer), masterKey, aad);
  const open = <T>(blob: Buffer, aad: string): T => JSON.parse(decrypt(blob, masterKey, aad).toString('utf8'), BufferJSON.reviver) as T;

  const row = selCreds.get(accountId);
  let stored = row !== undefined;
  let creds: AuthenticationCreds = row ? open<AuthenticationCreds>(row.value, credsAad) : initAuthCreds();

  const setKeys = db.transaction((data: SignalDataSet) => {
    for (const type of Object.keys(data) as KeyType[]) {
      const entries = data[type];
      if (!entries) continue;
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) delKey.run(accountId, type, id);
        else upsertKey.run(accountId, type, id, seal(value, keyAad(type, id)));
      }
    }
  });

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
        for (const id of ids) {
          const r = selKey.get(accountId, type, id);
          if (!r) continue;
          let value = open<SignalDataTypeMap[T]>(r.value, keyAad(type, id));
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
          }
          out[id] = value;
        }
        return out;
      },
      set: async (data: SignalDataSet) => {
        setKeys(data);
      },
      clear: async () => {
        delAllKeys.run(accountId);
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      upsertCreds.run(accountId, seal(creds, credsAad), Date.now());
      stored = true;
    },
    clear: async () => {
      db.transaction(() => {
        delAllKeys.run(accountId);
        delCreds.run(accountId);
      })();
      creds = initAuthCreds();
      stored = false;
    },
    hasStoredCreds: () => stored,
  };
}
