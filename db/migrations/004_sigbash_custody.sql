BEGIN;

ALTER TABLE participant_key_material
  ADD CONSTRAINT participant_key_material_full_identity_unique
    UNIQUE (user_id, vault_id, participant_id);

CREATE TABLE participant_sigbash_custody_versions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 32),
  version integer NOT NULL CHECK (version = 1),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 128 AND 65552),
  aad bytea NOT NULL CHECK (octet_length(aad) BETWEEN 64 AND 512),
  envelope_hash bytea NOT NULL CHECK (octet_length(envelope_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, revision),
  FOREIGN KEY (user_id, vault_id, participant_id)
    REFERENCES participant_key_material(user_id, vault_id, participant_id) ON DELETE CASCADE
);

CREATE TABLE sigbash_custody_leases (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE,
  writes_remaining integer NOT NULL DEFAULT 12 CHECK (writes_remaining BETWEEN 0 AND 12),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id)
);

CREATE INDEX sigbash_custody_leases_expiry_idx ON sigbash_custody_leases (expires_at);

ALTER TABLE webauthn_challenges
  DROP CONSTRAINT webauthn_challenges_kind_check,
  DROP CONSTRAINT webauthn_challenges_shape_check;

ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_kind_check CHECK (
    kind IN (
      'registration', 'envelope', 'unlock', 'login',
      'recovery_authorize', 'recovery_registration', 'recovery_envelope',
      'roster_confirm', 'sigbash_custody'
    )
  ),
  ADD CONSTRAINT webauthn_challenges_shape_check CHECK (
    (kind = 'registration' AND invite_id IS NOT NULL AND prospective_user_id IS NOT NULL
      AND display_name IS NOT NULL AND user_id IS NULL AND credential_id IS NULL
      AND roster_digest IS NULL)
    OR (kind IN ('envelope', 'unlock', 'recovery_authorize', 'recovery_envelope', 'sigbash_custody')
      AND user_id IS NOT NULL AND credential_id IS NOT NULL AND roster_digest IS NULL)
    OR (kind = 'recovery_registration' AND user_id IS NOT NULL AND credential_id IS NULL
      AND roster_digest IS NULL)
    OR (kind = 'login' AND invite_id IS NULL AND user_id IS NULL
      AND prospective_user_id IS NULL AND credential_id IS NULL AND roster_digest IS NULL)
    OR (kind = 'roster_confirm' AND user_id IS NOT NULL AND credential_id IS NOT NULL
      AND roster_digest IS NOT NULL AND prf_salt IS NULL AND invite_id IS NULL
      AND prospective_user_id IS NULL AND display_name IS NULL)
  );

INSERT INTO schema_migrations (version) VALUES ('004_sigbash_custody');

COMMIT;
