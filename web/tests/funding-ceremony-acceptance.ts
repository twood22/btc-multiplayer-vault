import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import {
  authorizeConfirmedFundingProposal,
  buildFundingProposal,
  DEFAULT_FUNDING_FEE_SATS,
  fundingInputCommitmentDigest,
  validateFundingInputCommitment,
  type FundingInputCommitment,
} from '../../src/funding-ceremony.js';
import type { RpcTransaction } from '../../src/bitcoin-rpc.js';
import { unsignedTx } from '../../src/psbt.js';
import {
  base58CheckEncode,
  deriveXpubChildPubkey,
  deterministicKeypair,
  sha256Hex,
  xpubRootXonly,
} from '../../src/crypto.js';
import { createPublishedRosterArtifact, publishedRosterDigest } from '../../src/roster-ceremony.js';
import { asSats, type VaultEconomics } from '../../src/types.js';
import {
  participantLeaveRounds,
  rosterEntry,
  type RosterEntry,
  type SigbashRosterRegistration,
} from '../../src/vault.js';

const ids = ['alice', 'bob', 'carol'];
const artifact = createPublishedRosterArtifact(
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  liveRoster(),
  tinyEconomics(),
);
const rosterDigest = publishedRosterDigest(artifact);
const commitments = artifact.participants.map((participant, index): FundingInputCommitment => ({
  version: 1,
  network: 'mainnet',
  vaultId: artifact.vaultId,
  rosterDigest,
  participantId: participant.id,
  txid: String(index + 1).padStart(64, '0'),
  vout: index,
  valueSats: artifact.economics.depositSatsPerParticipant + 530,
  scriptPubKeyHex: `5120${participant.personalPublicKeyHex.slice(2)}`,
  changeAddress: participant.payoutAddress,
  sourceOrigin: 'https://mempool.space',
  confirmations: 2,
  observedUnspent: true,
  fundingFeeSats: DEFAULT_FUNDING_FEE_SATS,
}));
const checks: Array<{ name: string; ok: true }> = [];

const proposal = buildFundingProposal({
  artifact,
  commitments,
  fundingFeeSats: DEFAULT_FUNDING_FEE_SATS,
});
const psbt = bitcoin.Psbt.fromBase64(proposal.psbtBase64);
assert.equal(psbt.inputCount, 3);
assert.equal(psbt.txOutputs.length, 4);
assert.equal(proposal.txTemplate.outputs[0]!.address, artifact.funding.address);
assert.equal(proposal.txTemplate.outputs[0]!.valueSats, 30_000);
assert.deepEqual(proposal.txTemplate.inputs.map((input) => input.participantId), ids);
assert(proposal.txTemplate.inputs.every((input) => input.changeSats === 330));
checks.push({ name: 'three passkey-approved wallet coins deterministically build one exact mainnet funding PSBT', ok: true });

const expectedTransaction = unsignedTx(psbt);
const confirmedTransaction: RpcTransaction = {
  txid: proposal.unsignedTxid,
  version: expectedTransaction.version,
  locktime: expectedTransaction.locktime,
  vin: expectedTransaction.ins.map((input) => ({
    txid: Buffer.from(input.hash).reverse().toString('hex'),
    vout: input.index,
    sequence: input.sequence,
  })),
  vout: expectedTransaction.outs.map((output, index) => ({
    n: index,
    value: Number(output.value) / 100_000_000,
    scriptPubKey: { hex: Buffer.from(output.script).toString('hex') },
  })),
};
assert.doesNotThrow(() => authorizeConfirmedFundingProposal(confirmedTransaction, proposal));
for (const [name, mutate, expected] of [
  ['transaction id', (tx: RpcTransaction) => { tx.txid = 'ff'.repeat(32); }, /passkey-approved proposal/u],
  ['version', (tx: RpcTransaction) => { tx.version = 1; }, /version or locktime/u],
  ['input order', (tx: RpcTransaction) => { tx.vin.reverse(); }, /approved input/u],
  ['input sequence', (tx: RpcTransaction) => { tx.vin[0]!.sequence = 1; }, /approved input 0/u],
  ['output value', (tx: RpcTransaction) => { tx.vout[1]!.value += 0.00000001; }, /approved output 1/u],
  ['output script', (tx: RpcTransaction) => { tx.vout[1]!.scriptPubKey!.hex = `5120${'ff'.repeat(32)}`; }, /approved output 1/u],
] satisfies Array<[string, (transaction: RpcTransaction) => void, RegExp]>) {
  const changed = structuredClone(confirmedTransaction);
  mutate(changed);
  assert.throws(() => authorizeConfirmedFundingProposal(changed, proposal), expected, name);
}
checks.push({ name: 'activation accepts only the exact approved non-witness transaction, including input order and every output', ok: true });

const reordered = buildFundingProposal({
  artifact,
  commitments: [...commitments].reverse(),
  fundingFeeSats: DEFAULT_FUNDING_FEE_SATS,
});
assert.equal(reordered.digest, proposal.digest);
assert.equal(reordered.psbtBase64, proposal.psbtBase64);
checks.push({ name: 'arrival order cannot change participant input ordering or the proposal fingerprint', ok: true });

const aliceDigest = fundingInputCommitmentDigest(commitments[0]!);
assert.notEqual(aliceDigest, fundingInputCommitmentDigest({
  ...commitments[0]!,
  changeAddress: commitments[1]!.changeAddress,
}));
assert.notEqual(aliceDigest, fundingInputCommitmentDigest({ ...commitments[0]!, confirmations: 3 }));
checks.push({ name: 'passkey commitment binds the outpoint evidence, amount, fee, and change destination', ok: true });

rejects('a different roster digest', /different confirmed roster/u, {
  ...commitments[0]!, rosterDigest: '00'.repeat(32),
});
rejects('a legacy funding coin', /native P2WPKH or P2TR/u, {
  ...commitments[0]!, scriptPubKeyHex: `76a914${'11'.repeat(20)}88ac`,
});
rejects('an unconfirmed funding coin', /confirmed unspent/u, { ...commitments[0]!, confirmations: 0 });
rejects('an HTTP observation source', /HTTPS origin/u, {
  ...commitments[0]!, sourceOrigin: 'http://mempool.space',
});
rejects('dust-sized change', /unsafe 329 sat change/u, {
  ...commitments[0]!, valueSats: 10_529,
});
rejects('change back into the vault', /cannot reuse the committed vault/u, {
  ...commitments[0]!, changeAddress: artifact.funding.address,
});
rejects('a change address on an exact-value input', /must not add a change address/u, {
  ...commitments[0]!, valueSats: 10_200,
});

assert.throws(() => buildFundingProposal({
  artifact,
  commitments: commitments.slice(0, 2),
  fundingFeeSats: DEFAULT_FUNDING_FEE_SATS,
}), /one approved input from each/u);
assert.throws(() => buildFundingProposal({
  artifact,
  commitments: commitments.map((item, index) => index === 2
    ? { ...item, participantId: 'bob' }
    : item),
  fundingFeeSats: DEFAULT_FUNDING_FEE_SATS,
}), /repeats a participant/u);
assert.throws(() => buildFundingProposal({
  artifact,
  commitments: commitments.map((item, index) => index === 2
    ? { ...item, txid: commitments[0]!.txid, vout: commitments[0]!.vout }
    : item),
  fundingFeeSats: DEFAULT_FUNDING_FEE_SATS,
}), /repeats an outpoint/u);
assert.throws(() => buildFundingProposal({
  artifact,
  commitments: commitments.map((item, index) => index === 2
    ? { ...item, fundingFeeSats: DEFAULT_FUNDING_FEE_SATS + 1 }
    : item),
  fundingFeeSats: DEFAULT_FUNDING_FEE_SATS,
}), /different total fees/u);
checks.push({ name: 'proposal assembly rejects missing seats, duplicate people, duplicate coins, and fee drift', ok: true });

console.log(JSON.stringify({ passed: true, checks }, null, 2));

function rejects(name: string, expected: RegExp, commitment: FundingInputCommitment): void {
  assert.throws(() => validateFundingInputCommitment(artifact, commitment), expected);
  checks.push({ name, ok: true });
}

function liveRoster(): RosterEntry[] {
  return ids.map((id) => {
    const base = rosterEntry(id, `funding-${id}-secret-material-that-is-long-enough`, ids);
    const registrations = Object.fromEntries(participantLeaveRounds(id, ids).map((round) => {
      const xpub = syntheticMainnetXpub(`${id}:${round}`);
      const policyLeaf = deriveXpubChildPubkey(xpub, [0, 0]).xonlyPubKeyHex;
      const identificationLeaf = xpubRootXonly(xpub);
      return [round, {
        network: 'mainnet',
        keyId: `live-key:${id}:${round}`,
        keyIndex: participantLeaveRounds(id, ids).indexOf(round),
        bip328Xpub: xpub,
        policyLeafXonlyPubkey: policyLeaf,
        identificationLeafXonlyPubkey: identificationLeaf,
        policyRoot: sha256Hex(`policy-root:${id}:${round}`),
        policyId: `${round}:${id}`,
      } satisfies SigbashRosterRegistration];
    }));
    return {
      ...base,
      sigbashLeafByRound: Object.fromEntries(Object.entries(registrations)
        .map(([round, item]) => [round, item.policyLeafXonlyPubkey])),
      sigbashIdentificationLeafByRound: Object.fromEntries(Object.entries(registrations)
        .map(([round, item]) => [round, item.identificationLeafXonlyPubkey])),
      sigbashRegistrationByRound: registrations,
    };
  });
}

function syntheticMainnetXpub(label: string): string {
  const root = deterministicKeypair('funding-ceremony-acceptance', `${label}:root`);
  return base58CheckEncode(Buffer.concat([
    Buffer.from('0488b21e', 'hex'), Buffer.from([0]), Buffer.alloc(4), Buffer.alloc(4),
    Buffer.from(sha256Hex(`${label}:chain-code`), 'hex'), Buffer.from(root.publicKeyHex, 'hex'),
  ]));
}

function tinyEconomics(): VaultEconomics {
  return {
    depositSatsPerParticipant: asSats(10_000),
    firstWithdrawalSats: asSats(9_500),
    secondWithdrawalSats: asSats(10_250),
    soloFeeBudgetSats: asSats(2_000),
    soloWithdrawalFeeSats: asSats(300),
    cooperativeFeeSats: asSats(300),
    recoveryFeeSats: asSats(500),
    finalSweepFeeSats: asSats(300),
    recoveryDelayBlocks: 12,
  };
}
