/** Final-package validator for the separate post-assembly actual image drill. */
import assert from 'node:assert/strict';
import { commitmentDigest, exactKeys, hexBytes } from '../../src/presigned/validation.js';
import { PRESIGNED_PROTOCOL_V3 } from '../../src/presigned/types.js';
import { EXPECTED_MIGRATION_VERSIONS } from '../../web/lib/migrations.js';
export interface DeploymentEvidencePins {
  sourceDigest:string; imageManifestDigest:string; imageConfigDigest:string; offlineUtilityDigest:string; acceptanceReceiptDigest:string;
}
export function validateDeploymentExecutionEvidence(value:unknown, expected:DeploymentEvidencePins) {
  exactKeys(expected,['sourceDigest','imageManifestDigest','imageConfigDigest','offlineUtilityDigest','acceptanceReceiptDigest'],'reviewed deployment evidence pins');
  for(const key of ['sourceDigest','offlineUtilityDigest','acceptanceReceiptDigest'] as const) hexBytes(expected[key],32,key);
  for(const key of ['imageManifestDigest','imageConfigDigest'] as const) assert(/^sha256:[0-9a-f]{64}$/u.test(expected[key]));
  exactKeys(value,['version','protocol','kind','createdAt','sourceDigest','imageManifestDigest','imageConfigDigest','offlineUtilityDigest',
    'acceptanceReceiptDigest','firstPlanDigest','upgradePlanDigest','journalDigest','nativeRestoreReceiptDigest','nativeDumpSha256',
    'actualRootlessContainerExecution','actualNativePostgresqlRestore','actualCoreChain','coreVersion','successfulInstallations',
    'successfulExactPreviousContainerRollbacks','idempotentInstallReconciliations','idempotentRollbackReconciliations',
    'successfulWatcherHealthIterations','databaseInstanceSubstitutionRefusals','schemaSubstitutionRefusals','migrationCount','databaseHistoryPreserved','sameCompatibleImageAcrossReleases',
    'databaseDowngraded','historicalContainersDeleted','codeMounts','readonlyRootFilesystem','listener','operationalDatabaseAccess',
    'publicNetworkBroadcasts','publicListener','realDefaultSignetVerified','productionDeploymentClaimed','fundingAuthorized',
    'cleanServiceShutdownVerified','receiptDigest'],'actual private deployment/rollback evidence');
  const result=value as Record<string,any>;
  assert(result.version===1 && result.protocol===PRESIGNED_PROTOCOL_V3 && result.kind==='actual-private-loopback-deployment-rollback' &&
    Number.isFinite(Date.parse(result.createdAt)) && result.actualRootlessContainerExecution===true && result.actualNativePostgresqlRestore===true &&
    result.actualCoreChain==='isolated-regtest' && result.coreVersion===310100 && result.successfulInstallations===2 &&
    result.successfulExactPreviousContainerRollbacks===1 && result.idempotentInstallReconciliations===1 && result.idempotentRollbackReconciliations===1 &&
    result.successfulWatcherHealthIterations===2 && result.databaseInstanceSubstitutionRefusals===3 && result.schemaSubstitutionRefusals===2 &&
    result.migrationCount===EXPECTED_MIGRATION_VERSIONS.length && result.databaseHistoryPreserved===true &&
    result.sameCompatibleImageAcrossReleases===true && result.databaseDowngraded===false && result.historicalContainersDeleted===false &&
    result.codeMounts===false && result.readonlyRootFilesystem===true && result.listener==='127.0.0.1' && result.operationalDatabaseAccess===false &&
    result.publicNetworkBroadcasts===0 && result.publicListener===false && result.realDefaultSignetVerified===false &&
    result.productionDeploymentClaimed===false && result.fundingAuthorized===false && result.cleanServiceShutdownVerified===true,
  'deployment proof is partial, unsafe, or overstates its isolated same-image rollback scope');
  for(const key of ['sourceDigest','offlineUtilityDigest','acceptanceReceiptDigest','firstPlanDigest','upgradePlanDigest','journalDigest',
    'nativeRestoreReceiptDigest','nativeDumpSha256','receiptDigest']) hexBytes(result[key],32,key);
  for(const key of ['imageManifestDigest','imageConfigDigest']) assert(/^sha256:[0-9a-f]{64}$/u.test(result[key]));
  assert(result.firstPlanDigest!==result.upgradePlanDigest,'two actual release identities are required');
  for(const [key,value] of Object.entries(expected)) assert(result[key]===value,'deployment evidence belongs to another exact image, source, recovery file or final receipt');
  const {receiptDigest,...body}=result;
  assert(receiptDigest===commitmentDigest('vault/presigned-graph-v3/deployment-rollback-acceptance',body),'deployment evidence digest changed');
  return result;
}
