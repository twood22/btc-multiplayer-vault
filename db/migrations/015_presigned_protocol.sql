BEGIN;

-- Existing vaults remain byte-for-byte legacy artifacts. Protocol never changes in place.
ALTER TABLE vaults
  ADD COLUMN protocol text NOT NULL DEFAULT 'sigbash-v1'
    CHECK (protocol IN ('sigbash-v1', 'presigned-graph-v2')),
  ADD CONSTRAINT vaults_id_protocol_unique UNIQUE (id, protocol);

CREATE FUNCTION prevent_vault_protocol_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.protocol IS DISTINCT FROM OLD.protocol THEN
    RAISE EXCEPTION 'vault protocol is immutable; create a new vault';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vault_protocol_immutable BEFORE UPDATE OF protocol ON vaults
  FOR EACH ROW EXECUTE FUNCTION prevent_vault_protocol_change();

CREATE TABLE presigned_ceremonies (
  vault_id uuid PRIMARY KEY,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  settings_json jsonb NOT NULL CHECK (jsonb_typeof(settings_json) = 'object'),
  settings_digest bytea NOT NULL CHECK (octet_length(settings_digest) = 32),
  state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object' AND octet_length(state_json::text) <= 8388608),
  state_digest bytea NOT NULL CHECK (octet_length(state_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, protocol),
  FOREIGN KEY (vault_id, protocol) REFERENCES vaults(id, protocol) ON DELETE CASCADE,
  CHECK (state_json->>'protocol' = protocol AND state_json->>'vaultId' = vault_id::text)
);
CREATE FUNCTION prevent_presigned_settings_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.vault_id IS DISTINCT FROM OLD.vault_id OR NEW.protocol IS DISTINCT FROM OLD.protocol
    OR NEW.settings_json IS DISTINCT FROM OLD.settings_json
    OR NEW.settings_digest IS DISTINCT FROM OLD.settings_digest THEN
    RAISE EXCEPTION 'presigned vault settings are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_settings_immutable BEFORE UPDATE ON presigned_ceremonies
  FOR EACH ROW EXECUTE FUNCTION prevent_presigned_settings_change();

-- Epoch snapshots retain every input, graph, preauthorization, restore receipt and signature.
-- The coordinator never deletes them when a pre-signing ceremony is restarted.
CREATE TABLE presigned_funding_epochs (
  epoch_id uuid PRIMARY KEY,
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 64),
  status text NOT NULL CHECK (status IN ('collecting', 'frozen', 'signed', 'approved', 'retired')),
  graph_digest bytea CHECK (graph_digest IS NULL OR octet_length(graph_digest) = 32),
  funding_txid bytea CHECK (funding_txid IS NULL OR octet_length(funding_txid) = 32),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object' AND octet_length(snapshot_json::text) <= 131072),
  snapshot_digest bytea NOT NULL CHECK (octet_length(snapshot_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, ordinal),
  UNIQUE (vault_id, epoch_id),
  FOREIGN KEY (vault_id, protocol) REFERENCES presigned_ceremonies(vault_id, protocol) ON DELETE CASCADE,
  CHECK (snapshot_json->>'epochId' = epoch_id::text AND snapshot_json->>'status' = status),
  CHECK (snapshot_json ?& ARRAY['epochId', 'status', 'inputs', 'graph', 'preauthorizations', 'backups',
    'walletSigningStarted', 'signatures', 'finalization', 'fundingApprovals', 'restartApprovals']),
  CHECK (jsonb_typeof(snapshot_json->'inputs') = 'array' AND jsonb_typeof(snapshot_json->'preauthorizations') = 'array'
    AND jsonb_typeof(snapshot_json->'backups') = 'array' AND jsonb_typeof(snapshot_json->'signatures') = 'array'
    AND jsonb_typeof(snapshot_json->'fundingApprovals') = 'array' AND jsonb_typeof(snapshot_json->'restartApprovals') = 'array'),
  CHECK (snapshot_json->'walletSigningStarted' IN ('[]'::jsonb, '["alice"]'::jsonb, '["bob"]'::jsonb,
    '["carol"]'::jsonb, '["alice","bob"]'::jsonb, '["alice","carol"]'::jsonb,
    '["bob","carol"]'::jsonb, '["alice","bob","carol"]'::jsonb)),
  CHECK ((snapshot_json->'walletSigningStarted') @> jsonb_path_query_array(snapshot_json, '$.signatures[*].participantId')),
  CHECK (status <> 'retired' OR (jsonb_array_length(snapshot_json->'signatures') = 0
    AND jsonb_array_length(snapshot_json->'walletSigningStarted') = 0))
);
CREATE UNIQUE INDEX presigned_one_current_epoch_idx ON presigned_funding_epochs(vault_id)
  WHERE status <> 'retired';
CREATE FUNCTION protect_presigned_epoch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.epoch_id IS DISTINCT FROM OLD.epoch_id OR NEW.vault_id IS DISTINCT FROM OLD.vault_id
    OR NEW.protocol IS DISTINCT FROM OLD.protocol OR NEW.ordinal IS DISTINCT FROM OLD.ordinal THEN
    RAISE EXCEPTION 'presigned epoch identity is immutable';
  END IF;
  IF OLD.graph_digest IS NOT NULL AND (NEW.graph_digest IS DISTINCT FROM OLD.graph_digest
    OR NEW.funding_txid IS DISTINCT FROM OLD.funding_txid
    OR NEW.snapshot_json->'graph' IS DISTINCT FROM OLD.snapshot_json->'graph') THEN
    RAISE EXCEPTION 'frozen presigned graph is immutable';
  END IF;
  IF OLD.status = 'retired' AND NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json THEN
    RAISE EXCEPTION 'retired presigned epoch is retained unchanged';
  END IF;
  IF NOT ((NEW.snapshot_json->'walletSigningStarted') @> (OLD.snapshot_json->'walletSigningStarted'))
    OR (jsonb_array_length(OLD.snapshot_json->'walletSigningStarted') > 0 AND NEW.status IN ('collecting', 'retired')) THEN
    RAISE EXCEPTION 'wallet-signing intent cannot be removed or restarted';
  END IF;
  IF NOT ((NEW.snapshot_json->'inputs') @> (OLD.snapshot_json->'inputs'))
    OR NOT ((NEW.snapshot_json->'preauthorizations') @> (OLD.snapshot_json->'preauthorizations'))
    OR NOT ((NEW.snapshot_json->'backups') @> (OLD.snapshot_json->'backups'))
    OR NOT ((NEW.snapshot_json->'fundingApprovals') @> (OLD.snapshot_json->'fundingApprovals')) THEN
    RAISE EXCEPTION 'presigned inputs, preauthorizations, restore receipts and funding approvals are retained';
  END IF;
  IF jsonb_array_length(OLD.snapshot_json->'signatures') > 0 AND
    (NEW.status NOT IN ('signed', 'approved') OR NOT ((NEW.snapshot_json->'signatures') @> (OLD.snapshot_json->'signatures'))) THEN
    RAISE EXCEPTION 'funding signatures cannot be removed or restarted';
  END IF;
  IF OLD.snapshot_json->'finalization' <> 'null'::jsonb AND
    NEW.snapshot_json->'finalization' IS DISTINCT FROM OLD.snapshot_json->'finalization' THEN
    RAISE EXCEPTION 'finalized funding transaction is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_epoch_history BEFORE UPDATE ON presigned_funding_epochs
  FOR EACH ROW EXECUTE FUNCTION protect_presigned_epoch_history();

CREATE TABLE presigned_action_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  user_id uuid NOT NULL,
  participant_id text NOT NULL CHECK (participant_id IN ('alice', 'bob', 'carol')),
  credential_id text NOT NULL,
  credential_counter bigint NOT NULL CHECK (credential_counter >= 0),
  kind text NOT NULL CHECK (kind IN ('register-identity', 'confirm-roster', 'commit-funding-input',
    'contribute-preauthorizations', 'confirm-backup', 'begin-wallet-signing', 'submit-funding-signature', 'approve-funding', 'restart-funding')),
  action_json jsonb NOT NULL CHECK (jsonb_typeof(action_json) = 'object' AND octet_length(action_json::text) <= 32768),
  action_digest bytea NOT NULL CHECK (octet_length(action_digest) = 32),
  challenge text NOT NULL CHECK (char_length(challenge) BETWEEN 16 AND 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  FOREIGN KEY (vault_id, protocol) REFERENCES presigned_ceremonies(vault_id, protocol) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, user_id, participant_id) REFERENCES vault_members(vault_id, user_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id, user_id) REFERENCES webauthn_credentials(credential_id, user_id) ON DELETE RESTRICT,
  UNIQUE (id, vault_id, user_id, participant_id, credential_id, action_digest),
  CHECK (action_json->>'kind' = kind AND action_json->>'protocol' = protocol)
);
CREATE UNIQUE INDEX presigned_one_open_action_idx ON presigned_action_challenges(vault_id, user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX presigned_action_challenge_expiry_idx ON presigned_action_challenges(expires_at);

CREATE TABLE presigned_action_events (
  challenge_id uuid PRIMARY KEY,
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  user_id uuid NOT NULL,
  participant_id text NOT NULL,
  credential_id text NOT NULL,
  action_digest bytea NOT NULL CHECK (octet_length(action_digest) = 32),
  action_json jsonb NOT NULL CHECK (jsonb_typeof(action_json) = 'object' AND octet_length(action_json::text) <= 32768),
  resulting_state_digest bytea NOT NULL CHECK (octet_length(resulting_state_digest) = 32),
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id, protocol) REFERENCES presigned_ceremonies(vault_id, protocol) ON DELETE CASCADE,
  FOREIGN KEY (challenge_id, vault_id, user_id, participant_id, credential_id, action_digest)
    REFERENCES presigned_action_challenges(id, vault_id, user_id, participant_id, credential_id, action_digest) ON DELETE RESTRICT
);
CREATE INDEX presigned_action_events_vault_idx ON presigned_action_events(vault_id, approved_at);

INSERT INTO schema_migrations(version) VALUES ('015_presigned_protocol');
COMMIT;
