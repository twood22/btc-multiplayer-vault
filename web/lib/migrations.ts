export const EXPECTED_MIGRATION_VERSIONS = [
  '001_passkey_custody',
  '002_multi_passkey_recovery',
  '003_roster_ceremony',
  '004_sigbash_custody',
  '005_vault_runtime',
  '006_sigbash_readiness',
  '007_broadcast_approval',
  '008_security_rate_limits',
  '009_funding_ceremony',
  '010_funding_signatures',
  '011_funding_restart',
  '012_chain_reorganization',
  '013_signet_network',
  '014_runtime_liveness',
  '015_presigned_protocol',
  '016_legacy_protocol_boundary',
  '017_presigned_runtime',
  '018_presigned_chain_and_broadcast',
  '019_presigned_fee_packages',
  '020_presigned_release_audit',
  '021_presigned_watch_revision',
] as const;

export const EXPECTED_MIGRATION_FILES = EXPECTED_MIGRATION_VERSIONS
  .map((version) => `${version}.sql`);
