import 'server-only';
import { db } from './db';

// Stable repository-specific session lock. It intentionally differs from the
// migration advisory lock and is held on one reserved PostgreSQL connection.
const CHAIN_WATCHER_LOCK = '713714794042931746';

export type ChainWatcherLeaseResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/**
 * Permit at most one watcher invocation to reconcile and submit transactions.
 * PostgreSQL releases the session lock if the process or connection dies.
 */
export async function withChainWatcherLease<T>(
  run: () => Promise<T>,
): Promise<ChainWatcherLeaseResult<T>> {
  const connection = await db().reserve();
  let acquired = false;
  try {
    const rows = await connection<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(${CHAIN_WATCHER_LOCK}::bigint) AS acquired
    `;
    acquired = rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await run() };
  } finally {
    try {
      if (acquired) {
        const rows = await connection<Array<{ released: boolean }>>`
          SELECT pg_advisory_unlock(${CHAIN_WATCHER_LOCK}::bigint) AS released
        `;
        if (rows[0]?.released !== true) {
          throw new Error('private chain watcher PostgreSQL lease was not released');
        }
      }
    } finally {
      connection.release();
    }
  }
}
