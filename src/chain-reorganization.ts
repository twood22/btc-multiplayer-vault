export interface ConfirmationAnchor {
  blockHash: string;
  height: number;
}

export type ConfirmationReconciliation =
  | { action: 'stable' }
  | { action: 'reanchor'; replacement: ConfirmationAnchor }
  | { action: 'rollback' };

/**
 * Pure decision boundary. A missing or malformed backend status throws; it can
 * never be interpreted as rollback evidence by a truthy/falsy shortcut.
 */
export function decideConfirmationReconciliation(input: {
  stored: ConfirmationAnchor;
  status: {
    hash: string;
    height: number;
    confirmations: number;
    inBestChain: boolean;
  };
  replacement: ConfirmationAnchor | null;
  requiredConfirmations: number;
}): ConfirmationReconciliation {
  assertAnchor(input.stored, 'stored confirmation');
  if (!Number.isSafeInteger(input.requiredConfirmations) || input.requiredConfirmations <= 0) {
    throw new Error('required confirmation depth is invalid');
  }
  const status = input.status;
  if (!status || status.hash !== input.stored.blockHash || status.height !== input.stored.height ||
      typeof status.inBestChain !== 'boolean' || !Number.isSafeInteger(status.confirmations) ||
      (status.inBestChain ? status.confirmations <= 0 : status.confirmations !== -1)) {
    throw new Error('backend block status is missing or inconsistent with the stored confirmation');
  }
  if (status.inBestChain && status.confirmations >= input.requiredConfirmations) {
    if (input.replacement) throw new Error('stable confirmation cannot also have a replacement block');
    return { action: 'stable' };
  }
  if (!input.replacement) return { action: 'rollback' };
  assertAnchor(input.replacement, 'replacement confirmation');
  if (input.replacement.blockHash === input.stored.blockHash) {
    throw new Error('one block cannot be both the removed and replacement confirmation');
  }
  return { action: 'reanchor', replacement: input.replacement };
}

function assertAnchor(anchor: ConfirmationAnchor, label: string): void {
  if (!anchor || !/^[0-9a-f]{64}$/u.test(anchor.blockHash) ||
      !Number.isSafeInteger(anchor.height) || anchor.height <= 0) {
    throw new Error(`${label} anchor is invalid`);
  }
}
