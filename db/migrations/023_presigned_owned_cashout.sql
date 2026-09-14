BEGIN;

-- Separate owner-only coins after payout: this grants no new vault branch,
-- quorum, fee modification, or authority over another participant's refund.
CREATE TABLE presigned_cashout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('presigned-graph-v2','presigned-graph-v3')),
  epoch_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_id text NOT NULL CHECK (participant_id IN ('alice','bob','carol')),
  artifact_json jsonb NOT NULL CHECK (jsonb_typeof(artifact_json) = 'object' AND octet_length(artifact_json::text) <= 1048576),
  artifact_digest bytea NOT NULL CHECK (octet_length(artifact_digest) = 32),
  graph_digest bytea NOT NULL CHECK (octet_length(graph_digest) = 32),
  txid bytea NOT NULL CHECK (octet_length(txid) = 32),
  source_txid bytea NOT NULL CHECK (octet_length(source_txid) = 32),
  source_vout bigint NOT NULL CHECK (source_vout BETWEEN 0 AND 4294967295),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','prepared','submitting','pending','confirmed','spent','deferred')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code integer,
  reason text,
  confirmation_block_hash bytea CHECK (confirmation_block_hash IS NULL OR octet_length(confirmation_block_hash) = 32),
  confirmation_height integer CHECK (confirmation_height IS NULL OR confirmation_height >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  UNIQUE (vault_id,user_id,txid),
  FOREIGN KEY (vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE RESTRICT,
  FOREIGN KEY (vault_id,epoch_id) REFERENCES presigned_funding_epochs(vault_id,epoch_id) ON DELETE RESTRICT,
  FOREIGN KEY (vault_id,user_id) REFERENCES vault_members(vault_id,user_id) ON DELETE RESTRICT,
  CHECK (public.presigned_json_protocol_matches(artifact_json->'cashout', protocol)
    AND public.presigned_json_protocol_matches(artifact_json->'request'->'publicKit', protocol)
    AND COALESCE(artifact_json->'cashout'->>'participantId' = participant_id
      AND artifact_json->'request'->>'participantId' = participant_id
      AND artifact_json->'cashout'->>'graphDigest' = encode(graph_digest,'hex')
      AND artifact_json->'cashout'->>'txid' = encode(txid,'hex')
      AND artifact_json->'cashout'->'source'->>'txid' = encode(source_txid,'hex')
      AND artifact_json->'cashout'->'source'->>'vout' = source_vout::text, false))
);
CREATE INDEX presigned_cashout_retry_idx ON presigned_cashout_intents(protocol,updated_at,id)
  WHERE status <> 'approved';
CREATE FUNCTION protect_presigned_cashout_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.vault_id IS DISTINCT FROM OLD.vault_id
    OR NEW.protocol IS DISTINCT FROM OLD.protocol OR NEW.epoch_id IS DISTINCT FROM OLD.epoch_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
    OR NEW.artifact_json IS DISTINCT FROM OLD.artifact_json OR NEW.artifact_digest IS DISTINCT FROM OLD.artifact_digest
    OR NEW.graph_digest IS DISTINCT FROM OLD.graph_digest OR NEW.txid IS DISTINCT FROM OLD.txid
    OR NEW.source_txid IS DISTINCT FROM OLD.source_txid OR NEW.source_vout IS DISTINCT FROM OLD.source_vout THEN
    RAISE EXCEPTION 'owner cash-out artifact and exact transaction are immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'owner cash-out attempt history cannot go backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_cashout_intent_immutable BEFORE UPDATE ON presigned_cashout_intents
  FOR EACH ROW EXECUTE FUNCTION protect_presigned_cashout_intent();

INSERT INTO schema_migrations(version) VALUES ('023_presigned_owned_cashout');
COMMIT;
