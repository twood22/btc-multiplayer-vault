export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertReviewedNodeRuntime } = await import('./src/runtime-version');
    assertReviewedNodeRuntime();
  }
}
