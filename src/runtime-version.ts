export const REVIEWED_NODE_VERSION = '22.23.2';

export interface NodeRuntimeCheck {
  ok: boolean;
  actual: string;
  expected: string;
}

export function reviewedNodeRuntimeCheck(actual = process.versions.node): NodeRuntimeCheck {
  return {
    ok: actual === REVIEWED_NODE_VERSION,
    actual,
    expected: REVIEWED_NODE_VERSION,
  };
}

export function assertReviewedNodeRuntime(actual = process.versions.node): void {
  const checked = reviewedNodeRuntimeCheck(actual);
  if (!checked.ok) {
    throw new Error(
      `btc-multiplayer-vault requires the reviewed Node.js ${checked.expected} runtime; ` +
      `current runtime is ${checked.actual}. Select the repository's .node-version before continuing.`,
    );
  }
}
