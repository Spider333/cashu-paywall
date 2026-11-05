-- cashu-paywall schema v1 (PRD 1, section 6.3). D1 / SQLite. Forward-only: to roll back, drop the tables in a new migration.

-- Prepaid keys. Only the HMAC of the key is stored, never the key.
CREATE TABLE ecash_keys (
  key_hash        TEXT PRIMARY KEY,
  kid             TEXT NOT NULL UNIQUE,
  mint_url        TEXT,
  unit            TEXT NOT NULL DEFAULT 'sat' CHECK (unit = 'sat'),
  balance         INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  credited_total  INTEGER NOT NULL DEFAULT 0,
  spent_total     INTEGER NOT NULL DEFAULT 0,
  refunded_total  INTEGER NOT NULL DEFAULT 0,
  calls           INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX idx_keys_mint ON ecash_keys (mint_url);
CREATE INDEX idx_keys_unfunded ON ecash_keys (credited_total, created_at);

-- Proofs the Worker holds (the pot). The proof itself is sealed with AES-GCM.
CREATE TABLE ecash_proofs (
  y           TEXT PRIMARY KEY,
  mint_url    TEXT NOT NULL,
  keyset_id   TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  sealed      TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'unspent' CHECK (state IN ('unspent','reserved','spent')),
  op_id       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_proofs_pot ON ecash_proofs (mint_url, state, amount);
CREATE INDEX idx_proofs_op ON ecash_proofs (op_id);

-- Every operation that talks to a mint is written here BEFORE the mint call.
CREATE TABLE ecash_ops (
  op_id          TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('topup_token','topup_lightning','refund','melt')),
  status         TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  key_hash       TEXT,
  mint_url       TEXT NOT NULL,
  input_id       TEXT UNIQUE,
  amount         INTEGER NOT NULL,
  fee            INTEGER,
  credited       INTEGER,
  keyset_id      TEXT,
  counter_start  INTEGER,
  counter_count  INTEGER,
  detail         TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_ops_status ON ecash_ops (status, kind, updated_at);
CREATE INDEX idx_ops_key ON ecash_ops (key_hash, created_at);

-- NUT-13 deterministic counter per keyset (implements cashu-ts CounterSource).
CREATE TABLE ecash_counters (
  keyset_id  TEXT PRIMARY KEY,
  next       INTEGER NOT NULL
);

-- Cached mint info + keysets (avoid a mint round trip per request).
CREATE TABLE ecash_mint_cache (
  mint_url    TEXT PRIMARY KEY,
  info_json   TEXT NOT NULL,
  keys_json   TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);
