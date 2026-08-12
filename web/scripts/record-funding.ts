import { getRawTransaction, getTxOut } from '../../src/bitcoin-rpc';
import { assertReviewedNodeRuntime } from '../../src/runtime-version';
import { chainConfirmationsRequired } from '../lib/server/config';
import { recordConfirmedFundingCoin } from '../lib/server/vault-runtime-store';

assertReviewedNodeRuntime();
const args = parseArgs(process.argv.slice(2));
const vaultId = required(args, 'vault-id');
const txid = required(args, 'txid').toLowerCase();
const vout = Number(required(args, 'vout'));
if (!/^[0-9a-f]{64}$/u.test(txid)) throw new Error('--txid must be 64 lowercase hex characters');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(vaultId)) {
  throw new Error('--vault-id must be a UUID');
}
if (!Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
  throw new Error('--vout must be a valid transaction output index');
}

const [output, transaction] = await Promise.all([
  getTxOut(txid, vout),
  getRawTransaction(txid, 2),
]);
if (!output) throw new Error('funding output does not exist or is already spent');
if (transaction.txid !== txid) throw new Error('Bitcoin backend returned a different funding transaction');
const rawOutput = transaction.vout.find((item) => item.n === vout);
if (!rawOutput) throw new Error('funding transaction does not contain the requested output');
const scriptPubKeyHex = output.scriptPubKey?.hex;
if (!scriptPubKeyHex || !/^5120[0-9a-f]{64}$/u.test(scriptPubKeyHex)) {
  throw new Error('funding output is not a Taproot v1 output');
}
if (rawOutput.scriptPubKey?.hex !== scriptPubKeyHex ||
    btcToSats(rawOutput.value) !== btcToSats(output.value)) {
  throw new Error('Bitcoin backend returned inconsistent funding output data');
}
const confirmations = Math.min(output.confirmations, transaction.confirmations || 0);
const requiredConfirmations = chainConfirmationsRequired();
if (confirmations < requiredConfirmations) {
  throw new Error(`funding output has ${confirmations} confirmation(s); ${requiredConfirmations} required`);
}
const confirmedHeight = transaction.blockheight;
if (typeof confirmedHeight !== 'number' ||
    !Number.isSafeInteger(confirmedHeight) ||
    confirmedHeight <= 0) {
  throw new Error('funding transaction has no valid confirmed block height');
}
const recorded = await recordConfirmedFundingCoin({
  vaultId,
  trustedInput: {
    txid,
    vout,
    valueSats: btcToSats(output.value),
    scriptPubKeyHex,
  },
  fundingTransaction: transaction,
  confirmedHeight,
  confirmations,
});
console.log(JSON.stringify({
  ok: true,
  network: 'mainnet',
  txid,
  vout,
  confirmations,
  confirmedHeight,
  snapshotDigest: recorded.snapshotDigest,
  fundingProposalDigest: recorded.fundingProposalDigest,
  participantInputCount: recorded.fundingAuthorization.participantInputCount,
  inputValuesSats: recorded.fundingAuthorization.inputValuesSats,
  feeSats: recorded.fundingAuthorization.feeSats,
}, null, 2));

function btcToSats(value: number | string | null | undefined): number {
  const numeric = Number(value);
  const sats = Math.round(numeric * 100_000_000);
  if (!Number.isFinite(numeric) || !Number.isSafeInteger(sats) || sats <= 0 ||
      Math.abs(numeric - sats / 100_000_000) > 1e-12) {
    throw new Error('Bitcoin backend returned an invalid BTC amount');
  }
  return sats;
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('usage: --vault-id <uuid> --txid <mainnet-txid> --vout <index>');
    }
    parsed[name.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
