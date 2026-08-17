BEGIN;

ALTER TABLE webauthn_credentials
  ADD COLUMN credential_name text NOT NULL DEFAULT 'Primary passkey'
    CHECK (char_length(credential_name) BETWEEN 1 AND 40);

ALTER TABLE webauthn_challenges
  ADD COLUMN credential_id text REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE;

-- Assertion challenges are five-minute capabilities. Drop any that predate exact
-- credential binding instead of attempting to guess which credential they meant.
DELETE FROM webauthn_challenges WHERE kind IN ('envelope', 'unlock');

ALTER TABLE webauthn_challenges
  DROP CONSTRAINT webauthn_challenges_kind_check,
  DROP CONSTRAINT webauthn_challenges_check;

ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_kind_check CHECK (
    kind IN (
      'registration', 'envelope', 'unlock', 'login',
      'recovery_authorize', 'recovery_registration', 'recovery_envelope'
    )
  ),
  ADD CONSTRAINT webauthn_challenges_shape_check CHECK (
    (kind = 'registration' AND invite_id IS NOT NULL AND prospective_user_id IS NOT NULL
      AND display_name IS NOT NULL AND user_id IS NULL AND credential_id IS NULL)
    OR (kind IN ('envelope', 'unlock', 'recovery_authorize', 'recovery_envelope')
      AND user_id IS NOT NULL AND credential_id IS NOT NULL)
    OR (kind = 'recovery_registration' AND user_id IS NOT NULL AND credential_id IS NULL)
    OR (kind = 'login' AND invite_id IS NULL AND user_id IS NULL
      AND prospective_user_id IS NULL AND credential_id IS NULL)
  );

CREATE TABLE recovery_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_credential_id text NOT NULL REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE,
  new_credential_id text UNIQUE REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (new_credential_id IS NULL OR new_credential_id <> source_credential_id)
);

ALTER TABLE webauthn_challenges
  ADD COLUMN recovery_enrollment_id uuid REFERENCES recovery_enrollments(id) ON DELETE CASCADE;

ALTER TABLE webauthn_challenges
  ADD CONSTRAINT webauthn_challenges_recovery_enrollment_check CHECK (
    (kind IN ('recovery_registration', 'recovery_envelope') AND recovery_enrollment_id IS NOT NULL)
    OR (kind NOT IN ('recovery_registration', 'recovery_envelope') AND recovery_enrollment_id IS NULL)
  );

CREATE INDEX webauthn_challenges_credential_idx ON webauthn_challenges (credential_id);
CREATE INDEX recovery_enrollments_user_idx ON recovery_enrollments (user_id, expires_at);

INSERT INTO schema_migrations (version) VALUES ('002_multi_passkey_recovery');

COMMIT;
