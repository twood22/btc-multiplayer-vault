BEGIN;

-- One server-issued, non-chain challenge per live Sigbash policy proof. The
-- random outpoint can never be funded by this application; a valid witness
-- proves the browser and Sigbash service jointly controlled the exact key
-- committed by the confirmed roster without risking vault funds.
CREATE TABLE sigbash_readiness_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  round_id text NOT NULL CHECK (
    round_id IN ('alicebobcarol', 'alicebob', 'alicecarol', 'bobcarol')
  ),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  input_txid bytea NOT NULL CHECK (octet_length(input_txid) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, participant_id, round_id)
    REFERENCES participant_sigbash_keys(vault_id, participant_id, round_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX sigbash_readiness_one_open_challenge_idx
  ON sigbash_readiness_challenges (vault_id, participant_id, round_id)
  WHERE consumed_at IS NULL;
CREATE INDEX sigbash_readiness_challenge_expiry_idx
  ON sigbash_readiness_challenges (expires_at);

CREATE TABLE participant_sigbash_readiness_proofs (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  round_id text NOT NULL CHECK (
    round_id IN ('alicebobcarol', 'alicebob', 'alicecarol', 'bobcarol')
  ),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  key_id text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 256),
  key_index integer NOT NULL CHECK (key_index BETWEEN 0 AND 63),
  challenge_id uuid NOT NULL UNIQUE REFERENCES sigbash_readiness_challenges(id) ON DELETE RESTRICT,
  proof_txid bytea NOT NULL CHECK (octet_length(proof_txid) = 32),
  evidence_hash bytea NOT NULL CHECK (octet_length(evidence_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id, round_id),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, participant_id, round_id)
    REFERENCES participant_sigbash_keys(vault_id, participant_id, round_id) ON DELETE CASCADE
);

CREATE INDEX participant_sigbash_readiness_vault_idx
  ON participant_sigbash_readiness_proofs (vault_id, participant_id);

INSERT INTO schema_migrations (version) VALUES ('006_sigbash_readiness');

COMMIT;
