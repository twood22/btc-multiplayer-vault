/** Public deterministic fixtures only. No chain, wallet or network operations. */
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { buildPresignedCashout, validatePresignedCashout, signPresignedCashout,
  authorizePresignedCashoutTransaction, type PresignedCashoutRequest } from './cashout.js';
import { createPresignedFixture, preauthorizePresignedFixture, authorizePresignedFixtureRecoveries } from './fixtures.js';
import { createPresignedPublicKit } from './backup.js';
import { payoutScript } from './roster.js';
import { buildPresignedSpend } from './spends.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type ParticipantId } from './types.js';
import { networkParameters } from './validation.js';

let signed = 0; let negativeControls = 0; const families = new Set<string>();
const rejects = (action: () => unknown) => { assert.throws(action); negativeControls++; };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]) for (const network of ['signet','mainnet'] as const) {
  const f = createPresignedFixture({ protocol, network });
  const publicKit = createPresignedPublicKit({ graph: f.graph, preauthorizations: preauthorizePresignedFixture(f),
    ...(protocol === PRESIGNED_PROTOCOL_V3 ? { recoveryAuthorizations: authorizePresignedFixtureRecoveries(f) } : {}) });
  const destination = bitcoin.address.fromOutputScript(Buffer.from(f.walletKeys.alice.scriptPubKeyHex, 'hex'), networkParameters(network));
  const requestFor = (parentTransactionHex: string, vout: number, participantId: ParticipantId): PresignedCashoutRequest => {
    const tx = bitcoin.Transaction.fromHex(parentTransactionHex); const output = tx.outs[vout]!;
    return { publicKit, participantId, parentTransactionHex, destinationAddress: destination, feeSats: 200, maxFeeSats: 1000,
      sourceObservation: { network, genesisHash: f.graph.roster.genesisHash, txid: tx.getId(), vout,
        valueSats: Number(output.value), scriptPubKeyHex: Buffer.from(output.script).toString('hex'),
        confirmationBlockHash: '44'.repeat(32), confirmations: 6, unspentInActiveChain: true, coinbase: false } };
  };
  const first = f.graph.exits.find(item => item.id === 'alice')!;
  const second = f.graph.exits.find(item => item.id === 'alice/bob')!;
  const cooperative = buildPresignedSpend({ graph: f.graph, proposalId: '44444444-4444-4444-8444-444444444444', kind: 'cooperative', sourceExitId: null });
  const recovery = buildPresignedSpend({ graph: f.graph, proposalId: '44444444-4444-4444-8444-444444444444', kind: 'recovery', sourceExitId: 'alice' });
  const finalSweep = buildPresignedSpend({ graph: f.graph, proposalId: '44444444-4444-4444-8444-444444444444', kind: 'final-sweep', sourceExitId: 'alice/bob' });
  // An ordinary independently observed payment to the same payout key does not
  // require graph ancestry; this also models a preserved CPFP payout output.
  const other = new bitcoin.Transaction(); other.version = 2;
  other.addInput(Buffer.alloc(32, 7), 1); other.addOutput(payoutScript(f.graph.roster, 'alice'), 5000n);
  const cases: Array<[string, string, number, ParticipantId]> = [
    ['solo-first', first.unsignedTxHex, 0, 'alice'], ['solo-second', second.unsignedTxHex, 0, 'bob'],
    ['final-owned', second.unsignedTxHex, 1, 'carol'], ['cooperative', cooperative.unsignedTxHex, 2, 'carol'],
    ['recovery', recovery.unsignedTxHex, 0, 'bob'], ['final-sweep', finalSweep.unsignedTxHex, 0, 'carol'],
    ['same-key-external-or-fee-child', other.toHex(), 0, 'alice'],
  ];
  for (const [family, parent, vout, owner] of cases) {
    const request = requestFor(parent, vout, owner); const cashout = buildPresignedCashout(request);
    const keys = { ...f.keysById[owner], payoutPrivateKey: Buffer.from(f.keysById[owner].payoutPrivateKey) };
    const completed = signPresignedCashout({ request, cashout, keys, approvedCashoutDigest: cashout.digest });
    assert(keys.payoutPrivateKey.every(byte => byte === 0));
    assert.equal(completed.txid, cashout.txid);
    assert.equal(bitcoin.Transaction.fromHex(completed.transactionHex).outs[0]!.value, BigInt(request.sourceObservation.valueSats - 200));
    assert.deepEqual(authorizePresignedCashoutTransaction({ request, cashout, transactionHex: completed.transactionHex }), completed);
    families.add(family); signed++;
  }
  const request = requestFor(first.unsignedTxHex, 0, 'alice'); const cashout = buildPresignedCashout(request);
  const complete = signPresignedCashout({ request, cashout, keys: { ...f.keysById.alice,
    payoutPrivateKey: Buffer.from(f.keysById.alice.payoutPrivateKey) }, approvedCashoutDigest: cashout.digest });
  const point = f.walletKeys.alice.publicKey;
  const scriptHash = bitcoin.payments.p2wpkh({ pubkey: point, network: networkParameters(network) });
  const addresses = [bitcoin.payments.p2pkh({ pubkey: point, network: networkParameters(network) }).address!,
    bitcoin.payments.p2sh({ redeem: scriptHash, network: networkParameters(network) }).address!, scriptHash.address!,
    bitcoin.payments.p2wsh({ redeem: { output: bitcoin.script.compile([point, bitcoin.opcodes.OP_CHECKSIG]) }, network: networkParameters(network) }).address!, destination];
  for (const address of addresses) {
    const candidate = { ...request, destinationAddress: address }; const built = buildPresignedCashout(candidate);
    signPresignedCashout({ request: candidate, cashout: built, keys: { ...f.keysById.alice,
      payoutPrivateKey: Buffer.from(f.keysById.alice.payoutPrivateKey) }, approvedCashoutDigest: built.digest }); signed++;
  }
  const requestChanges: Array<(r: PresignedCashoutRequest) => void> = [
    r => { r.participantId = 'bob'; }, r => { r.sourceObservation.txid = '99'.repeat(32); },
    r => { r.sourceObservation.vout = 1; }, r => { r.sourceObservation.valueSats++; },
    r => { r.sourceObservation.scriptPubKeyHex = payoutScript(f.graph.roster, 'bob').toString('hex'); },
    r => { r.sourceObservation.confirmations = 0; }, r => { r.sourceObservation.confirmationBlockHash = '00'.repeat(32); },
    r => { (r.sourceObservation as any).unspentInActiveChain = false; }, r => { (r.sourceObservation as any).coinbase = true; },
    r => { r.sourceObservation.genesisHash = '99'.repeat(32); }, r => { r.sourceObservation.network = network === 'mainnet' ? 'signet' : 'mainnet'; },
    r => { r.feeSats = 0; }, r => { r.feeSats = 1; }, r => { r.feeSats = r.maxFeeSats + 1; },
    r => { r.maxFeeSats = f.graph.roster.feePolicy.maxChildFeeSats + 1; },
    r => { r.maxFeeSats = 10000; r.feeSats = r.sourceObservation.valueSats - 545; },
    r => { r.destinationAddress += ' '; }, r => { r.destinationAddress = 'not-an-address'; },
    r => { r.destinationAddress = destination.toUpperCase(); },
    r => { r.destinationAddress = bitcoin.address.fromOutputScript(Buffer.from(f.walletKeys.alice.scriptPubKeyHex, 'hex'), networkParameters(network === 'mainnet' ? 'signet' : 'mainnet')); },
    r => { r.destinationAddress = f.graph.rounds[0]!.address; },
    r => { r.parentTransactionHex += '00'; }, r => { (r as any).extra = true; },
    r => { r.publicKit.protocol = protocol === PRESIGNED_PROTOCOL ? PRESIGNED_PROTOCOL_V3 : PRESIGNED_PROTOCOL; },
    r => { r.publicKit.version = protocol === PRESIGNED_PROTOCOL ? 3 : 2; },
  ];
  for (const change of requestChanges) { const altered = clone(request); change(altered); rejects(() => buildPresignedCashout(altered)); }
  rejects(() => buildPresignedCashout(requestFor(f.graph.fundingUnsignedTxHex, 0, 'alice')));
  for (const field of ['feeSats','payoutSats','maxFeeSats','vsize','version'] as const)
    rejects(() => validatePresignedCashout({ request, cashout: { ...cashout, [field]: cashout[field] + 1 } }));
  for (const field of ['digest','signatureHash','unsignedTxHex','psbtBase64','destinationAddress','protocol','graphDigest'] as const)
    rejects(() => validatePresignedCashout({ request, cashout: { ...cashout, [field]: `${cashout[field]}00` } }));
  for (const [wrongOwner, approvedCashoutDigest] of [['bob', cashout.digest], ['alice', '99'.repeat(32)]] as const) {
    const keys = { ...f.keysById[wrongOwner], payoutPrivateKey: Buffer.from(f.keysById[wrongOwner].payoutPrivateKey) };
    rejects(() => signPresignedCashout({ request, cashout, keys, approvedCashoutDigest }));
    assert(keys.payoutPrivateKey.every(byte => byte === 0));
  }
  const wrongKey = { ...f.keysById.alice, payoutPrivateKey: Buffer.from(f.keysById.bob.payoutPrivateKey) };
  rejects(() => signPresignedCashout({ request, cashout, keys: wrongKey, approvedCashoutDigest: cashout.digest }));
  assert(wrongKey.payoutPrivateKey.every(byte => byte === 0));
  const mutations: Array<(t: bitcoin.Transaction) => void> = [
    t => { t.version = 3; }, t => { t.locktime = 1; }, t => { t.ins[0]!.sequence = 0xffffffff; },
    t => { t.ins[0]!.hash = Buffer.alloc(32, 4); }, t => { t.ins[0]!.index++; }, t => { t.outs[0]!.value--; },
    t => { t.outs[0]!.script = payoutScript(f.graph.roster, 'bob'); }, t => { t.addOutput(t.outs[0]!.script, 546n); },
    t => { t.ins.push(t.ins[0]!); }, t => { t.ins[0]!.witness = []; },
    t => { t.ins[0]!.witness[0] = Buffer.alloc(64); },
    t => { t.ins[0]!.witness[0] = Buffer.concat([Buffer.from(t.ins[0]!.witness[0]!), Buffer.from([1])]); },
    t => { t.ins[0]!.witness.push(Buffer.from('5001', 'hex')); },
  ];
  for (const mutate of mutations) { const tx = bitcoin.Transaction.fromHex(complete.transactionHex); mutate(tx);
    rejects(() => authorizePresignedCashoutTransaction({ request, cashout, transactionHex: tx.toHex() })); }
  const changedFeeRequest = { ...request, feeSats: request.feeSats + 1 };
  rejects(() => authorizePresignedCashoutTransaction({ request: changedFeeRequest, cashout: buildPresignedCashout(changedFeeRequest), transactionHex: complete.transactionHex }));
  const changedAddressRequest = { ...request, destinationAddress: addresses[0]! };
  rejects(() => authorizePresignedCashoutTransaction({ request: changedAddressRequest, cashout: buildPresignedCashout(changedAddressRequest), transactionHex: complete.transactionHex }));
}
console.log(JSON.stringify({ passed: true, suite: 'owned-payout-cashout', protocols: [PRESIGNED_PROTOCOL,PRESIGNED_PROTOCOL_V3],
  networkFormats: ['signet','mainnet'], signedCashouts: signed, payoutFamilies: [...families], destinationTypes: 5, negativeControls,
  callerPayoutKeyZeroized: true, actualChainVerified: false, publicNetworkBroadcasts: 0, mainnetAuthorized: false }));
