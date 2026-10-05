-- Frontier schema. Money is integer cents everywhere (BIGINT *_cents columns).

CREATE TABLE users (
  id                BIGSERIAL PRIMARY KEY,
  username          TEXT NOT NULL,
  email             TEXT,
  cash_cents        BIGINT NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  lawyers           INT NOT NULL DEFAULT 0 CHECK (lawyers >= 0),
  permits           INT NOT NULL DEFAULT 0 CHECK (permits >= 0),
  spooks            INT NOT NULL DEFAULT 0 CHECK (spooks >= 0),
  flares            INT NOT NULL DEFAULT 0 CHECK (flares >= 0),
  created_at        TIMESTAMPTZ NOT NULL,
  -- Last app open / activity; anchors the 12-hour salary window.
  last_open_at      TIMESTAMPTZ NOT NULL,
  -- Start of unpaid eligible salary time.
  salary_settled_at TIMESTAMPTZ NOT NULL,
  -- Last time income was settled (salary + rent).
  income_settled_at TIMESTAMPTZ NOT NULL,
  -- Start of the "since last login" summary window.
  summary_from      TIMESTAMPTZ NOT NULL,
  last_fix_lat      DOUBLE PRECISION,
  last_fix_lng      DOUBLE PRECISION,
  last_fix_at       TIMESTAMPTZ,
  last_fix_acc      REAL,
  last_purchase_at  TIMESTAMPTZ,
  is_admin          BOOLEAN NOT NULL DEFAULT false,
  frozen            BOOLEAN NOT NULL DEFAULT false,
  deleted_at        TIMESTAMPTZ,
  signup_ip         TEXT
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX users_last_open ON users (last_open_at) WHERE deleted_at IS NULL;

-- One row per parcel ever bought and still owned. Unowned land has no row.
CREATE TABLE parcels (
  id               TEXT PRIMARY KEY,           -- 'gy:gx'
  gy               INT NOT NULL,
  gx               INT NOT NULL,
  owner_id         BIGINT NOT NULL REFERENCES users(id),
  price_paid_cents BIGINT NOT NULL,
  -- Land max price, whole dollars as cents; the store premium is added on top when has_store.
  max_price_cents  BIGINT NOT NULL,
  last_visit_at    TIMESTAMPTZ NOT NULL,
  purchased_at     TIMESTAMPTZ NOT NULL,
  locked_until     TIMESTAMPTZ NOT NULL,
  rent_settled_at  TIMESTAMPTZ NOT NULL,
  has_spook        BOOLEAN NOT NULL DEFAULT false,
  has_store        BOOLEAN NOT NULL DEFAULT false,
  store_built_at   TIMESTAMPTZ,
  UNIQUE (gy, gx)
);
CREATE INDEX parcels_owner ON parcels (owner_id, rent_settled_at);
CREATE INDEX parcels_gx_gy ON parcels (gx, gy);

-- Append-only record of every money movement. A user's cash equals the sum of their rows.
CREATE TABLE ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  time          TIMESTAMPTZ NOT NULL,
  type          TEXT NOT NULL,
  amount_cents  BIGINT NOT NULL,
  parcel_id     TEXT,
  other_user_id BIGINT REFERENCES users(id),
  note          TEXT
);
CREATE INDEX ledger_user_time ON ledger (user_id, time);
CREATE INDEX ledger_type_user ON ledger (type, user_id);

-- Ownership history per parcel.
CREATE TABLE deeds (
  id           BIGSERIAL PRIMARY KEY,
  parcel_id    TEXT NOT NULL,
  time         TIMESTAMPTZ NOT NULL,
  from_user    BIGINT REFERENCES users(id),
  to_user      BIGINT REFERENCES users(id),
  price_cents  BIGINT NOT NULL,
  seller_cents BIGINT NOT NULL DEFAULT 0,
  via_lawyer   BOOLEAN NOT NULL DEFAULT false,
  spook        TEXT,                -- NULL, 'triggered', 'flared', 'fizzled'
  spook_cents  BIGINT NOT NULL DEFAULT 0,
  had_store    BOOLEAN NOT NULL DEFAULT false,
  kind         TEXT NOT NULL DEFAULT 'sale'  -- 'sale' or 'release'
);
CREATE INDEX deeds_parcel ON deeds (parcel_id, time DESC);
CREATE INDEX deeds_from ON deeds (from_user, time);
CREATE INDEX deeds_to ON deeds (to_user, time);

CREATE TABLE prizes (
  id           BIGSERIAL PRIMARY KEY,
  parcel_id    TEXT NOT NULL,
  gy           INT NOT NULL,
  gx           INT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('cash', 'lawyer')),
  amount_cents BIGINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  claimed_by   BIGINT REFERENCES users(id),
  claimed_at   TIMESTAMPTZ,
  spawned_for  BIGINT
);
CREATE INDEX prizes_cell ON prizes (gx, gy) WHERE claimed_by IS NULL;
CREATE INDEX prizes_claimed ON prizes (claimed_by, claimed_at);

CREATE TABLE leaderboards (
  date    DATE NOT NULL,
  board   TEXT NOT NULL,
  scope   TEXT NOT NULL,
  rank    INT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  value   BIGINT NOT NULL,
  PRIMARY KEY (date, board, scope, rank)
);
CREATE INDEX leaderboards_user ON leaderboards (date, board, user_id);

CREATE TABLE push_subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX push_user ON push_subscriptions (user_id);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Email magic links / codes.
CREATE TABLE login_requests (
  id                BIGSERIAL PRIMARY KEY,
  email             TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  code_hash         TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  attempts          INT NOT NULL DEFAULT 0,
  ip                TEXT,
  signup_token_hash TEXT UNIQUE
);
CREATE INDEX login_requests_email ON login_requests (lower(email), created_at);

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  public_key    BYTEA NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[],
  created_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE idempotency (
  user_id    BIGINT NOT NULL,
  key        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  status     INT,
  response   JSONB,
  PRIMARY KEY (user_id, key)
);

-- Every fix received, accepted or not, for review. Pruned by the nightly job.
CREATE TABLE fix_log (
  id       BIGSERIAL PRIMARY KEY,
  user_id  BIGINT NOT NULL REFERENCES users(id),
  time     TIMESTAMPTZ NOT NULL,
  lat      DOUBLE PRECISION,
  lng      DOUBLE PRECISION,
  accuracy REAL,
  accepted BOOLEAN NOT NULL,
  reason   TEXT
);
CREATE INDEX fix_log_user_time ON fix_log (user_id, time DESC);

CREATE TABLE flags (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by BIGINT REFERENCES users(id),
  note        TEXT
);
CREATE INDEX flags_open ON flags (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX flags_user ON flags (user_id, kind, created_at DESC);

CREATE TABLE promotions (
  id         BIGSERIAL PRIMARY KEY,
  parcel_id  TEXT NOT NULL,
  gy         INT NOT NULL,
  gx         INT NOT NULL,
  business   TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  url        TEXT,
  starts_at  TIMESTAMPTZ,
  ends_at    TIMESTAMPTZ,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX promotions_cell ON promotions (gx, gy) WHERE active;

CREATE TABLE qr_stations (
  id         BIGSERIAL PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  parcel_id  TEXT NOT NULL,
  gy         INT NOT NULL,
  gx         INT NOT NULL,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE qr_redemptions (
  id         BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES qr_stations(id),
  user_id    BIGINT NOT NULL REFERENCES users(id),
  time       TIMESTAMPTZ NOT NULL
);
CREATE INDEX qr_redemptions_lookup ON qr_redemptions (station_id, user_id, time DESC);

CREATE TABLE job_runs (
  job         TEXT NOT NULL,
  day         DATE NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  result      JSONB,
  PRIMARY KEY (job, day)
);

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
