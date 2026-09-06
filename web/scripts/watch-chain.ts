import { pollVaultChain } from '../lib/server/vault-runtime-store';
import { withChainWatcherLease } from '../lib/server/watcher-lease';
import { closeDatabase } from '../lib/server/db';
import { assertReviewedNodeRuntime } from '../../src/runtime-version';

assertReviewedNodeRuntime();
try {
  const leased = await withChainWatcherLease(pollVaultChain);
  if (!leased.acquired) {
    console.log(JSON.stringify({
      ok: true,
      leaseAcquired: false,
      acted: false,
      reason: 'another private chain watcher invocation is active',
    }));
  } else {
    const ok = leased.value.broadcastErrors.length === 0;
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
