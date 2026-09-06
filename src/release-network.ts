import { BITCOIN_NETWORK_CONFIG, BITCOIN_NETWORK_NAME } from './network.js';

/** Release artifacts and operator approval are distinct for each real network. */
export const RELEASE_NETWORK = {
  network: BITCOIN_NETWORK_NAME,
  directory: BITCOIN_NETWORK_NAME === 'mainnet' ? 'live-run' : 'live-run/signet',
  genesisHash: BITCOIN_NETWORK_CONFIG.genesisHash,
  proofKind: `live-sigbash-${BITCOIN_NETWORK_NAME}-signing-proof` as const,
  releaseKind: `${BITCOIN_NETWORK_NAME}-funding-release` as const,
  proofDigestEnv: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'LIVE_SIGBASH_MAINNET_PROOF_DIGEST' : 'LIVE_SIGBASH_SIGNET_PROOF_DIGEST',
  proofReceiptEnv: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'LIVE_SIGBASH_MAINNET_PROOF_RECEIPT' : 'LIVE_SIGBASH_SIGNET_PROOF_RECEIPT',
  proofReceiptPath: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'live-run/predeployment-proof-receipt.json' : 'live-run/signet/predeployment-proof-receipt.json',
  reportDigestEnv: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'FUNDING_RELEASE_REPORT_DIGEST' : 'SIGNET_FUNDING_RELEASE_REPORT_DIGEST',
  reportPathEnv: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'FUNDING_RELEASE_REPORT_PATH' : 'SIGNET_FUNDING_RELEASE_REPORT_PATH',
  reportPath: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'live-run/funding-release-report.json' : 'live-run/signet/funding-release-report.json',
  restoreReceiptPath: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'live-run/database-restore-receipt.json' : 'live-run/signet/database-restore-receipt.json',
  broadcastFlag: `confirm-${BITCOIN_NETWORK_NAME}-broadcast` as const,
  broadcastAcknowledgement: BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'BROADCAST_EXACT_APPROVED_FUNDING_TRANSACTION'
    : 'BROADCAST_EXACT_APPROVED_SIGNET_FUNDING_TRANSACTION',
};

/** Operator commands must never select a network through a default or one flag. */
export function assertExplicitOperatorNetwork(env: Record<string, string | undefined> = process.env): void {
  if (env.VAULT_NETWORK !== BITCOIN_NETWORK_NAME || env.NEXT_PUBLIC_VAULT_NETWORK !== BITCOIN_NETWORK_NAME) {
    throw new Error('operator requires explicit matching VAULT_NETWORK and NEXT_PUBLIC_VAULT_NETWORK');
  }
}

export const RELEASE_CHECK_PREFIXES = [
  `protected live Sigbash ${BITCOIN_NETWORK_NAME} proof receipt`,
  'reviewed Node runtime is active',
  'deployed service image manifest digest is explicit and immutable',
  'production WebAuthn origin and RP ID are explicit HTTPS values',
  'at least one independent HTTPS chain-observation origin is explicit',
  `tiny-${BITCOIN_NETWORK_NAME} amount is explicit and within the private-beta cap`,
  `${BITCOIN_NETWORK_NAME} recovery delay is explicit and positive`,
  'confirmation depth for funding and transitions is explicit',
  'three-wallet funding fee is explicit and cannot consume one deposit',
  'Sigbash service origin is an explicit credential-free HTTPS origin',
  'Sigbash WASM matches the pinned SHA-384',
  'Sigbash Go loader matches the pinned SHA-384',
  'production database uses a non-local TLS endpoint',
  'protected production database restore receipt is present, fresh, and bound to this endpoint',
  'production database is PostgreSQL 16 or newer',
  'all required database migrations are applied',
  'exactly one three-person private-beta vault exists',
  'all three participants have two completed PRF passkey envelopes',
  'the immutable roster has nine live Sigbash keys and three confirmations',
  'all nine server-verified Sigbash readiness proofs are recorded',
  'the pre-funding database contains no current Bitcoin coin',
  'funding ceremony is either untouched or unanimously approved and still unbroadcast',
  `configured Bitcoin backend identifies as ${BITCOIN_NETWORK_NAME}`,
];

export const RELEASE_MANUAL_GATES = [
  `Independently review the protected predeployment live-Sigbash receipt and its consensus-authorized ${BITCOIN_NETWORK_NAME} signature.`,
  BITCOIN_NETWORK_NAME === 'mainnet'
    ? 'Sigbash must explicitly enable mainnet for all three independent participant organization hashes.'
    : 'Confirm all three independent participant organizations and their nine immutable keys are Signet-only; mainnet remains unauthorized.',
  'Each friend must complete setup and recovery with two real, distinct PRF-capable passkeys.',
  `Each friend must independently review the unanimous roster and tiny-${BITCOIN_NETWORK_NAME} economics.`,
  'The deployed private service must use the independently reviewed immutable image digest and narrow private access control.',
  'Before initial wallet signing, all three friends must review the same funding PSBT fingerprint, inputs, change outputs, vault output, and fee.',
  'Three independent real wallets must sign only their own P2WPKH or P2TR funding inputs and all three final passkey approvals must be completed.',
  'The private Bitcoin Core path must complete rejection, retry, duplicate, interruption, mempool, confirmation, and reorganization drills.',
  'The operator has documented that this report does not authorize funding and a separate explicit broadcast decision is still required.',
];
