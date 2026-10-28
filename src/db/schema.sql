-- Schema v1. Applied once by db.ts (tracked with PRAGMA user_version).

-- auth (all value columns encrypted: iv || authTag || ciphertext)
CREATE TABLE IF NOT EXISTS auth_creds (
  account_id TEXT PRIMARY KEY,
  value      BLOB NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_keys (
  account_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  id         TEXT NOT NULL,
  value      BLOB NOT NULL,
  PRIMARY KEY (account_id, type, id)
);

-- cache
CREATE TABLE IF NOT EXISTS contacts (
  jid        TEXT PRIMARY KEY,
  name       TEXT,
  notify     TEXT,
  phone      TEXT,
  lid        TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

CREATE TABLE IF NOT EXISTS chats (
  jid             TEXT PRIMARY KEY,
  name            TEXT,
  is_group        INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  unread          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chats_last ON chats(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT NOT NULL,
  chat_jid   TEXT NOT NULL,
  from_me    INTEGER NOT NULL DEFAULT 0,
  sender_jid TEXT,
  ts         INTEGER,
  type       TEXT,
  text       TEXT,
  raw        BLOB,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- LID <-> phone-number mapping learned from WhatsApp events
CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lid_map_pn ON lid_map(pn);

-- guardrails
CREATE TABLE IF NOT EXISTS drafts (
  id         TEXT PRIMARY KEY,
  to_jid     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  action        TEXT NOT NULL,
  to_jid        TEXT,
  draft_id      TEXT,
  result        TEXT,
  error         TEXT,
  new_recipient INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, ts);
