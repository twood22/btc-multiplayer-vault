BEGIN;

-- Confirmation is not a permanent state: retain the exact active-chain block
-- that justified each coordinator transition so the watcher can detect and
-- atomically reverse a later mainnet reorganization. The paired-null checks
-- keep pre-migration rows readable while refusing half-written anchors.
ALTER TABLE funding_finalizations
  ADD COLUMN confirmed_height bigint,
  ADD COLUMN confirmed_block_hash bytea,
  ADD CONSTRAINT funding_finalizations_confirmation_anchor_check CHECK (
    (confirmed_height IS NULL AND confirmed_block_hash IS NULL)
    OR (
      confirmed_height IS NOT NULL
      AND confirmed_block_hash IS NOT NULL
      AND confirmed_height > 0
      AND octet_length(confirmed_block_hash) = 32
    )
  );

ALTER TABLE vault_transaction_proposals
  ADD COLUMN confirmed_height bigint,
  ADD COLUMN confirmed_block_hash bytea,
  ADD CONSTRAINT vault_transaction_proposals_confirmation_anchor_check CHECK (
    (confirmed_height IS NULL AND confirmed_block_hash IS NULL)
    OR (
      confirmed_height IS NOT NULL
      AND confirmed_block_hash IS NOT NULL
      AND confirmed_height > 0
      AND octet_length(confirmed_block_hash) = 32
    )
  );

-- Public chain fingerprints only. This is immutable evidence that a confirmed
-- coordinator transition was either reanchored to a new active-chain block or
-- rolled back before any new signing could proceed.
CREATE TABLE chain_reorganization_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
  event_scope text NOT NULL CHECK (event_scope IN ('funding', 'vault_transition')),
  action text NOT NULL CHECK (action IN ('reanchored', 'rolled_back')),
  proposal_id uuid REFERENCES vault_transaction_proposals(id) ON DELETE RESTRICT,
  txid bytea NOT NULL CHECK (octet_length(txid) = 32),
  prior_confirmed_height bigint NOT NULL CHECK (prior_confirmed_height > 0),
  prior_block_hash bytea NOT NULL CHECK (octet_length(prior_block_hash) = 32),
  replacement_confirmed_height bigint CHECK (
    replacement_confirmed_height IS NULL OR replacement_confirmed_height > 0
  ),
  replacement_block_hash bytea CHECK (
    replacement_block_hash IS NULL OR octet_length(replacement_block_hash) = 32
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_scope = 'funding' AND proposal_id IS NULL)
    OR (event_scope = 'vault_transition' AND proposal_id IS NOT NULL)
  ),
  CHECK (
    (action = 'rolled_back'
      AND replacement_confirmed_height IS NULL
      AND replacement_block_hash IS NULL)
    OR (action = 'reanchored'
      AND replacement_confirmed_height IS NOT NULL
      AND replacement_block_hash IS NOT NULL)
  )
);

CREATE INDEX chain_reorganization_events_vault_idx
  ON chain_reorganization_events (vault_id, created_at DESC);
CREATE INDEX chain_reorganization_events_tx_idx
  ON chain_reorganization_events (event_scope, txid, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('012_chain_reorganization');

COMMIT;
