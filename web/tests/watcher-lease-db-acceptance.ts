import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeDatabase } from '../lib/server/db.js';
import { withChainWatcherLease } from '../lib/server/watcher-lease.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for watcher lease acceptance');
}

const checks: Array<{ name: string; ok: true }> = [];
const execFileAsync = promisify(execFile);
let firstStarted!: () => void;
let releaseFirst!: () => void;
const started = new Promise<void>((resolve) => { firstStarted = resolve; });
const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

const first = withChainWatcherLease(async () => {
  firstStarted();
  await release;
  return 'first-completed';
});
await started;
let overlappingCallbackRan = false;
const overlapping = await withChainWatcherLease(async () => {
  overlappingCallbackRan = true;
  return 'overlap-completed';
});
assert.deepEqual(overlapping, { acquired: false });
assert.equal(overlappingCallbackRan, false);
const child = await execFileAsync(process.execPath, [
  '--import',
  'tsx',
  'web/scripts/watch-chain.ts',
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS, '--conditions=react-server'),
  },
});
const commandResult = JSON.parse(child.stdout.trim()) as {
  ok?: unknown;
  leaseAcquired?: unknown;
  acted?: unknown;
};
assert.deepEqual(commandResult, {
  ok: true,
  leaseAcquired: false,
  acted: false,
  reason: 'another private chain watcher invocation is active',
});
releaseFirst();
assert.deepEqual(await first, { acquired: true, value: 'first-completed' });
checks.push({ name: 'exactly one overlapping watcher command acquires the PostgreSQL lease', ok: true });

await assert.rejects(
  () => withChainWatcherLease(async () => {
    throw new Error('controlled watcher failure');
  }),
  /controlled watcher failure/u,
);
const afterFailure = await withChainWatcherLease(async () => 'recovered');
assert.deepEqual(afterFailure, { acquired: true, value: 'recovered' });
checks.push({ name: 'a failed watcher releases its lease for the next scheduled invocation', ok: true });

await closeDatabase();
console.log(JSON.stringify({ passed: true, checks }, null, 2));

function mergeNodeOptions(current: string | undefined, required: string): string {
  const values = (current || '').split(/\s+/u).filter(Boolean);
  if (!values.includes(required)) values.push(required);
  return values.join(' ');
}
