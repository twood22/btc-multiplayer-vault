BEGIN;

CREATE TABLE presigned_chain_states (
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  epoch_id uuid PRIMARY KEY,
  graph_digest bytea NOT NULL CHECK (octet_length(graph_digest) = 32),
  state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
  state_digest bytea NOT NULL CHECK (octet_length(state_digest) = 32),
  snapshot_json jsonb CHECK (snapshot_json IS NULL OR jsonb_typeof(snapshot_json) = 'object'),
  last_polled_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  deferred_reason text,
  UNIQUE (vault_id, epoch_id),
  FOREIGN KEY (vault_id, protocol) REFERENCES presigned_ceremonies(vault_id, protocol) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, epoch_id) REFERENCES presigned_funding_epochs(vault_id, epoch_id) ON DELETE RESTRICT
);
CREATE TABLE presigned_chain_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vault_id uuid NOT NULL,
  epoch_id uuid NOT NULL,
  previous_state_digest bytea NOT NULL CHECK (octet_length(previous_state_digest) = 32),
  resulting_state_digest bytea NOT NULL CHECK (octet_length(resulting_state_digest) = 32),
  tip_hash bytea NOT NULL CHECK (octet_length(tip_hash) = 32),
  invalidated_txids jsonb NOT NULL CHECK (jsonb_typeof(invalidated_txids) = 'array'),
  added_txids jsonb NOT NULL CHECK (jsonb_typeof(added_txids) = 'array'),
  reanchored_txids jsonb NOT NULL CHECK (jsonb_typeof(reanchored_txids) = 'array'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id, epoch_id) REFERENCES presigned_chain_states(vault_id, epoch_id) ON DELETE RESTRICT
);

-- Exact public bytes are journalled before any send. A crash leaves a retryable
-- intent; it never creates a second authorization or edits a signed parent.
CREATE TABLE presigned_broadcast_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  epoch_id uuid NOT NULL,
  proposal_id uuid,
  kind text NOT NULL CHECK (kind IN ('funding', 'runtime', 'fee-package')),
  authorization_digest bytea NOT NULL CHECK (octet_length(authorization_digest) = 32),
  transaction_json jsonb NOT NULL CHECK (jsonb_typeof(transaction_json) = 'array' AND
    jsonb_array_length(transaction_json) BETWEEN 1 AND 2 AND octet_length(transaction_json::text) <= 262144),
  txids_json jsonb NOT NULL CHECK (jsonb_typeof(txids_json) = 'array' AND
    jsonb_array_length(txids_json) = jsonb_array_length(transaction_json)),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'submitting', 'accepted', 'deferred')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (vault_id, authorization_digest),
  FOREIGN KEY (vault_id, protocol) REFERENCES presigned_ceremonies(vault_id, protocol) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, epoch_id) REFERENCES presigned_funding_epochs(vault_id, epoch_id) ON DELETE RESTRICT,
  FOREIGN KEY (proposal_id, vault_id) REFERENCES presigned_runtime_proposals(id, vault_id) ON DELETE RESTRICT,
  CHECK ((kind = 'funding' AND proposal_id IS NULL) OR (kind <> 'funding' AND proposal_id IS NOT NULL))
);
CREATE FUNCTION protect_presigned_broadcast_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.vault_id IS DISTINCT FROM OLD.vault_id OR NEW.protocol IS DISTINCT FROM OLD.protocol
    OR NEW.epoch_id IS DISTINCT FROM OLD.epoch_id OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest
    OR NEW.transaction_json IS DISTINCT FROM OLD.transaction_json OR NEW.txids_json IS DISTINCT FROM OLD.txids_json THEN
    RAISE EXCEPTION 'presigned broadcast authority and exact bytes are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_broadcast_intent_immutable BEFORE UPDATE ON presigned_broadcast_intents
  FOR EACH ROW EXECUTE FUNCTION protect_presigned_broadcast_intent();

INSERT INTO schema_migrations(version) VALUES ('018_presigned_chain_and_broadcast');
COMMIT;
