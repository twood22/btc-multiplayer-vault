BEGIN;

ALTER TABLE participant_sigbash_keys
  DROP CONSTRAINT participant_sigbash_keys_network_check,
  ADD CONSTRAINT participant_sigbash_keys_network_check
    CHECK (network IN ('mainnet', 'signet'));

ALTER TABLE vault_rosters
  DROP CONSTRAINT vault_rosters_network_check,
  DROP CONSTRAINT vault_rosters_funding_address_check,
  ADD CONSTRAINT vault_rosters_network_check
    CHECK (network IN ('mainnet', 'signet')),
  ADD CONSTRAINT vault_rosters_funding_address_check CHECK (
    (network = 'mainnet' AND funding_address LIKE 'bc1p%') OR
    (network = 'signet' AND funding_address LIKE 'tb1p%')
  );

INSERT INTO schema_migrations (version) VALUES ('013_signet_network');

COMMIT;
