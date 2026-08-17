BEGIN;

-- A mainnet broadcast is a separate, explicit WebAuthn ceremony. Each approval
-- is bound to one finalized proposal and its exact transaction id. Failed or
-- interrupted attempts remain auditable and can be replaced only after they
-- leave the live states below.
CREATE TABLE vault_broadcast_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  vault_id uuid NOT NULL,
  proposal_digest bytea NOT NULL CHECK (octet_length(proposal_digest) = 32),
  final_txid bytea NOT NULL CHECK (octet_length(final_txid) = 32),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  credential_id text NOT NULL,
  challenge text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'submitting', 'broadcast', 'failed')
  ),
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  approved_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (proposal_id, vault_id, proposal_digest)
    REFERENCES vault_transaction_proposals(id, vault_id, proposal_digest) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, user_id, participant_id)
    REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id)
    REFERENCES webauthn_credentials(credential_id, user_id),
  CHECK (
    (status = 'pending' AND consumed_at IS NULL AND approved_at IS NULL)
    OR (status <> 'pending' AND consumed_at IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CHECK (
    (status = 'failed' AND failure_reason IS NOT NULL)
    OR (status <> 'failed' AND failure_reason IS NULL)
  )
);

CREATE UNIQUE INDEX vault_broadcast_approvals_one_live_idx
  ON vault_broadcast_approvals (proposal_id)
  WHERE status IN ('pending', 'approved', 'submitting', 'broadcast');
CREATE INDEX vault_broadcast_approvals_expiry_idx
  ON vault_broadcast_approvals (expires_at) WHERE status = 'pending';
CREATE INDEX vault_broadcast_approvals_reconcile_idx
  ON vault_broadcast_approvals (status, updated_at)
  WHERE status = 'submitting';

INSERT INTO schema_migrations (version) VALUES ('007_broadcast_approval');

COMMIT;
