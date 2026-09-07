BEGIN;

CREATE TABLE presigned_fee_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  epoch_id uuid NOT NULL,
  proposal_id uuid,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_id text NOT NULL CHECK (participant_id IN ('alice','bob','carol')),
  package_json jsonb NOT NULL CHECK (jsonb_typeof(package_json) = 'object' AND octet_length(package_json::text) <= 98304),
  package_digest bytea NOT NULL CHECK (octet_length(package_digest) = 32),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','prepared','submitting','accepted','deferred','superseded')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (vault_id,package_digest),
  FOREIGN KEY (vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE CASCADE,
  FOREIGN KEY (vault_id,epoch_id) REFERENCES presigned_funding_epochs(vault_id,epoch_id) ON DELETE RESTRICT,
  FOREIGN KEY (proposal_id,vault_id) REFERENCES presigned_runtime_proposals(id,vault_id) ON DELETE RESTRICT
);
CREATE FUNCTION protect_presigned_fee_package() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.vault_id IS DISTINCT FROM OLD.vault_id OR NEW.protocol IS DISTINCT FROM OLD.protocol
    OR NEW.epoch_id IS DISTINCT FROM OLD.epoch_id OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
    OR NEW.package_json IS DISTINCT FROM OLD.package_json OR NEW.package_digest IS DISTINCT FROM OLD.package_digest THEN
    RAISE EXCEPTION 'approved fee packages are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presigned_fee_package_immutable BEFORE UPDATE ON presigned_fee_packages
  FOR EACH ROW EXECUTE FUNCTION protect_presigned_fee_package();

CREATE TABLE presigned_fee_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'presigned-graph-v2' CHECK (protocol = 'presigned-graph-v2'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_id text NOT NULL CHECK (participant_id IN ('alice','bob','carol')),
  credential_id text NOT NULL REFERENCES webauthn_credentials(credential_id) ON DELETE RESTRICT,
  credential_counter bigint NOT NULL CHECK (credential_counter >= 0),
  challenge text NOT NULL,
  package_json jsonb NOT NULL CHECK (jsonb_typeof(package_json) = 'object' AND octet_length(package_json::text) <= 98304),
  package_digest bytea NOT NULL CHECK (octet_length(package_digest) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vault_id,protocol) REFERENCES presigned_ceremonies(vault_id,protocol) ON DELETE CASCADE
);
INSERT INTO schema_migrations(version) VALUES ('019_presigned_fee_packages');
COMMIT;
