import { pollVaultChain } from '../lib/server/vault-runtime-store';
import { withChainWatcherLease } from '../lib/server/watcher-lease';
import { closeDatabase } from '../lib/server/db';
import { assertReviewedNodeRuntime } from '../../src/runtime-version';
import { pollPresignedVaultChains } from '../lib/server/presigned-chain-store';
import { retryPresignedBroadcasts } from '../lib/server/presigned-broadcast-store';
import { retryPresignedFeePackages } from '../lib/server/presigned-fee-store';

assertReviewedNodeRuntime();
try {
  const leased = await withChainWatcherLease(async () => {
    const legacy = await pollVaultChain();
    const presignedBroadcasts = await retryPresignedBroadcasts();
    const presignedFees = await retryPresignedFeePackages();
    const presignedChain = await pollPresignedVaultChains();
    return { ...legacy, presignedBroadcasts, presignedFees, presignedChain };
  });
  if (!leased.acquired) {
    console.log(JSON.stringify({
      ok: true,
      leaseAcquired: false,
      acted: false,
      reason: 'another private chain watcher invocation is active',
    }));
  } else {
    const ok = leased.value.broadcastErrors.length === 0 && leased.value.presignedChain.deferredVaults === 0 &&
      leased.value.presignedBroadcasts.results.every(result => result.status !== 'deferred') &&
      leased.value.presignedFees.results.every(result => result.status !== 'deferred');
    console.log(JSON.stringify({
      ok,
      leaseAcquired: true,
      acted: true,
      ...leased.value,
    }));
    if (!ok) process.exitCode = 1;
  }
} finally {
  await closeDatabase();
}
