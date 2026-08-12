BEGIN;

-- A passkey ceremony binds each participant to one independently observed,
-- server-verified mainnet UTXO and its exact change destination. No private
-- wallet material or signatures are stored here.
CREATE TABLE funding_input_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  credential_id text NOT NULL,
  challenge text NOT NULL,
  txid bytea NOT NULL CHECK (octet_length(txid) = 32),
  vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
  value_sats bigint NOT NULL CHECK (value_sats > 0),
  script_pubkey bytea NOT NULL CHECK (octet_length(script_pubkey) IN (22, 34)),
  change_address text CHECK (change_address IS NULL OR char_length(change_address) BETWEEN 14 AND 90),
  source_origin text NOT NULL CHECK (char_length(source_origin) BETWEEN 9 AND 255),
  confirmations integer NOT NULL CHECK (confirmations BETWEEN 1 AND 2000000),
  funding_fee_sats bigint NOT NULL CHECK (funding_fee_sats >= 500),
  commitment_digest bytea NOT NULL CHECK (octet_length(commitment_digest) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX funding_input_one_open_challenge_idx
  ON funding_input_challenges (vault_id, participant_id)
  WHERE consumed_at IS NULL;
CREATE INDEX funding_input_challenge_expiry_idx
  ON funding_input_challenges (expires_at);

CREATE TABLE participant_funding_inputs (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  txid bytea NOT NULL CHECK (octet_length(txid) = 32),
  vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
  value_sats bigint NOT NULL CHECK (value_sats > 0),
  script_pubkey bytea NOT NULL CHECK (octet_length(script_pubkey) IN (22, 34)),
  change_address text CHECK (change_address IS NULL OR char_length(change_address) BETWEEN 14 AND 90),
  source_origin text NOT NULL CHECK (char_length(source_origin) BETWEEN 9 AND 255),
  confirmations integer NOT NULL CHECK (confirmations BETWEEN 1 AND 2000000),
  funding_fee_sats bigint NOT NULL CHECK (funding_fee_sats >= 500),
  commitment_digest bytea NOT NULL CHECK (octet_length(commitment_digest) = 32),
  credential_id text NOT NULL,
  challenge_id uuid NOT NULL UNIQUE REFERENCES funding_input_challenges(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id),
  UNIQUE (txid, vout),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX participant_funding_inputs_vault_idx
  ON participant_funding_inputs (vault_id, participant_id);

INSERT INTO schema_migrations (version) VALUES ('009_funding_ceremony');

COMMIT;
