import assert from 'node:assert/strict';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3 } from '../../src/presigned/types.js';
import { presignedBroadcastEnabled } from '../lib/server/presigned-broadcast-store.js';
import { assertPresignedSoftwareRelease } from '../lib/server/presigned-release-store.js';

// In-process environment controls only; no database, RPC, signing or sends.
assert.equal(BITCOIN_NETWORK_NAME, 'mainnet', 'run this boundary test with the explicit mainnet format profile');
const names = ['PRESIGNED_V2_BROADCAST_NETWORK', 'PRESIGNED_V2_MAINNET_AUTHORIZATION', 'PRESIGNED_V3_MAINNET_AUTHORIZATION'] as const;
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
try {
  for (const name of names) delete process.env[name];
  assert.equal(presignedBroadcastEnabled(), false);
  process.env.PRESIGNED_V2_BROADCAST_NETWORK = 'mainnet';
  assert.equal(presignedBroadcastEnabled(PRESIGNED_PROTOCOL), false);
  assert.equal(presignedBroadcastEnabled(PRESIGNED_PROTOCOL_V3), false);
  process.env.PRESIGNED_V2_MAINNET_AUTHORIZATION = 'separately-approved-mainnet-spending';
  assert.equal(presignedBroadcastEnabled(PRESIGNED_PROTOCOL), true);
  assert.equal(presignedBroadcastEnabled(PRESIGNED_PROTOCOL_V3), false);
  assert.throws(() => assertPresignedSoftwareRelease(PRESIGNED_PROTOCOL_V3), /requires separate explicit mainnet authorization/);
  process.env.PRESIGNED_V3_MAINNET_AUTHORIZATION = 'separately-approved-mainnet-spending';
  delete process.env.PRESIGNED_V2_MAINNET_AUTHORIZATION;
  assert.equal(presignedBroadcastEnabled(PRESIGNED_PROTOCOL), false);
  assert.equal(presignedBroadcastEnabled(PRESIGNED_PROTOCOL_V3), true);
  assert.equal(presignedBroadcastEnabled(), true);
  process.env.PRESIGNED_V2_BROADCAST_NETWORK = 'signet';
  assert.equal(presignedBroadcastEnabled(PRESIGNED_PROTOCOL_V3), false);
  console.log(JSON.stringify({ suite: 'mainnet-protocol-authorization-boundary', passed: true,
    historicalV2ApprovalDoesNotAuthorizeV3: true, rpcCalls: 0, broadcasts: 0, realMainnetAuthorizationGranted: false }));
} finally {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
}
