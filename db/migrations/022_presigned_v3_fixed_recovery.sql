BEGIN;

-- Extend the discriminator, never rewrite existing vaults, signatures or settings.
ALTER TABLE vaults DROP CONSTRAINT vaults_protocol_check;
ALTER TABLE vaults ADD CONSTRAINT vaults_protocol_check
  CHECK (protocol IN ('sigbash-v1', 'presigned-graph-v2', 'presigned-graph-v3'));
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['presigned_ceremonies','presigned_funding_epochs',
    'presigned_action_challenges','presigned_action_events','presigned_runtime_proposals',
    'presigned_runtime_nonce_commitments','presigned_runtime_action_challenges',
    'presigned_runtime_action_events','presigned_chain_states','presigned_broadcast_intents',
    'presigned_fee_packages','presigned_fee_challenges','presigned_funding_release_uses'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', table_name, table_name || '_protocol_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (protocol IN (%L,%L))',
      table_name, table_name || '_protocol_check', 'presigned-graph-v2', 'presigned-graph-v3');
  END LOOP;
END;
$$;

-- CHECK must fail on missing fields, not pass through SQL NULL.
CREATE FUNCTION presigned_json_protocol_matches(value jsonb, expected text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object' AND value->>'protocol' = expected
    AND value->'version' = CASE expected WHEN 'presigned-graph-v2' THEN '2'::jsonb
      WHEN 'presigned-graph-v3' THEN '3'::jsonb ELSE 'null'::jsonb END, false);
$$;

ALTER TABLE presigned_ceremonies ADD CONSTRAINT presigned_ceremony_protocol_binding CHECK (
  presigned_json_protocol_matches(state_json, protocol)
  AND (protocol <> 'presigned-graph-v3' OR COALESCE(
    settings_json->>'protocol' = protocol
    AND settings_json->>'recoveryPolicy' = 'fixed-equal-quorum-v1'
    AND settings_json->'economics'->>'payoutSchedule' = 'last-survivor-net-v1', false)));

CREATE FUNCTION presigned_epoch_protocol_matches(snapshot jsonb, expected text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;
BEGIN
  IF snapshot->'graph' <> 'null'::jsonb AND NOT public.presigned_json_protocol_matches(snapshot->'graph', expected) THEN
    RETURN false;
  END IF;
  IF expected = 'presigned-graph-v2' THEN
    RETURN NOT (snapshot ? 'recoveryAuthorizations');
  END IF;
  IF expected <> 'presigned-graph-v3' OR jsonb_typeof(snapshot->'recoveryAuthorizations') IS DISTINCT FROM 'array'
    OR jsonb_array_length(snapshot->'recoveryAuthorizations') > 9 THEN RETURN false; END IF;
  FOR item IN SELECT jsonb_array_elements(snapshot->'recoveryAuthorizations') LOOP
    IF NOT public.presigned_json_protocol_matches(item, expected)
      OR item->>'purpose' IS DISTINCT FROM 'fixed-recovery-authorization'
      OR item->>'graphDigest' IS DISTINCT FROM snapshot->'graph'->>'digest' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_array_length(snapshot->'walletSigningStarted') > 0
    AND (jsonb_array_length(snapshot->'preauthorizations') <> 12
      OR jsonb_array_length(snapshot->'recoveryAuthorizations') <> 9) THEN RETURN false; END IF;
  RETURN true;
END;
$$;
ALTER TABLE presigned_funding_epochs ADD CONSTRAINT presigned_epoch_protocol_binding
  CHECK (presigned_epoch_protocol_matches(snapshot_json, protocol));

-- The old history trigger remains in force. This additional rule protects the
-- new signatures with the same append-only semantics, including retired epochs.
CREATE FUNCTION protect_presigned_recovery_authorizations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.protocol = 'presigned-graph-v3' AND NOT COALESCE(
    (NEW.snapshot_json->'recoveryAuthorizations') @> (OLD.snapshot_json->'recoveryAuthorizations'), false) THEN
    RAISE EXCEPTION 'fixed recovery authorizations cannot be removed or replaced';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_recovery_authorizations_retained BEFORE UPDATE ON presigned_funding_epochs
  FOR EACH ROW EXECUTE FUNCTION protect_presigned_recovery_authorizations();

ALTER TABLE presigned_action_challenges ADD CONSTRAINT presigned_action_protocol_binding
  CHECK (presigned_json_protocol_matches(action_json, protocol));
ALTER TABLE presigned_action_events ADD CONSTRAINT presigned_action_event_protocol_binding
  CHECK (presigned_json_protocol_matches(action_json, protocol));
ALTER TABLE presigned_runtime_proposals ADD CONSTRAINT presigned_runtime_protocol_binding
  CHECK (presigned_json_protocol_matches(proposal_json, protocol) AND presigned_json_protocol_matches(state_json, protocol));
ALTER TABLE presigned_runtime_nonce_commitments ADD CONSTRAINT presigned_nonce_protocol_binding
  CHECK (presigned_json_protocol_matches(contribution_json, protocol));
ALTER TABLE presigned_runtime_action_challenges ADD CONSTRAINT presigned_runtime_action_protocol_binding
  CHECK (presigned_json_protocol_matches(proposal_json, protocol) AND presigned_json_protocol_matches(action_json, protocol));
ALTER TABLE presigned_runtime_action_events ADD CONSTRAINT presigned_runtime_event_protocol_binding
  CHECK (presigned_json_protocol_matches(action_json, protocol));
ALTER TABLE presigned_chain_states ADD CONSTRAINT presigned_chain_protocol_binding
  CHECK (presigned_json_protocol_matches(state_json, protocol));
ALTER TABLE presigned_fee_packages ADD CONSTRAINT presigned_fee_protocol_binding
  CHECK (presigned_json_protocol_matches(package_json, protocol));
ALTER TABLE presigned_fee_challenges ADD CONSTRAINT presigned_fee_challenge_protocol_binding
  CHECK (presigned_json_protocol_matches(package_json, protocol));

INSERT INTO schema_migrations(version) VALUES ('022_presigned_v3_fixed_recovery');
COMMIT;
