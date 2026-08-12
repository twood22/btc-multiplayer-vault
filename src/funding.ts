import type { RpcTransaction } from './bitcoin-rpc.js';

export const MIN_FUNDING_RELAY_FEE_SATS = 500;
// The product's own change addresses are P2TR; 330 sats is the conventional
// 3 sat/vB dust threshold for a P2TR output and preserves tiny-mainnet use.
export const MIN_SAFE_CHANGE_SATS = 330;

export interface ConfirmedFundingAuthorization {
  txid: string;
  fundingVout: number;
  participantInputCount: 3;
  inputValuesSats: number[];
  fundingValueSats: number;
  feeSats: number;
}

export function isSupportedFundingInputScript(scriptPubKeyHex: string): boolean {
  return /^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/u.test(scriptPubKeyHex.toLowerCase());
}

/**
 * Authorize the confirmed initial transaction before the service activates a
 * vault. The chain cannot prove human ownership labels, but it can prove the
 * exact on-chain structure produced by the three-person funding workflow:
 * three distinct supported SegWit inputs, each large enough for one committed
 * deposit, and exactly one committed round-one output.
 */
export function authorizeConfirmedFundingTransaction(input: {
  transaction: RpcTransaction;
  expectedTxid: string;
  expectedVout: number;
  depositSatsPerParticipant: number;
  fundingValueSats: number;
  fundingScriptPubKeyHex: string;
}): ConfirmedFundingAuthorization {
  const transaction = input.transaction;
  if (transaction.txid !== input.expectedTxid) {
    throw new Error('funding backend returned a different transaction id');
  }
  if (transaction.vin.length !== 3) {
    throw new Error(`funding transaction must contain exactly three participant inputs, got ${transaction.vin.length}`);
  }
  if (!Number.isSafeInteger(input.depositSatsPerParticipant) || input.depositSatsPerParticipant <= 0) {
    throw new Error('committed participant deposit is invalid');
  }
  if (input.fundingValueSats !== input.depositSatsPerParticipant * 3) {
    throw new Error('committed funding value is not exactly three participant deposits');
  }

  const seenOutpoints = new Set<string>();
  const inputValuesSats = transaction.vin.map((fundingInput, index) => {
    if (fundingInput.coinbase || !/^[0-9a-f]{64}$/u.test(fundingInput.txid || '') ||
        !Number.isSafeInteger(fundingInput.vout) || fundingInput.vout! < 0 ||
        fundingInput.vout! > 0xffffffff) {
      throw new Error(`funding input ${index} does not name a normal Bitcoin outpoint`);
    }
    const outpoint = `${fundingInput.txid}:${fundingInput.vout}`;
    if (seenOutpoints.has(outpoint)) throw new Error(`funding transaction repeats input ${outpoint}`);
    seenOutpoints.add(outpoint);
    const prevoutValue = fundingInput.prevout?.value;
    const prevoutScript = fundingInput.prevout?.scriptPubKey?.hex;
    if (prevoutValue === undefined || !prevoutScript) {
      throw new Error(`funding input ${index} is missing its resolved prevout`);
    }
    if (!isSupportedFundingInputScript(prevoutScript)) {
      throw new Error(`funding input ${index} is not a supported native P2WPKH or P2TR output`);
    }
    const valueSats = btcToSats(prevoutValue, `funding input ${index}`);
    if (valueSats < input.depositSatsPerParticipant) {
      throw new Error(`funding input ${index} is below the committed participant deposit`);
    }
    return valueSats;
  });

  const fundingScript = input.fundingScriptPubKeyHex.toLowerCase();
  const matchingOutputs = transaction.vout.filter((output) =>
    output.scriptPubKey?.hex?.toLowerCase() === fundingScript);
  if (matchingOutputs.length !== 1) {
    throw new Error(`funding transaction must contain exactly one output to the committed vault, got ${matchingOutputs.length}`);
  }
  const fundingOutput = matchingOutputs[0]!;
  if (fundingOutput.n !== input.expectedVout) {
    throw new Error('selected funding output index is not the unique committed vault output');
  }
  const fundingValueSats = btcToSats(fundingOutput.value, 'funding output');
  if (fundingValueSats !== input.fundingValueSats) {
    throw new Error('funding output value is not exactly three committed participant deposits');
  }
  if (transaction.vout.some((output, index) => output.n !== index)) {
    throw new Error('funding backend returned non-canonical output indexes');
  }
  if (transaction.vout.length < 1 || transaction.vout.length > 4) {
    throw new Error('funding transaction must contain one vault output and at most three change outputs');
  }
  for (const output of transaction.vout) {
    const valueSats = btcToSats(output.value, `funding output ${output.n}`);
    if (output.n !== input.expectedVout && valueSats < MIN_SAFE_CHANGE_SATS) {
      throw new Error(`funding change output ${output.n} is below the safe dust floor`);
    }
  }

  const inputTotal = inputValuesSats.reduce((sum, value) => sum + value, 0);
  const outputTotal = transaction.vout.reduce(
    (sum, output) => sum + btcToSats(output.value, `funding output ${output.n}`),
    0,
  );
  const feeSats = inputTotal - outputTotal;
  if (feeSats < MIN_FUNDING_RELAY_FEE_SATS) {
    throw new Error(`funding fee ${feeSats} sats is below the ${MIN_FUNDING_RELAY_FEE_SATS} sat safety floor`);
  }
  if (feeSats >= input.depositSatsPerParticipant) {
    throw new Error('funding fee consumes at least one participant deposit');
  }

  return {
    txid: transaction.txid,
    fundingVout: fundingOutput.n,
    participantInputCount: 3,
    inputValuesSats,
    fundingValueSats,
    feeSats,
  };
}

function btcToSats(value: number | string, label: string): number {
  const numeric = Number(value);
  const sats = Math.round(numeric * 100_000_000);
  if (!Number.isFinite(numeric) || !Number.isSafeInteger(sats) || sats < 0 ||
      Math.abs(numeric - sats / 100_000_000) > 1e-12) {
    throw new Error(`${label} has an invalid BTC amount`);
  }
  return sats;
}
