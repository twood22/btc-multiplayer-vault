BEGIN;

-- State hashes authenticate values, not publication order. Every successful
-- or deferred observation advances this fence, including identical snapshots
-- and state transitions which return to an earlier digest after a reorg.
ALTER TABLE presigned_chain_states
  ADD COLUMN poll_revision bigint NOT NULL DEFAULT 0 CHECK (poll_revision >= 0);

-- Accepted transactions remain observable for reorg recovery. Rotate all
-- retryable records by last attempt instead of repeatedly selecting the first
-- 100 ever created. Eligibility and exact-authority checks remain unchanged.
CREATE INDEX presigned_broadcast_retry_order
  ON presigned_broadcast_intents (updated_at, id)
  WHERE kind IN ('funding', 'runtime');
CREATE INDEX presigned_fee_retry_order
  ON presigned_fee_packages (updated_at, id)
  WHERE status IN ('prepared', 'deferred', 'accepted', 'submitting');

INSERT INTO schema_migrations(version) VALUES ('021_presigned_watch_revision');
COMMIT;
