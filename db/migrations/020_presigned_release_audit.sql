BEGIN;
CREATE TABLE presigned_funding_release_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL,
  epoch_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol='presigned-graph-v2'),
  broadcast_intent_id uuid REFERENCES presigned_broadcast_intents(id) ON DELETE RESTRICT,
  fee_package_id uuid REFERENCES presigned_fee_packages(id) ON DELETE RESTRICT,
  release_report_digest bytea NOT NULL CHECK (octet_length(release_report_digest)=32),
  acceptance_receipt_digest bytea NOT NULL CHECK (octet_length(acceptance_receipt_digest)=32),
  finalization_digest bytea NOT NULL CHECK (octet_length(finalization_digest)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(vault_id,epoch_id) REFERENCES presigned_funding_epochs(vault_id,epoch_id) ON DELETE RESTRICT,
  FOREIGN KEY(vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE RESTRICT,
  CHECK (num_nonnulls(broadcast_intent_id,fee_package_id)=1)
);
CREATE FUNCTION preserve_presigned_release_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'funding release audit is append-only'; END;
$$;
CREATE TRIGGER presigned_release_use_immutable BEFORE UPDATE OR DELETE ON presigned_funding_release_uses
  FOR EACH ROW EXECUTE FUNCTION preserve_presigned_release_use();
INSERT INTO schema_migrations(version) VALUES ('020_presigned_release_audit');
COMMIT;
