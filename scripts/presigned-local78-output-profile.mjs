/** Additive source83e producer leaves; the historical75 profile stays immutable. */
import { OUTPUT_FIELDS as HISTORICAL } from './presigned-local-output-profile.mjs';
const fields = (booleans, numbers, strings, arrays = []) => Object.fromEntries([
  ...booleans.map(key => [key,'b']), ...numbers.map(key => [key,'n']),
  ...strings.map(key => [key,'s']), ...arrays.map(key => [`${key}[]`,'s']),
]);
export const OUTPUT_FIELDS = {
  ...HISTORICAL,
  'crypto-NETWORK-08': {...HISTORICAL['crypto-NETWORK-08'], 'protocols[]':'s'},
  'observation-cli-boundaries': fields(
    ['passed','legacyV2DefaultPreserved','preCookieArgumentRejection','syntheticRpcFixture',
      'productionRpcOrChainContact','actualChainEvidence','realCredentials','signed','broadcast'],
    ['commandCount','negativeCases','successfulProducerConsumerCases','requests'],
    ['suite','evidence'], ['protocols','networks','readOnlyMethods']),
  'offline-source-boundaries': fields(
    ['passed','syntheticPublicFixturesOnly','actualChainEvidence','rpc','signed','broadcast'],
    ['checks','positiveCases','negativeCases','graphSources','ageBoundaryCases','pendingConflictCases'],
    ['suite'], ['protocols','networks']),
  'offline-fee-review-boundaries': fields(
    ['passed','actualBrowserExecuted','syntheticPublicFixturesOnly','actualBlockchainContact'],
    ['validPackages','rejectedImports','refusedActions','asyncInvalidations','validFundingPackages',
      'fundingConflictingImportsRejected','fundingIncompleteFinalizationsRefused','networkRequests','publicNetworkBroadcasts'],
    ['kind','sourceDigest','suiteSha256','artifactSha256','manifestSha256','inputDigest'], ['protocols']),
  'offline-full': {...HISTORICAL['offline-full'],
    ...Object.fromEntries(['recoveryMissingObservationRefusals','recoveryImmatureRefusals',
      'recoveryWrongSourcePeerRefusals','recoveryAsyncSourceInvalidations','recoveryObservedSourceReviews'].map(key => [key,'n']))},
};
