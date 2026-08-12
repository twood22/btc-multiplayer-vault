import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import {
  assertAuthorizedBroadcaster,
  assertExactBroadcastTransaction,
  confirmedBlockHeight,
} from '../../src/broadcast-lifecycle.js';

const checks: Array<{ name: string; ok: boolean }> = [];
const transaction = new bitcoin.Transaction();
transaction.version = 2;
transaction.addInput(Buffer.alloc(32, 1), 0, 0xfffffffd);
transaction.addOutput(Buffer.from(`5120${'02'.repeat(32)}`, 'hex'), 9_000n);
const transactionHex = transaction.toHex();
const txid = transaction.getId();

check('solo and final-sweep broadcasts require the payout owner', () => {
  assert.doesNotThrow(() => assertAuthorizedBroadcaster({
    kind: 'solo',
    actorParticipantId: 'alice',
    requiredSignerIds: ['alice'],
    participantId: 'alice',
    contributionKinds: [],
  }));
  assert.throws(() => assertAuthorizedBroadcaster({
    kind: 'final_sweep',
    actorParticipantId: 'alice',
    requiredSignerIds: ['alice', 'bob'],
    participantId: 'bob',
    contributionKinds: [],
  }), /only the payout owner/);
});

check('cooperative and recovery broadcasters must have contributed their verified signature', () => {
  assert.throws(() => assertAuthorizedBroadcaster({
    kind: 'cooperative',
    actorParticipantId: null,
    requiredSignerIds: ['alice', 'bob'],
    participantId: 'alice',
    contributionKinds: [],
  }), /must contribute/);
  assert.doesNotThrow(() => assertAuthorizedBroadcaster({
    kind: 'cooperative',
    actorParticipantId: null,
    requiredSignerIds: ['alice', 'bob'],
    participantId: 'alice',
    contributionKinds: ['musig_partial'],
  }));
  assert.doesNotThrow(() => assertAuthorizedBroadcaster({
    kind: 'recovery',
    actorParticipantId: 'carol',
    requiredSignerIds: ['alice', 'bob'],
    participantId: 'bob',
    contributionKinds: ['recovery_share'],
  }));
});

check('broadcast and watcher accept only the exact finalized bytes and transaction id', () => {
  assert.doesNotThrow(() => assertExactBroadcastTransaction({
    finalizedTxHex: transactionHex,
    finalTxid: txid,
    observedTxid: txid,
    observedTxHex: transactionHex,
  }));
  assert.throws(() => assertExactBroadcastTransaction({
    finalizedTxHex: transactionHex,
    finalTxid: txid,
    observedTxid: '03'.repeat(32),
  }), /different transaction id/);
  assert.throws(() => assertExactBroadcastTransaction({
    finalizedTxHex: transactionHex,
    finalTxid: txid,
    observedTxid: txid,
    observedTxHex: `${transactionHex}00`,
  }), /different transaction bytes/);
});

check('watcher advances only confirmed transactions with an exact block height', () => {
  assert.equal(confirmedBlockHeight({ confirmations: 0 }), null);
  assert.equal(confirmedBlockHeight({ confirmations: 2, blockheight: 850_000 }), 850_000);
  assert.throws(() => confirmedBlockHeight({ confirmations: 1 }), /valid block height/);
});

console.log(JSON.stringify({ passed: checks.every((item) => item.ok), checks }, null, 2));

function check(name: string, run: () => void): void {
  run();
  checks.push({ name, ok: true });
}
