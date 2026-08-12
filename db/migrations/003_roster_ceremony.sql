BEGIN;

ALTER TABLE vaults
  DROP CONSTRAINT vaults_status_check,
  ADD CONSTRAINT vaults_status_check CHECK (
    status IN ('setup', 'roster_confirmed', 'ready', 'active', 'closed')
  );

ALTER TABLE vault_members
  ADD CONSTRAINT vault_members_full_identity_unique
    UNIQUE (vault_id, user_id, participant_id);

ALTER TABLE webauthn_credentials
  ADD CONSTRAINT webauthn_credentials_user_unique
    UNIQUE (credential_id, user_id);

CREATE TABLE participant_sigbash_keys (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  round_id text NOT NULL CHECK (round_id IN ('alicebobcarol', 'alicebob', 'alicecarol', 'bobcarol')),
  network text NOT NULL CHECK (network = 'mainnet'),
  key_id text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 256),
  key_index integer NOT NULL CHECK (key_index >= 0),
  bip328_xpub text NOT NULL CHECK (char_length(bip328_xpub) BETWEEN 100 AND 160),
  policy_leaf_xonly bytea NOT NULL CHECK (octet_length(policy_leaf_xonly) = 32),
  identification_leaf_xonly bytea NOT NULL CHECK (octet_length(identification_leaf_xonly) = 32),
  policy_root bytea NOT NULL CHECK (octet_length(policy_root) = 32),
  policy_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id, round_id),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  -- Sigbash key IDs and indices are scoped to a participant's service
  -- credentials; two independent participant organizations may both have key
  -- ID "0". The xpub itself remains globally unique.
  UNIQUE (user_id, key_id),
  UNIQUE (user_id, key_index),
  UNIQUE (bip328_xpub),
  CHECK (policy_leaf_xonly <> identification_leaf_xonly),
  CHECK (policy_id = round_id || ':' || participant_id)
);

CREATE TABLE vault_rosters (
  vault_id uuid PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version = 1),
  network text NOT NULL CHECK (network = 'mainnet'),
  artifact_json jsonb NOT NULL,
  digest bytea NOT NULL UNIQUE CHECK (octet_length(digest) = 32),
  funding_address text NOT NULL CHECK (funding_address LIKE 'bc1p%'),
  status text NOT NULL DEFAULT 'confirming' CHECK (status IN ('confirming', 'confirmed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

ALTER TABLE vault_rosters
  ADD CONSTRAINT vault_rosters_vault_digest_unique UNIQUE (vault_id, digest);

CREATE TABLE roster_confirmations (
  vault_id uuid NOT NULL REFERENCES vault_rosters(vault_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  credential_id text NOT NULL REFERENCES webauthn_credentials(credential_id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id),
  UNIQUE (vault_id, user_id),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id),
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE
);

ALTER TABLE webauthn_challenges
  ADD COLUMN roster_digest bytea CHECK (
    roster_digest IS NULL OR octet_length(roster_digest) = 32
  );

ALTER TABLE webauthn_challenges
  DROP CONSTRAINT webauthn_challenges_kind_check,
  DROP CONSTRAINT webauthn_challenges_shape_check;

ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_kind_check CHECK (
    kind IN (
      'registration', 'envelope', 'unlock', 'login',
      'recovery_authorize', 'recovery_registration', 'recovery_envelope',
      'roster_confirm'
    )
  ),
  ADD CONSTRAINT webauthn_challenges_shape_check CHECK (
    (kind = 'registration' AND invite_id IS NOT NULL AND prospective_user_id IS NOT NULL
      AND display_name IS NOT NULL AND user_id IS NULL AND credential_id IS NULL
      AND roster_digest IS NULL)
    OR (kind IN ('envelope', 'unlock', 'recovery_authorize', 'recovery_envelope')
      AND user_id IS NOT NULL AND credential_id IS NOT NULL AND roster_digest IS NULL)
    OR (kind = 'recovery_registration' AND user_id IS NOT NULL AND credential_id IS NULL
      AND roster_digest IS NULL)
    OR (kind = 'login' AND invite_id IS NULL AND user_id IS NULL
      AND prospective_user_id IS NULL AND credential_id IS NULL AND roster_digest IS NULL)
    OR (kind = 'roster_confirm' AND user_id IS NOT NULL AND credential_id IS NOT NULL
      AND roster_digest IS NOT NULL AND prf_salt IS NULL AND invite_id IS NULL
      AND prospective_user_id IS NULL AND display_name IS NULL)
  );

CREATE INDEX webauthn_challenges_roster_digest_idx
  ON webauthn_challenges (roster_digest) WHERE roster_digest IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('003_roster_ceremony');

COMMIT;
