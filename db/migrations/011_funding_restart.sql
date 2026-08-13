BEGIN;

-- A restart invalidates wallet signatures, so it requires unanimous fresh
-- passkey approval for one exact pre-broadcast funding state and reason.
CREATE TABLE funding_restart_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  state_digest bytea NOT NULL CHECK (octet_length(state_digest) = 32),
  restart_digest bytea NOT NULL CHECK (octet_length(restart_digest) = 32),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  credential_id text NOT NULL,
  challenge text NOT NULL,
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

CREATE UNIQUE INDEX funding_restart_one_open_challenge_idx
  ON funding_restart_challenges (vault_id, participant_id)
  WHERE consumed_at IS NULL;
CREATE INDEX funding_restart_challenge_expiry_idx
  ON funding_restart_challenges (expires_at);

CREATE TABLE funding_restart_approvals (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  state_digest bytea NOT NULL CHECK (octet_length(state_digest) = 32),
  restart_digest bytea NOT NULL CHECK (octet_length(restart_digest) = 32),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  credential_id text NOT NULL,
  challenge_id uuid NOT NULL UNIQUE REFERENCES funding_restart_challenges(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id, restart_digest),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX funding_restart_approvals_state_idx
  ON funding_restart_approvals (vault_id, state_digest, restart_digest);

-- This audit record intentionally retains only public transaction-state
-- fingerprints, the user-supplied reason, and approver seats.
CREATE TABLE funding_restart_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  state_digest bytea NOT NULL CHECK (octet_length(state_digest) = 32),
  restart_digest bytea NOT NULL CHECK (octet_length(restart_digest) = 32),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  approved_participant_ids jsonb NOT NULL CHECK (jsonb_typeof(approved_participant_ids) = 'array'),
  restarted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, restart_digest),
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE RESTRICT
);

INSERT INTO schema_migrations (version) VALUES ('011_funding_restart');

COMMIT;
