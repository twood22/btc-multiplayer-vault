import 'server-only';
import { Buffer } from 'buffer';
import type { RpcBlockStatus, RpcTransaction } from '../../../src/bitcoin-rpc';
import { isBitcoinTransactionNotFound } from '../../../src/bitcoin-backend-errors';
import { decideConfirmationReconciliation } from '../../../src/chain-reorganization';
import {
  assertExactBroadcastTransaction,
  confirmedBlockHeight,
} from '../../../src/broadcast-lifecycle';
import { db } from './db';
import {
  reanchorConfirmedFunding,
  reanchorConfirmedVaultTransition,
  rollbackConfirmedFunding,
  rollbackConfirmedVaultTransition,
} from './chain-reorganization-store';

export interface ChainReconciliationBackend {
  getBlockStatus(blockHash: string): Promise<RpcBlockStatus>;
  getRawTransaction(txid: string, verbose: boolean | number): Promise<RpcTransaction>;
}

export interface ChainReconciliationResult {
  reanchoredFundingTransactions: string[];
  reanchoredTransactions: string[];
  rolledBackFundingTransactions: string[];
  rolledBackTransactions: string[];
}

/**
 * Reconcile persistent product state against positive chain evidence. The
 * production caller supplies the mainnet-pinned backend. Dependency injection
 * exists so the identical database boundary can be exercised against a
 * disposable Core reorganization without creating a non-mainnet product mode.
 */
export async function reconcileConfirmedChainState(input: {
  backend: ChainReconciliationBackend;
  requiredConfirmations: number;
}): Promise<ChainReconciliationResult> {
  const { backend, requiredConfirmations } = input;
  if (!Number.isSafeInteger(requiredConfirmations) || requiredConfirmations <= 0) {
    throw new Error('required confirmation depth is invalid');
  }
  const transitions = await db()<Array<{
    id: string;
    vault_id: string;
    final_txid: Buffer;
    finalized_tx_hex: string;
    confirmed_height: string | null;
    confirmed_block_hash: Buffer | null;
  }>>`
    SELECT id, vault_id, final_txid, finalized_tx_hex,
           confirmed_height::text, confirmed_block_hash
    FROM vault_transaction_proposals
    WHERE status = 'confirmed'
    ORDER BY confirmed_height DESC NULLS LAST, updated_at DESC
  `;
  const reanchoredTransactions: string[] = [];
  const rolledBackTransactions: string[] = [];
  for (const transition of transitions) {
    const anchor = storedConfirmationAnchor(transition, 'confirmed vault transition');
    const txid = transition.final_txid.toString('hex');
    const status = await backend.getBlockStatus(anchor.blockHash);
    const replacement = status.inBestChain && status.confirmations >= requiredConfirmations
      ? null
      : await currentlyConfirmedTransaction({
          backend,
          txid,
          exactTransactionHex: transition.finalized_tx_hex,
          requiredConfirmations,
        });
    const decision = decideConfirmationReconciliation({
      stored: anchor,
      status,
      replacement,
      requiredConfirmations,
    });
    if (decision.action === 'stable') continue;
    if (decision.action === 'reanchor') {
      await reanchorConfirmedVaultTransition({
        proposalId: transition.id,
        vaultId: transition.vault_id,
        txid,
        priorBlockHash: anchor.blockHash,
        replacementBlockHash: decision.replacement.blockHash,
        replacementConfirmedHeight: decision.replacement.height,
      });
      reanchoredTransactions.push(txid);
    } else {
      await rollbackConfirmedVaultTransition({
        proposalId: transition.id,
        vaultId: transition.vault_id,
        txid,
        priorBlockHash: anchor.blockHash,
      });
      rolledBackTransactions.push(txid);
    }
  }

  const fundingRows = await db()<Array<{
    vault_id: string;
    final_txid: Buffer;
    transaction_hex: string;
    confirmed_height: string | null;
    confirmed_block_hash: Buffer | null;
  }>>`
    SELECT vault_id, final_txid, transaction_hex,
           confirmed_height::text, confirmed_block_hash
    FROM funding_finalizations
    WHERE status = 'confirmed'
    ORDER BY confirmed_height DESC NULLS LAST
  `;
  const reanchoredFundingTransactions: string[] = [];
  const rolledBackFundingTransactions: string[] = [];
  for (const funding of fundingRows) {
    const anchor = storedConfirmationAnchor(funding, 'confirmed funding transaction');
    const txid = funding.final_txid.toString('hex');
    const status = await backend.getBlockStatus(anchor.blockHash);
    const replacement = status.inBestChain && status.confirmations >= requiredConfirmations
      ? null
      : await currentlyConfirmedTransaction({
          backend,
          txid,
          exactTransactionHex: funding.transaction_hex,
          requiredConfirmations,
        });
    const decision = decideConfirmationReconciliation({
      stored: anchor,
      status,
      replacement,
      requiredConfirmations,
    });
    if (decision.action === 'stable') continue;
    if (decision.action === 'reanchor') {
      await reanchorConfirmedFunding({
        vaultId: funding.vault_id,
        txid,
        priorBlockHash: anchor.blockHash,
        replacementBlockHash: decision.replacement.blockHash,
        replacementConfirmedHeight: decision.replacement.height,
      });
      reanchoredFundingTransactions.push(txid);
    } else {
      await rollbackConfirmedFunding({
        vaultId: funding.vault_id,
        txid,
        priorBlockHash: anchor.blockHash,
      });
      rolledBackFundingTransactions.push(txid);
    }
  }
  return {
    reanchoredFundingTransactions,
    reanchoredTransactions,
    rolledBackFundingTransactions,
    rolledBackTransactions,
  };
}

async function currentlyConfirmedTransaction(input: {
  backend: ChainReconciliationBackend;
  txid: string;
  exactTransactionHex: string;
  requiredConfirmations: number;
}): Promise<{ blockHash: string; height: number } | null> {
  let observed: RpcTransaction;
  try {
    observed = await input.backend.getRawTransaction(input.txid, true);
  } catch (error) {
    if (isBitcoinTransactionNotFound(error)) return null;
    throw error;
  }
  assertExactBroadcastTransaction({
    finalizedTxHex: input.exactTransactionHex,
    finalTxid: input.txid,
    observedTxid: observed.txid,
    ...(observed.hex ? { observedTxHex: observed.hex } : {}),
  });
  if ((observed.confirmations || 0) < input.requiredConfirmations) return null;
  const blockHash = observed.blockhash || '';
  const height = confirmedBlockHeight(observed);
  if (!/^[0-9a-f]{64}$/u.test(blockHash) || height === null) {
    throw new Error('replacement confirmation lacks an exact block anchor');
  }
  return { blockHash, height };
}

function storedConfirmationAnchor(
  row: { confirmed_height: string | null; confirmed_block_hash: Buffer | null },
  label: string,
): { height: number; blockHash: string } {
  const height = Number(row.confirmed_height);
  const blockHash = row.confirmed_block_hash?.toString('hex') || '';
  if (!Number.isSafeInteger(height) || height <= 0 || !/^[0-9a-f]{64}$/u.test(blockHash)) {
    throw new Error(`${label} lacks an active-chain block anchor; manual reconciliation is required`);
  }
  return { height, blockHash };
}
