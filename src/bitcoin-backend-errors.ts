/**
 * Authoritative evidence that one exact transaction is absent from the
 * backend's mempool and indexed blockchain. Transport, authentication, and
 * malformed-response failures must never use this error type.
 */
export class BitcoinTransactionNotFoundError extends Error {
  readonly txid: string;

  constructor(txid: string) {
    super(`Bitcoin transaction ${txid} is not present in the backend`);
    this.name = 'BitcoinTransactionNotFoundError';
    this.txid = txid;
  }
}

export function isBitcoinTransactionNotFound(
  error: unknown,
): error is BitcoinTransactionNotFoundError {
  return error instanceof BitcoinTransactionNotFoundError;
}
