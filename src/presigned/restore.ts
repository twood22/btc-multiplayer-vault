import { validateDatabaseRestoreReceipt, type DatabaseRestoreReceipt } from '../database-restore-receipt.js';
import type { BitcoinNetworkName } from '../types.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type PresignedProtocol, type PresignedVersion } from './types.js';
import { assert, commitmentDigest, exactKeys, genesisHash, hexBytes, identifier, sameCanonical, presignedDomain, presignedVersion, validatePresignedProtocol } from './validation.js';

/** No raw database rows, public-key credential IDs, ciphertext or bearer data. */
export interface PresignedRestoredFundingBinding {
  /** Absent only in legacy V2 receipts, preserving their canonical bytes. */
  protocol?: typeof PRESIGNED_PROTOCOL_V3;
  network: BitcoinNetworkName;
  genesisHash: string;
  vaultId: string;
  epochId: string;
  graphDigest: string;
  fundingTxid: string;
  finalizationDigest: string;
  ceremonyStateDigest: string;
  retainedEpochsDigest: string;
  custodyMaterialDigest: string;
}
export interface PresignedFundingRestoreReceipt {
  version: PresignedVersion;
  protocol: PresignedProtocol;
  kind: 'presigned-v2-exact-funding-database-restore' | 'presigned-v3-exact-funding-database-restore';
  createdAt: string;
  databaseRestore: DatabaseRestoreReceipt;
  sourceFunding: PresignedRestoredFundingBinding;
  restoredFunding: PresignedRestoredFundingBinding;
  fundingAllowed: false;
  receiptDigest: string;
}
export function validatePresignedRestoredFundingBinding(value: unknown): PresignedRestoredFundingBinding {
  const hasProtocol = value !== null && typeof value === 'object' && Object.hasOwn(value, 'protocol');
  exactKeys(value, ['network', 'genesisHash', 'vaultId', 'epochId', 'graphDigest', 'fundingTxid', 'finalizationDigest',
    'ceremonyStateDigest', 'retainedEpochsDigest', 'custodyMaterialDigest', ...(hasProtocol ? ['protocol'] : [])], 'restored presigned funding binding');
  const binding = value as PresignedRestoredFundingBinding;
  assert(!hasProtocol || binding.protocol === PRESIGNED_PROTOCOL_V3, 'unknown restored funding binding protocol');
  assert(binding.genesisHash === genesisHash(binding.network), 'restored funding has the wrong chain');
  identifier(binding.vaultId, 'restored vault'); identifier(binding.epochId, 'restored epoch');
  for (const field of ['graphDigest', 'fundingTxid', 'finalizationDigest', 'ceremonyStateDigest', 'retainedEpochsDigest', 'custodyMaterialDigest'] as const)
    hexBytes(binding[field], 32, `restored ${field}`);
  return binding;
}
export function createPresignedFundingRestoreReceipt(input: {
  createdAt: string; databaseRestore: DatabaseRestoreReceipt;
  sourceFunding: PresignedRestoredFundingBinding; restoredFunding: PresignedRestoredFundingBinding;
}): PresignedFundingRestoreReceipt {
  const protocol = input.sourceFunding.protocol ?? PRESIGNED_PROTOCOL;
  const version = presignedVersion(protocol);
  const body = { version, protocol, kind: `presigned-v${version}-exact-funding-database-restore` as const,
    ...input, fundingAllowed: false as const };
  return validatePresignedFundingRestoreReceipt({ ...body,
    receiptDigest: commitmentDigest(presignedDomain(protocol, 'funding-database-restore'), body) });
}
export function validatePresignedFundingRestoreReceipt(value: unknown): PresignedFundingRestoreReceipt {
  exactKeys(value, ['version', 'protocol', 'kind', 'createdAt', 'databaseRestore', 'sourceFunding', 'restoredFunding',
    'fundingAllowed', 'receiptDigest'], 'V2 funding restore receipt');
  const receipt = value as PresignedFundingRestoreReceipt;
  validatePresignedProtocol(receipt.version, receipt.protocol);
  assert(receipt.kind === `presigned-v${receipt.version}-exact-funding-database-restore` &&
    receipt.fundingAllowed === false, 'funding restore receipt changed protocol or grants authority');
  assert(typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt)) &&
    new Date(receipt.createdAt).toISOString() === receipt.createdAt, 'invalid funding restore timestamp');
  validateDatabaseRestoreReceipt(receipt.databaseRestore);
  assert(receipt.createdAt === receipt.databaseRestore.createdAt, 'funding proof is not from the same complete restore observation');
  validatePresignedRestoredFundingBinding(receipt.sourceFunding); validatePresignedRestoredFundingBinding(receipt.restoredFunding);
  assert((receipt.sourceFunding.protocol ?? PRESIGNED_PROTOCOL) === receipt.protocol &&
    (receipt.restoredFunding.protocol ?? PRESIGNED_PROTOCOL) === receipt.protocol, 'funding restore binding protocol differs from receipt');
  sameCanonical(receipt.sourceFunding, receipt.restoredFunding, 'exact restored funding and custody material');
  const { receiptDigest, ...body } = receipt;
  hexBytes(receiptDigest, 32, 'funding restore receipt digest');
  assert(commitmentDigest(presignedDomain(receipt.protocol, 'funding-database-restore'), body) === receiptDigest, 'funding restore receipt digest changed');
  return receipt;
}
export function assertPresignedFundingRestoreBinding(receipt: PresignedFundingRestoreReceipt, expected: {
  reviewedReceiptDigest: string; databaseRestoreReceiptDigest: string;
  sourceEndpointFingerprint: string; sourceDatabaseIdentityFingerprint: string;
  currentFunding: PresignedRestoredFundingBinding; now?: number;
}) {
  validatePresignedFundingRestoreReceipt(receipt); validatePresignedRestoredFundingBinding(expected.currentFunding);
  assert(receipt.receiptDigest === expected.reviewedReceiptDigest &&
    receipt.databaseRestore.receiptDigest === expected.databaseRestoreReceiptDigest, 'exact funding restore differs from the reviewed artifacts');
  assert(receipt.databaseRestore.sourceEndpointFingerprint === expected.sourceEndpointFingerprint &&
    receipt.databaseRestore.sourceDatabaseIdentityFingerprint === expected.sourceDatabaseIdentityFingerprint,
  'exact funding restore belongs to another production database');
  sameCanonical(receipt.sourceFunding, expected.currentFunding, 'current funding/custody was not proven restored');
  const age = (expected.now ?? Date.now()) - Date.parse(receipt.createdAt);
  assert(Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60_000, 'exact funding restore is stale or in the future');
}
