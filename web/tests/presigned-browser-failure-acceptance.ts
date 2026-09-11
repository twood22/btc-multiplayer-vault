/** Pure failure-boundary regressions, also run inside both custody suites. */
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { boundedPresignedBrowserCleanup, disablePresignedFailurePageSnapshots,
  presignedBrowserFailureLocations } from '../browser-tests/presigned-failure-report.js';

export async function verifyPresignedBrowserFailureBoundaries(): Promise<string[]> {
  const checks: string[] = [];
  const synthetic = new Error('short fake secret and longer fake private input must not be serialized');
  synthetic.stack = 'Error: short fake secret\n at /private/presigned-v2.spec.ts:468:78\n' +
    ' at /private/presigned-v2-fixture.ts:95:9\n at /private/presigned-v2.spec.ts:468:78';
  assert.deepEqual(presignedBrowserFailureLocations(synthetic), [
    { file: 'presigned-v2.spec.ts', line: 468, column: 78 },
    { file: 'presigned-v2-fixture.ts', line: 95, column: 9 },
  ]);
  assert(!JSON.stringify(presignedBrowserFailureLocations(synthetic)).includes('fake'));
  checks.push('browser failure diagnostics retain only deduplicated allowlisted source locations');
  for (const value of [undefined, null, 'private text', { stack: synthetic.stack }, 17]) {
    assert.deepEqual(presignedBrowserFailureLocations(value), []);
  }
  const hostile = new Error(); Object.defineProperty(hostile, 'stack', { get() { throw synthetic; } });
  assert.deepEqual(presignedBrowserFailureLocations(hostile), []);
  checks.push('unknown errors and throwing getters cannot leak data or replace the original failure');
  const oversized = new Error();
  oversized.stack = Array.from({ length: 20 }, (_, index) => `presigned-v2.spec.ts:${index + 1}:1`).join('\n');
  assert.equal(presignedBrowserFailureLocations(oversized).length, 8);
  oversized.stack = 'presigned-v2.spec.ts:0:1\npresigned-v2.spec.ts:1234567:1\npresigned-v2.spec.ts:1:1234567';
  assert.deepEqual(presignedBrowserFailureLocations(oversized), []);
  oversized.stack = 'x'.repeat(32_768) + 'presigned-v2.spec.ts:1:1';
  assert.deepEqual(presignedBrowserFailureLocations(oversized), []);
  checks.push('failure source-location count and scan length are bounded');
  const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  try {
    delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
    disablePresignedFailurePageSnapshots(); assert.equal(process.env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '';
    disablePresignedFailurePageSnapshots(); assert.equal(process.env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
    else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previous;
  }
  checks.push('direct-spec snapshot privacy cannot inherit an empty opt-out');
  assert.equal(await boundedPresignedBrowserCleanup(() => undefined, 100), 'completed');
  assert.equal(await boundedPresignedBrowserCleanup(async () => undefined, 100), 'completed');
  assert.equal(await boundedPresignedBrowserCleanup(() => { throw synthetic; }, 100), 'failed');
  assert.equal(await boundedPresignedBrowserCleanup(async () => { throw synthetic; }, 100), 'failed');
  checks.push('synchronous and asynchronous cleanup results never serialize thrown values');
  const started = Date.now();
  assert.equal(await boundedPresignedBrowserCleanup(() => new Promise(() => undefined), 20), 'timed-out');
  assert(Date.now() - started < 2_000, 'a stalled cleanup must not block failure reporting');
  checks.push('a never-settling cleanup reaches its separate finite bound');
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(await boundedPresignedBrowserCleanup(() => new Promise((_, reject) => {
      setTimeout(() => reject(synthetic), 35);
    }), 5), 'timed-out');
    await pause(60); assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
  checks.push('late cleanup rejection remains handled after its reporting deadline');
  for (const bound of [0, -1, NaN, Infinity, 1.5, 10_001]) {
    assert.throws(() => boundedPresignedBrowserCleanup(() => undefined, bound));
  }
  checks.push('invalid or unbounded cleanup budgets are refused');
  return checks;
}
