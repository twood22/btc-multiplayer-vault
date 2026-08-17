BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'ready', 'active', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vault_members (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id),
  UNIQUE (vault_id, user_id)
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  suggested_name text CHECK (suggested_name IS NULL OR char_length(suggested_name) BETWEEN 1 AND 80),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invites_vault_seat_idx ON invites (vault_id, participant_id);

CREATE TABLE webauthn_credentials (
  credential_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL,
  prf_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE passkey_envelopes (
  credential_id text PRIMARY KEY REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version = 1),
  prf_salt bytea NOT NULL CHECK (octet_length(prf_salt) = 32),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 33 AND 512),
  aad bytea NOT NULL CHECK (octet_length(aad) BETWEEN 16 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

CREATE TABLE participant_key_material (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  personal_public_key bytea NOT NULL CHECK (octet_length(personal_public_key) = 33),
  payout_xonly_public_key bytea NOT NULL CHECK (octet_length(payout_xonly_public_key) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, participant_id),
  UNIQUE (personal_public_key),
  UNIQUE (payout_xonly_public_key)
);

CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('registration', 'envelope', 'unlock', 'login')),
  challenge text NOT NULL,
  invite_id uuid REFERENCES invites(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  prospective_user_id uuid,
  display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 80),
  prf_salt bytea CHECK (prf_salt IS NULL OR octet_length(prf_salt) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'registration' AND invite_id IS NOT NULL AND prospective_user_id IS NOT NULL AND display_name IS NOT NULL)
    OR (kind IN ('envelope', 'unlock') AND user_id IS NOT NULL)
    OR (kind = 'login' AND invite_id IS NULL AND user_id IS NULL AND prospective_user_id IS NULL)
  )
);

CREATE INDEX webauthn_challenges_expiry_idx ON webauthn_challenges (expires_at);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

INSERT INTO schema_migrations (version) VALUES ('001_passkey_custody');

COMMIT;
