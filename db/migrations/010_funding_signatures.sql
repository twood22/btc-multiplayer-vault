BEGIN;

CREATE TABLE funding_signature_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  proposal_digest bytea NOT NULL CHECK (octet_length(proposal_digest) = 32),
  input_index integer NOT NULL CHECK (input_index BETWEEN 0 AND 2),
  signature_kind text NOT NULL CHECK (signature_kind IN ('p2wpkh', 'p2tr')),
  signature bytea NOT NULL CHECK (octet_length(signature) BETWEEN 9 AND 73),
  public_key bytea CHECK (public_key IS NULL OR octet_length(public_key) = 33),
  contribution_digest bytea NOT NULL CHECK (octet_length(contribution_digest) = 32),
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
    REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE CASCADE,
  CHECK (
    (signature_kind = 'p2wpkh' AND public_key IS NOT NULL)
    OR (signature_kind = 'p2tr' AND public_key IS NULL AND octet_length(signature) IN (64, 65))
  )
);

CREATE UNIQUE INDEX funding_signature_one_open_challenge_idx
  ON funding_signature_challenges (vault_id, participant_id)
  WHERE consumed_at IS NULL;
CREATE INDEX funding_signature_challenge_expiry_idx
  ON funding_signature_challenges (expires_at);

CREATE TABLE participant_funding_signatures (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  proposal_digest bytea NOT NULL CHECK (octet_length(proposal_digest) = 32),
  input_index integer NOT NULL CHECK (input_index BETWEEN 0 AND 2),
  signature_kind text NOT NULL CHECK (signature_kind IN ('p2wpkh', 'p2tr')),
  signature bytea NOT NULL CHECK (octet_length(signature) BETWEEN 9 AND 73),
  public_key bytea CHECK (public_key IS NULL OR octet_length(public_key) = 33),
  contribution_digest bytea NOT NULL CHECK (octet_length(contribution_digest) = 32),
  credential_id text NOT NULL,
  challenge_id uuid NOT NULL UNIQUE REFERENCES funding_signature_challenges(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id),
  UNIQUE (vault_id, input_index),
  UNIQUE (vault_id, contribution_digest),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (signature_kind = 'p2wpkh' AND public_key IS NOT NULL)
    OR (signature_kind = 'p2tr' AND public_key IS NULL AND octet_length(signature) IN (64, 65))
  )
);

CREATE TABLE funding_finalizations (
  vault_id uuid PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  roster_digest bytea NOT NULL CHECK (octet_length(roster_digest) = 32),
  proposal_digest bytea NOT NULL UNIQUE CHECK (octet_length(proposal_digest) = 32),
  finalization_digest bytea NOT NULL UNIQUE CHECK (octet_length(finalization_digest) = 32),
  final_txid bytea NOT NULL UNIQUE CHECK (octet_length(final_txid) = 32),
  transaction_hex text NOT NULL CHECK (
    char_length(transaction_hex) BETWEEN 20 AND 400000
    AND transaction_hex ~ '^[0-9a-f]+$'
  ),
  fee_sats bigint NOT NULL CHECK (fee_sats >= 500),
  vsize integer NOT NULL CHECK (vsize > 0),
  status text NOT NULL DEFAULT 'awaiting_approvals' CHECK (
    status IN ('awaiting_approvals', 'approved', 'submitting', 'broadcast', 'confirmed')
  ),
  finalized_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  submission_started_at timestamptz,
  broadcast_at timestamptz,
  confirmed_at timestamptz,
  broadcast_failure text CHECK (broadcast_failure IS NULL OR char_length(broadcast_failure) <= 500),
  UNIQUE (vault_id, finalization_digest),
  FOREIGN KEY (vault_id, roster_digest)
    REFERENCES vault_rosters(vault_id, digest) ON DELETE CASCADE,
  CHECK (
    (status = 'awaiting_approvals' AND approved_at IS NULL AND submission_started_at IS NULL
      AND broadcast_at IS NULL AND confirmed_at IS NULL)
    OR (status = 'approved' AND approved_at IS NOT NULL AND submission_started_at IS NULL
      AND broadcast_at IS NULL AND confirmed_at IS NULL)
    OR (status = 'submitting' AND approved_at IS NOT NULL AND submission_started_at IS NOT NULL
      AND broadcast_at IS NULL AND confirmed_at IS NULL)
    OR (status = 'broadcast' AND approved_at IS NOT NULL AND submission_started_at IS NOT NULL
      AND broadcast_at IS NOT NULL AND confirmed_at IS NULL)
    OR (status = 'confirmed' AND approved_at IS NOT NULL AND submission_started_at IS NOT NULL
      AND broadcast_at IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

CREATE TABLE funding_final_approval_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  finalization_digest bytea NOT NULL CHECK (octet_length(finalization_digest) = 32),
  credential_id text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, finalization_digest)
    REFERENCES funding_finalizations(vault_id, finalization_digest) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX funding_final_approval_one_open_challenge_idx
  ON funding_final_approval_challenges (vault_id, participant_id)
  WHERE consumed_at IS NULL;
CREATE INDEX funding_final_approval_challenge_expiry_idx
  ON funding_final_approval_challenges (expires_at);

CREATE TABLE funding_final_approvals (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  finalization_digest bytea NOT NULL CHECK (octet_length(finalization_digest) = 32),
  credential_id text NOT NULL,
  challenge_id uuid NOT NULL UNIQUE REFERENCES funding_final_approval_challenges(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, participant_id),
  UNIQUE (vault_id, user_id),
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, finalization_digest)
    REFERENCES funding_finalizations(vault_id, finalization_digest) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX funding_final_approvals_digest_idx
  ON funding_final_approvals (vault_id, finalization_digest);

INSERT INTO schema_migrations (version) VALUES ('010_funding_signatures');

COMMIT;
