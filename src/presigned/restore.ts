import { validateDatabaseRestoreReceipt, type DatabaseRestoreReceipt } from '../database-restore-receipt.js';
import type { BitcoinNetworkName } from '../types.js';
import { PRESIGNED_PROTOCOL } from './types.js';
import { assert, commitmentDigest, exactKeys, genesisHash, hexBytes, identifier, sameCanonical } from './validation.js';

/** No raw database rows, public-key credential IDs, ciphertext or bearer data. */
export interface PresignedRestoredFundingBinding {
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
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  kind: 'presigned-v2-exact-funding-database-restore';
  createdAt: string;
  databaseRestore: DatabaseRestoreReceipt;
  sourceFunding: PresignedRestoredFundingBinding;
  restoredFunding: PresignedRestoredFundingBinding;
  fundingAllowed: false;
  receiptDigest: string;
}
export function validatePresignedRestoredFundingBinding(value: unknown): PresignedRestoredFundingBinding {
  exactKeys(value, ['network', 'genesisHash', 'vaultId', 'epochId', 'graphDigest', 'fundingTxid', 'finalizationDigest',
    'ceremonyStateDigest', 'retainedEpochsDigest', 'custodyMaterialDigest'], 'restored V2 funding binding');
  const binding = value as PresignedRestoredFundingBinding;
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
  const body = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, kind: 'presigned-v2-exact-funding-database-restore' as const,
    ...input, fundingAllowed: false as const };
  return validatePresignedFundingRestoreReceipt({ ...body,
    receiptDigest: commitmentDigest('vault/presigned-graph-v2/funding-database-restore', body) });
}
export function validatePresignedFundingRestoreReceipt(value: unknown): PresignedFundingRestoreReceipt {
  exactKeys(value, ['version', 'protocol', 'kind', 'createdAt', 'databaseRestore', 'sourceFunding', 'restoredFunding',
    'fundingAllowed', 'receiptDigest'], 'V2 funding restore receipt');
  const receipt = value as PresignedFundingRestoreReceipt;
  assert(receipt.version === 2 && receipt.protocol === PRESIGNED_PROTOCOL && receipt.kind === 'presigned-v2-exact-funding-database-restore' &&
    receipt.fundingAllowed === false, 'funding restore receipt changed protocol or grants authority');
  assert(typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt)) &&
    new Date(receipt.createdAt).toISOString() === receipt.createdAt, 'invalid funding restore timestamp');
  validateDatabaseRestoreReceipt(receipt.databaseRestore);
  assert(receipt.createdAt === receipt.databaseRestore.createdAt, 'funding proof is not from the same complete restore observation');
  validatePresignedRestoredFundingBinding(receipt.sourceFunding); validatePresignedRestoredFundingBinding(receipt.restoredFunding);
  sameCanonical(receipt.sourceFunding, receipt.restoredFunding, 'exact restored funding and custody material');
  const { receiptDigest, ...body } = receipt;
  hexBytes(receiptDigest, 32, 'funding restore receipt digest');
  assert(commitmentDigest('vault/presigned-graph-v2/funding-database-restore', body) === receiptDigest, 'funding restore receipt digest changed');
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
