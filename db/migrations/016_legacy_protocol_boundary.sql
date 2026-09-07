BEGIN;

-- Existing rows are V1 by migration015's immutable vault discriminator. Shared
-- passkey/identity/session tables remain protocol-neutral; protocol-specific
-- V1 records may never be inserted beneath a V2 vault, including by operators.
CREATE FUNCTION require_legacy_vault_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT protocol FROM vaults WHERE id = NEW.vault_id) IS DISTINCT FROM 'sigbash-v1' THEN
    RAISE EXCEPTION 'legacy protocol table cannot operate on a presigned vault';
  END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE legacy_table text;
BEGIN
  FOREACH legacy_table IN ARRAY ARRAY[
    'participant_sigbash_keys', 'vault_rosters', 'roster_confirmations',
    'participant_sigbash_custody_versions', 'vault_coins', 'vault_coin_observations',
    'vault_coin_observation_challenges', 'vault_transaction_proposals', 'vault_proposal_contributions',
    'sigbash_readiness_challenges', 'participant_sigbash_readiness_proofs', 'vault_broadcast_approvals',
    'funding_input_challenges', 'participant_funding_inputs', 'funding_signature_challenges',
    'participant_funding_signatures', 'funding_finalizations', 'funding_final_approval_challenges',
    'funding_final_approvals', 'funding_restart_challenges', 'funding_restart_approvals',
    'funding_restart_events', 'chain_reorganization_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER legacy_protocol_boundary BEFORE INSERT OR UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION require_legacy_vault_write()', legacy_table);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version) VALUES ('016_legacy_protocol_boundary');
COMMIT;
