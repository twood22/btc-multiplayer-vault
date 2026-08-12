import assert from 'node:assert/strict';
import type { RpcTransaction } from '../../src/bitcoin-rpc.js';
import {
  authorizeConfirmedFundingTransaction,
  MIN_FUNDING_RELAY_FEE_SATS,
} from '../../src/funding.js';
import { buildFundingPsbt, type FundingInput } from '../../src/psbt.js';
import { createDemoState } from '../../src/vault.js';

const checks: Array<{ name: string; ok: true }> = [];
const txid = '11'.repeat(32);
const fundingScriptPubKeyHex = `5120${'44'.repeat(32)}`;
const depositSatsPerParticipant = 10_000;
const validTransaction: RpcTransaction = {
  txid,
  vin: [0, 1, 2].map((index) => ({
    txid: String(index + 1).padStart(64, '0'),
    vout: index,
    prevout: {
      value: 12_000 / 100_000_000,
      scriptPubKey: {
        hex: index === 0 ? `0014${'22'.repeat(20)}` : `5120${String(index + 2).padStart(2, '0').repeat(32)}`,
      },
    },
  })),
  vout: [
    { n: 0, value: 30_000 / 100_000_000, scriptPubKey: { hex: fundingScriptPubKeyHex } },
    { n: 1, value: 550 / 100_000_000, scriptPubKey: { hex: `0014${'55'.repeat(20)}` } },
    { n: 2, value: 550 / 100_000_000, scriptPubKey: { hex: `0014${'66'.repeat(20)}` } },
    { n: 3, value: 550 / 100_000_000, scriptPubKey: { hex: `5120${'77'.repeat(32)}` } },
  ],
};

const authorized = authorize(validTransaction);
assert.equal(authorized.participantInputCount, 3);
assert.deepEqual(authorized.inputValuesSats, [12_000, 12_000, 12_000]);
assert.equal(authorized.fundingValueSats, 30_000);
assert.equal(authorized.feeSats, 4_350);
checks.push({
  name: 'confirmed funding requires three qualifying inputs and one exact committed vault output',
  ok: true,
});

rejects('a one-person funding transaction', /exactly three participant inputs/u, (transaction) => {
  transaction.vin = transaction.vin.slice(0, 1);
});
rejects('a backend transaction id different from the selected funding txid', /different transaction id/u,
  (transaction) => {
    transaction.txid = 'ff'.repeat(32);
  });
rejects('a repeated funding outpoint', /repeats input/u, (transaction) => {
  transaction.vin[1]!.txid = transaction.vin[0]!.txid;
  transaction.vin[1]!.vout = transaction.vin[0]!.vout;
});
rejects('a funding input without a resolved prevout', /missing its resolved prevout/u, (transaction) => {
  delete transaction.vin[1]!.prevout;
});
rejects('a legacy funding input unsupported by the PSBT workflow', /not a supported native/u, (transaction) => {
  transaction.vin[1]!.prevout!.scriptPubKey!.hex = `76a914${'88'.repeat(20)}88ac`;
});
rejects('an input below one committed participant deposit', /below the committed participant deposit/u, (transaction) => {
  transaction.vin[2]!.prevout!.value = 9_999 / 100_000_000;
});
rejects('two outputs to the committed vault', /exactly one output to the committed vault/u, (transaction) => {
  transaction.vout[1]!.scriptPubKey!.hex = fundingScriptPubKeyHex;
});
rejects('a selected vout different from the unique committed output', /selected funding output index/u,
  undefined, 1);
rejects('non-canonical output indexes from a backend', /non-canonical output indexes/u, (transaction) => {
  transaction.vout[2]!.n = 9;
});
rejects('more than three funding change outputs', /at most three change outputs/u, (transaction) => {
  transaction.vout.push({
    n: 4,
    value: 330 / 100_000_000,
    scriptPubKey: { hex: `0014${'ab'.repeat(20)}` },
  });
});
rejects('a dust-sized funding change output', /below the safe dust floor/u, (transaction) => {
  transaction.vout[1]!.value = 329 / 100_000_000;
});
rejects('a funding transaction below the minimum relay-fee safety floor', /below the 500 sat safety floor/u,
  (transaction) => {
    transaction.vout = [
      transaction.vout[0]!,
      { n: 1, value: 5_501 / 100_000_000, scriptPubKey: { hex: `0014${'99'.repeat(20)}` } },
    ];
  });
rejects('a funding fee as large as a participant deposit', /consumes at least one participant deposit/u,
  (transaction) => {
    for (const fundingInput of transaction.vin) fundingInput.prevout!.value = 14_000 / 100_000_000;
    transaction.vout = [transaction.vout[0]!];
  });

const state = createDemoState();
const fundingInputs: FundingInput[] = state.participants.map((participant, index) => ({
  participantId: participant.id,
  txid: String(index + 1).padStart(64, '0'),
  vout: 0,
  valueSats: state.economics.depositSatsPerParticipant + 2_000,
  scriptPubKeyHex: `5120${participant.personal.xonlyPubKeyHex}`,
  changeAddress: participant.payoutAddress,
}));
const built = buildFundingPsbt({ state, inputs: fundingInputs, feeSats: 3_000 });
assert(built.psbtBase64.startsWith('cHNidP'));
assert.throws(
  () => buildFundingPsbt({ state, inputs: fundingInputs, feeSats: MIN_FUNDING_RELAY_FEE_SATS - 1 }),
  /funding fee must be an integer/u,
);
assert.throws(
  () => buildFundingPsbt({
    state,
    inputs: fundingInputs.map((input, index) => index === 2 ? { ...input, participantId: 'bob' } : input),
    feeSats: 3_000,
  }),
  /exactly one input for each/u,
);
assert.throws(
  () => buildFundingPsbt({
    state,
    inputs: fundingInputs.map((input, index) => index === 2
      ? { ...input, txid: fundingInputs[0]!.txid, vout: fundingInputs[0]!.vout }
      : input),
    feeSats: 3_000,
  }),
  /distinct outpoints/u,
);
assert.throws(
  () => buildFundingPsbt({
    state,
    inputs: fundingInputs.map((input, index) => index === 1
      ? { ...input, scriptPubKeyHex: `76a914${'aa'.repeat(20)}88ac` }
      : input),
    feeSats: 3_000,
  }),
  /must be native P2WPKH or P2TR/u,
);
assert.throws(
  () => buildFundingPsbt({
    state,
    inputs: fundingInputs.map((input, index) => index === 0
      ? { ...input, valueSats: state.economics.depositSatsPerParticipant + 1_329 }
      : input),
    feeSats: 3_000,
  }),
  /below the safe dust floor/u,
);
checks.push({
  name: 'funding PSBT construction rejects missing seats, duplicate coins, legacy inputs, low fees, and dust change',
  ok: true,
});

console.log(JSON.stringify({ passed: true, checks }, null, 2));

function authorize(transaction: RpcTransaction, expectedVout = 0) {
  return authorizeConfirmedFundingTransaction({
    transaction,
    expectedTxid: txid,
    expectedVout,
    depositSatsPerParticipant,
    fundingValueSats: depositSatsPerParticipant * 3,
    fundingScriptPubKeyHex,
  });
}

function rejects(
  name: string,
  expected: RegExp,
  mutate?: (transaction: RpcTransaction) => void,
  expectedVout = 0,
): void {
  const transaction = structuredClone(validTransaction);
  mutate?.(transaction);
  assert.throws(() => authorize(transaction, expectedVout), expected);
  checks.push({ name, ok: true });
}
