BEGIN;

CREATE TABLE presigned_runtime_proposals (
  id uuid PRIMARY KEY,
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  epoch_id uuid NOT NULL,
  graph_digest bytea NOT NULL CHECK (octet_length(graph_digest)=32),
  proposal_digest bytea NOT NULL CHECK (octet_length(proposal_digest)=32),
  source_txid bytea NOT NULL CHECK (octet_length(source_txid)=32),
  source_vout integer NOT NULL CHECK (source_vout IN (0,1)),
  slot text NOT NULL CHECK (slot IN ('cooperative','recovery','solo:alice','solo:bob','solo:carol',
    'final-sweep:alice','final-sweep:bob','final-sweep:carol')),
  kind text NOT NULL CHECK (kind IN ('solo','cooperative','recovery','final-sweep')),
  status text NOT NULL CHECK (status IN ('collecting','finalized','abandoned')),
  proposal_json jsonb NOT NULL CHECK (jsonb_typeof(proposal_json)='object' AND octet_length(proposal_json::text)<=32768),
  state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json)='object' AND octet_length(state_json::text)<=65536),
  state_digest bytea NOT NULL CHECK (octet_length(state_digest)=32),
  transaction_digest bytea CHECK (transaction_digest IS NULL OR octet_length(transaction_digest)=32),
  final_txid bytea CHECK (final_txid IS NULL OR octet_length(final_txid)=32),
  transaction_hex text CHECK (transaction_hex IS NULL OR (char_length(transaction_hex) BETWEEN 2 AND 20000
    AND transaction_hex ~ '^([0-9a-f]{2})+$')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,vault_id),
  UNIQUE (id,vault_id,proposal_digest),
  FOREIGN KEY (vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE CASCADE,
  FOREIGN KEY (vault_id,epoch_id) REFERENCES presigned_funding_epochs(vault_id,epoch_id) ON DELETE RESTRICT,
  CHECK (proposal_json->>'proposalId'=id::text AND proposal_json->>'protocol'=protocol
    AND proposal_json->>'epochId'=epoch_id::text AND proposal_json->>'kind'=kind AND proposal_json->>'slot'=slot
    AND proposal_json->>'graphDigest'=encode(graph_digest,'hex') AND proposal_json->>'digest'=encode(proposal_digest,'hex')
    AND proposal_json->'source'->>'txid'=encode(source_txid,'hex') AND proposal_json->'source'->>'vout'=source_vout::text),
  CHECK (state_json->'proposal'=proposal_json AND state_json->>'status'=status AND state_json->>'protocol'=protocol),
  CHECK (state_json ?& ARRAY['publicNonces','partials','recoveryContributions','finalized','broadcastApprovals']),
  CHECK (jsonb_typeof(state_json->'publicNonces')='array' AND jsonb_typeof(state_json->'partials')='array'
    AND jsonb_typeof(state_json->'recoveryContributions')='array' AND jsonb_typeof(state_json->'broadcastApprovals')='array'),
  CHECK ((status='finalized' AND transaction_digest IS NOT NULL AND final_txid IS NOT NULL AND transaction_hex IS NOT NULL
    AND state_json->'finalized'->>'transactionDigest'=encode(transaction_digest,'hex')
    AND state_json->'finalized'->>'txid'=encode(final_txid,'hex') AND state_json->'finalized'->>'transactionHex'=transaction_hex)
    OR (status<>'finalized' AND transaction_digest IS NULL AND final_txid IS NULL AND transaction_hex IS NULL
      AND state_json->'finalized'='null'::jsonb))
);
-- Only unfinished coordination shares a slot. Finalized conflicts remain valid public transactions.
-- In particular, cooperative/recovery proposals never reserve the source against a solo actor.
CREATE UNIQUE INDEX presigned_runtime_active_slot_idx
  ON presigned_runtime_proposals(vault_id,source_txid,source_vout,slot) WHERE status='collecting';
CREATE INDEX presigned_runtime_vault_idx ON presigned_runtime_proposals(vault_id,created_at,id);

CREATE FUNCTION protect_presigned_runtime_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.vault_id IS DISTINCT FROM OLD.vault_id
    OR NEW.protocol IS DISTINCT FROM OLD.protocol OR NEW.epoch_id IS DISTINCT FROM OLD.epoch_id
    OR NEW.proposal_json IS DISTINCT FROM OLD.proposal_json OR NEW.proposal_digest IS DISTINCT FROM OLD.proposal_digest
    OR NEW.graph_digest IS DISTINCT FROM OLD.graph_digest OR NEW.source_txid IS DISTINCT FROM OLD.source_txid
    OR NEW.source_vout IS DISTINCT FROM OLD.source_vout OR NEW.slot IS DISTINCT FROM OLD.slot OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'runtime proposal identity and exact source are immutable';
  END IF;
  IF OLD.status='abandoned' AND NEW.state_json IS DISTINCT FROM OLD.state_json THEN
    RAISE EXCEPTION 'abandoned runtime artifacts are retained unchanged';
  END IF;
  IF NOT ((NEW.state_json->'publicNonces') @> (OLD.state_json->'publicNonces'))
    OR NOT ((NEW.state_json->'partials') @> (OLD.state_json->'partials'))
    OR NOT ((NEW.state_json->'recoveryContributions') @> (OLD.state_json->'recoveryContributions'))
    OR NOT ((NEW.state_json->'broadcastApprovals') @> (OLD.state_json->'broadcastApprovals')) THEN
    RAISE EXCEPTION 'runtime public nonces, signatures and approvals cannot be removed';
  END IF;
  IF OLD.state_json->'nonceSetDigest'<>'null'::jsonb
    AND NEW.state_json->'nonceSetDigest' IS DISTINCT FROM OLD.state_json->'nonceSetDigest' THEN
    RAISE EXCEPTION 'frozen MuSig2 nonce set is immutable';
  END IF;
  IF OLD.status='finalized' AND (NEW.status<>'finalized' OR NEW.state_json->'finalized' IS DISTINCT FROM OLD.state_json->'finalized'
    OR NEW.transaction_digest IS DISTINCT FROM OLD.transaction_digest OR NEW.final_txid IS DISTINCT FROM OLD.final_txid
    OR NEW.transaction_hex IS DISTINCT FROM OLD.transaction_hex) THEN
    RAISE EXCEPTION 'completed runtime transaction cannot be revoked or changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_runtime_history BEFORE UPDATE ON presigned_runtime_proposals
  FOR EACH ROW EXECUTE FUNCTION protect_presigned_runtime_history();

-- Globally retained public nonce bytes reject reuse even after a proposal was abandoned.
-- No secret nonce, private key or participant seed is ever accepted or stored.
CREATE TABLE presigned_runtime_nonce_commitments (
  proposal_id uuid NOT NULL,
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol='presigned-graph-v2'),
  user_id uuid NOT NULL,
  participant_id text NOT NULL CHECK (participant_id IN ('alice','bob','carol')),
  public_nonce bytea NOT NULL UNIQUE CHECK (octet_length(public_nonce)=66),
  contribution_json jsonb NOT NULL CHECK (jsonb_typeof(contribution_json)='object' AND octet_length(contribution_json::text)<=4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id,participant_id),
  FOREIGN KEY (proposal_id,vault_id) REFERENCES presigned_runtime_proposals(id,vault_id) ON DELETE RESTRICT,
  FOREIGN KEY (vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE CASCADE,
  FOREIGN KEY (vault_id,user_id,participant_id) REFERENCES vault_members(vault_id,user_id,participant_id) ON DELETE RESTRICT,
  CHECK (contribution_json->>'proposalId'=proposal_id::text AND contribution_json->>'participantId'=participant_id
    AND contribution_json->>'pubnonce'=encode(public_nonce,'hex') AND contribution_json->>'protocol'=protocol)
);

CREATE FUNCTION preserve_presigned_public_nonce() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'public nonce commitment is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_public_nonce_immutable BEFORE UPDATE ON presigned_runtime_nonce_commitments
  FOR EACH ROW EXECUTE FUNCTION preserve_presigned_public_nonce();

CREATE TABLE presigned_runtime_action_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol='presigned-graph-v2'),
  user_id uuid NOT NULL,
  participant_id text NOT NULL CHECK (participant_id IN ('alice','bob','carol')),
  credential_id text NOT NULL,
  credential_counter bigint NOT NULL CHECK (credential_counter>=0),
  proposal_id uuid NOT NULL,
  proposal_digest bytea NOT NULL CHECK (octet_length(proposal_digest)=32),
  proposal_json jsonb NOT NULL CHECK (jsonb_typeof(proposal_json)='object' AND octet_length(proposal_json::text)<=32768),
  action_json jsonb NOT NULL CHECK (jsonb_typeof(action_json)='object' AND octet_length(action_json::text)<=32768),
  action_digest bytea NOT NULL CHECK (octet_length(action_digest)=32),
  challenge text NOT NULL CHECK (char_length(challenge) BETWEEN 16 AND 2048),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE CASCADE,
  FOREIGN KEY (vault_id,user_id,participant_id) REFERENCES vault_members(vault_id,user_id,participant_id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id,user_id) REFERENCES webauthn_credentials(credential_id,user_id) ON DELETE RESTRICT,
  UNIQUE(id,vault_id,user_id,participant_id,credential_id,proposal_id,action_digest),
  CHECK (proposal_json->>'proposalId'=proposal_id::text AND proposal_json->>'digest'=encode(proposal_digest,'hex')
    AND action_json->>'proposalId'=proposal_id::text AND action_json->>'protocol'=protocol)
);
CREATE UNIQUE INDEX presigned_runtime_open_challenge_idx ON presigned_runtime_action_challenges(vault_id,user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE presigned_runtime_action_events (
  challenge_id uuid PRIMARY KEY,
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol='presigned-graph-v2'),
  user_id uuid NOT NULL,
  participant_id text NOT NULL,
  credential_id text NOT NULL,
  proposal_id uuid NOT NULL,
  action_digest bytea NOT NULL CHECK (octet_length(action_digest)=32),
  action_json jsonb NOT NULL CHECK (jsonb_typeof(action_json)='object' AND octet_length(action_json::text)<=32768),
  resulting_state_digest bytea NOT NULL CHECK (octet_length(resulting_state_digest)=32),
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id,vault_id) REFERENCES presigned_runtime_proposals(id,vault_id) ON DELETE RESTRICT,
  FOREIGN KEY (challenge_id,vault_id,user_id,participant_id,credential_id,proposal_id,action_digest)
    REFERENCES presigned_runtime_action_challenges(id,vault_id,user_id,participant_id,credential_id,proposal_id,action_digest) ON DELETE RESTRICT
);
CREATE INDEX presigned_runtime_events_vault_idx ON presigned_runtime_action_events(vault_id,approved_at);

INSERT INTO schema_migrations(version) VALUES ('017_presigned_runtime');
COMMIT;
