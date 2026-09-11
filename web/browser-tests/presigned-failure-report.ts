/** Test-harness diagnostics only. Never inspect page text or serialize errors. */
export interface PresignedBrowserFailureLocation {
  file: 'presigned-v2.spec.ts' | 'presigned-v2-fixture.ts';
  line: number;
  column: number;
}

/** Playwright's automatic aria/error-context snapshot is independent of its
 * trace, screenshot and video options. Call before creating any test context,
 * including when the V2 spec is invoked directly without the shell wrapper. */
export function disablePresignedFailurePageSnapshots(): void {
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
}

export function presignedBrowserFailureLocations(error: unknown): PresignedBrowserFailureLocation[] {
  const locations: PresignedBrowserFailureLocation[] = [];
  // Custom exception getters may also fail. Never fall back to String(error),
  // its message, DOM text, a URL, a request payload or authenticator state.
  try {
    if (!(error instanceof Error)) return locations;
    const stack = error.stack;
    if (typeof stack !== 'string') return locations;
    for (const match of stack.slice(0, 32_768).matchAll(/(presigned-v2\.spec\.ts|presigned-v2-fixture\.ts):(\d{1,6}):(\d{1,6})(?!\d)/gu)) {
      const file = match[1] as PresignedBrowserFailureLocation['file'];
      const line = Number(match[2]), column = Number(match[3]);
      if (line < 1 || column < 1 || locations.some(item => item.file === file && item.line === line && item.column === column)) continue;
      locations.push({ file, line, column });
      if (locations.length === 8) break;
    }
  } catch { /* Only the known stage names remain available. */ }
  return locations;
}

export type PresignedBrowserCleanupOutcome = 'completed' | 'failed' | 'timed-out';

/** Bound best-effort cleanup, not a test assertion or an application operation.
 * This does not cancel a pending operation. Its eventual rejection remains
 * handled; callers must still close the owning browser and refuse acceptance. */
export function boundedPresignedBrowserCleanup(
  operation: () => unknown | PromiseLike<unknown>, maximumMilliseconds = 5_000,
): Promise<PresignedBrowserCleanupOutcome> {
  if (!Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < 1 || maximumMilliseconds > 10_000) {
    throw new Error('browser cleanup bound must be 1-10000 milliseconds');
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: PresignedBrowserCleanupOutcome) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(outcome);
    };
    const timer = setTimeout(() => finish('timed-out'), maximumMilliseconds);
    try { Promise.resolve(operation()).then(() => finish('completed'), () => finish('failed')); }
    catch { finish('failed'); }
  });
}
