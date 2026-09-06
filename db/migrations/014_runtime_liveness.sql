BEGIN;

-- Proposal creation is not the game's winner-selection mechanism. Independent
-- exits may compete for the same UTXO; only a confirmed spend advances it.
DROP INDEX vault_transaction_proposals_one_live_spend_idx;
CREATE UNIQUE INDEX vault_transaction_proposals_one_live_action_idx
  ON vault_transaction_proposals (input_coin_id, kind, COALESCE(actor_participant_id, ''))
  WHERE status IN ('collecting', 'finalized', 'broadcast');

DROP INDEX vault_broadcast_approvals_reconcile_idx;
CREATE INDEX vault_broadcast_approvals_reconcile_idx
  ON vault_broadcast_approvals (status, updated_at)
  WHERE status IN ('approved', 'submitting');

-- Repair the old concurrent-last-proof race without inventing any receipts.
UPDATE vaults v SET status = 'ready'
FROM vault_rosters r
WHERE v.id = r.vault_id AND v.status = 'roster_confirmed' AND r.status = 'confirmed'
  AND (SELECT count(*) FROM participant_sigbash_readiness_proofs p
       WHERE p.vault_id = v.id AND p.roster_digest = r.digest) = 9;

INSERT INTO schema_migrations (version) VALUES ('014_runtime_liveness');

COMMIT;
