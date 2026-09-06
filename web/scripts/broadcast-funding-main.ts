import { assertReviewedNodeRuntime } from '../../src/runtime-version';
import { authorizeFundingBroadcastCommand } from '../../src/funding-broadcast-command';
import { submitPasskeyApprovedFunding } from '../lib/server/funding-signature-store';

assertReviewedNodeRuntime();

const authorization = authorizeFundingBroadcastCommand(process.argv.slice(2), process.env);
const result = await submitPasskeyApprovedFunding({
  vaultId: authorization.vaultId,
  expectedFinalizationDigest: authorization.finalizationDigest,
  expectedFinalTxid: authorization.finalTxid,
});
console.log(JSON.stringify({
  ok: true,
  network: authorization.network,
  vaultId: authorization.vaultId,
  ...result,
}, null, 2));
