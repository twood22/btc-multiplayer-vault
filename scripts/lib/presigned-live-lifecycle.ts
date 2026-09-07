/** Resumable acceptance orchestration. Never imports deterministic test keys. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, existsSync, fstatSync, fsyncSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import { asSats } from '../../src/types.js';
import { encryptPresignedOfflineBackup, parsePresignedOfflineBackup, presignedBackupBinding,
  serializePresignedOfflineBackup, validatePresignedPublicKit, verifyPresignedOfflineBackupRestoration,
  withRestoredPresignedOfflineBackup } from '../../src/presigned/backup.js';
import { authorizePresignedFundingSignedPsbt, authorizePresignedFundingTransaction, finalizePresignedFunding } from '../../src/presigned/funding.js';
import { buildPresignedGraph } from '../../src/presigned/graph.js';
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys } from '../../src/presigned/roster.js';
import { authorizePresignedExitTransaction, completePresignedExit, createPreauthorizations } from '../../src/presigned/signing.js';
import { authorizePresignedSpendTransaction, buildPresignedSpend, createPresignedCooperativeNonce, createPresignedRecoveryContribution,
  finalizePresignedCooperative, finalizePresignedRecovery, signPresignedCooperativePartial,
  signPresignedFinalSweep, type PresignedSpendProposal } from '../../src/presigned/spends.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedParticipantKeys,
  type PresignedPublicKit, type PresignedRoster } from '../../src/presigned/types.js';
import { commitmentDigest, genesisHash } from '../../src/presigned/validation.js';
import { nativeWalletWitnessFromPsbt } from '../../src/presigned/wallet.js';
import { signPresignedFeePayout, type FeeCoinObservation } from '../../src/presigned/fees.js';
import { buildPresignedFeeDraft, validatePresignedFeePackage, type PresignedFeeDraft, type PresignedFeePackage } from '../../src/presigned/fee-package.js';
import { authorizePresignedFundingFeeWalletPsbt } from '../../src/presigned/funding-fees.js';
import { signPresignedSpendFeePayout } from '../../src/presigned/spend-fees.js';
import { validatePresignedRestorationReceipt } from '../../src/presigned/ceremony.js';

export interface LiveLifecycleCore {
  rpc(method: string, params?: unknown[]): Promise<any>;
  walletRpc(method: string, params?: unknown[]): Promise<any>;
  observeCoin(outpoint: { txid: string; vout: number }): Promise<FeeCoinObservation>;
  chain: 'default-Signet' | 'isolated-regtest';
  actualGenesisHash: string;
  sourceDigest: string;
}
interface CasePlan {
  id: string; kind: 'solo-order' | 'cooperative' | 'recovery'; source: string | null;
  omitted: ParticipantId | null; first: ParticipantId | null; second: ParticipantId | null;
  inputs: Array<{ participantId: ParticipantId; address: string; scriptPubKeyHex: string; valueSats: number }>;
}
interface Run {
  version: 2; protocol: typeof PRESIGNED_PROTOCOL; chain: LiveLifecycleCore['chain']; actualGenesisHash: string;
  sourceDigest: string; createdAt: string; freshRandomParticipantKeys: true; externalWalletKeysExported: false;
  requiredTestSatsBeforeFanoutFee: number; cases: CasePlan[];
  sponsors: Array<{ family: string; address: string; scriptPubKeyHex: string; valueSats: number }>;
}
interface Signed {
  transactionHex: string; txid: string;
  proposal?: PresignedSpendProposal;
}
interface Confirmed { txid: string; blockHash: string; height: number; confirmations: number }

function lifecycleCaseDefinitions(): Array<Omit<CasePlan, 'inputs'>> {
  const cases: Array<Omit<CasePlan, 'inputs'>> = [];
  const add = (value: Omit<CasePlan, 'id' | 'inputs'>) => cases.push({ id: `case-${String(cases.length).padStart(2, '0')}`, ...value });
  for (const first of PARTICIPANT_IDS) for (const second of PARTICIPANT_IDS.filter(id => id !== first))
    add({ kind: 'solo-order', source: `${first}/${second}`, first, second, omitted: null });
  for (const source of [null, ...PARTICIPANT_IDS]) add({ kind: 'cooperative', source, first: null, second: null, omitted: null });
  for (const source of [null, ...PARTICIPANT_IDS]) for (const omitted of PARTICIPANT_IDS.filter(id => id !== source))
    add({ kind: 'recovery', source, first: null, second: null, omitted });
  return cases;
}

/** Owner-only durable files. Caller chooses a newly created private directory. */
export function saveLifecycleFile(directory: string, name: string, value: unknown) {
  assert(/^[a-zA-Z0-9_.\/-]+$/u.test(name) && !name.split('/').includes('..'));
  const filename = `${directory}/${name}`;
  const temporary = `${filename}.partial-${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  // Publish only complete, fsynced bytes, without overwriting a competing or
  // earlier commit. Interrupted temporary files remain private and recoverable.
  linkSync(temporary, filename); unlinkSync(temporary);
  const parent = openSync(filename.slice(0, filename.lastIndexOf('/')), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function readLifecycleFile<T>(directory: string, name: string): T {
  assert(/^[a-zA-Z0-9_.\/-]+$/u.test(name) && !name.split('/').includes('..'));
  const fd = openSync(`${directory}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(fd);
    assert(metadata.isFile() && metadata.uid === process.getuid?.() && (metadata.mode & 0o077) === 0 && metadata.size <= 4_000_000,
      'lifecycle evidence must be a bounded owner-only regular file');
    try { return JSON.parse(readFileSync(fd, 'utf8')) as T; }
    catch { throw new Error('lifecycle file is not valid JSON; private contents redacted'); }
  } finally { closeSync(fd); }
}
const has = (directory: string, name: string) => existsSync(`${directory}/${name}`);
const encodedWitness = (items: Buffer[]) => {
  assert(items.length <= 2 && items.every(item => item.length <= 73));
  return Buffer.concat([Buffer.from([items.length]), ...items.flatMap(item => [Buffer.from([item.length]), item])]);
};
function runFor(core: LiveLifecycleCore, directory: string): Run {
  const run = readLifecycleFile<Run>(directory, 'run.json');
  assert(run.version === 2 && run.protocol === PRESIGNED_PROTOCOL && run.chain === core.chain &&
    run.actualGenesisHash === core.actualGenesisHash && run.sourceDigest === core.sourceDigest &&
    run.cases.length === 19 && run.freshRandomParticipantKeys === true && run.externalWalletKeysExported === false,
  'lifecycle run identity changed; retain its state and do not reinterpret it');
  assert.deepEqual(run.cases.map(({ inputs: _inputs, ...definition }) => definition), lifecycleCaseDefinitions(),
    'lifecycle cases omit, duplicate or substitute a required ordering or signer subset');
  assert.deepEqual(run.sponsors.map(item => item.family), ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep']);
  return run;
}
async function walletTarget(core: LiveLifecycleCore, index: number, valueSats: number) {
  const address = await core.walletRpc('getnewaddress', ['presigned-v2-isolated-lifecycle', index % 2 ? 'bech32' : 'bech32m']);
  const info = await core.walletRpc('getaddressinfo', [address]);
  assert(info.ismine === true && typeof info.scriptPubKey === 'string');
  return { address, scriptPubKeyHex: info.scriptPubKey, valueSats };
}
export async function initializeLiveLifecycle(core: LiveLifecycleCore, directory: string) {
  assert(!has(directory, 'run.json'), 'lifecycle already initialized');
  for (const name of ['cases', 'keys', 'events', 'interrupted']) mkdirSync(`${directory}/${name}`, { mode: 0o700 });
  const cases: CasePlan[] = lifecycleCaseDefinitions().map(definition => ({ ...definition, inputs: [] }));
  let index = 0;
  for (const item of cases) for (const participantId of PARTICIPANT_IDS)
    item.inputs.push({ participantId, ...await walletTarget(core, index++, 12_000) });
  const sponsors: Run['sponsors'] = [];
  for (const family of ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep'])
    sponsors.push({ family, ...await walletTarget(core, index++, 20_000) });
  const run: Run = { version: 2, protocol: PRESIGNED_PROTOCOL, chain: core.chain, actualGenesisHash: core.actualGenesisHash,
    sourceDigest: core.sourceDigest, createdAt: new Date().toISOString(), freshRandomParticipantKeys: true,
    externalWalletKeysExported: false, requiredTestSatsBeforeFanoutFee: 784_000, cases, sponsors };
  saveLifecycleFile(directory, 'run.json', run);
  return { initialized: true, chain: core.chain, cases: cases.length, requiredTestSatsBeforeFanoutFee: 784_000 };
}
async function event(core: LiveLifecycleCore, directory: string, value: Record<string, unknown>) {
  saveLifecycleFile(directory, `events/${Date.now()}-${randomUUID()}.json`, {
    ...value, observedAt: new Date().toISOString(), tip: (await core.rpc('getblockchaininfo')).bestblockhash });
}
async function confirmed(core: LiveLifecycleCore, signed: Signed): Promise<Confirmed | null> {
  let raw: any;
  try { raw = await core.rpc('getrawtransaction', [signed.txid, true]); }
  catch (error) { if ((error as { code?: number }).code === -5) return null; throw error; }
  const actual = bitcoin.Transaction.fromHex(raw.hex);
  const expected = bitcoin.Transaction.fromHex(signed.transactionHex);
  for (const input of actual.ins) input.witness = [];
  for (const input of expected.ins) input.witness = [];
  assert.equal(actual.toHex(), expected.toHex(), 'observed non-witness bytes changed');
  if (!raw.blockhash || !(raw.confirmations > 0)) return null;
  const anchor = await core.rpc('getblockheader', [raw.blockhash]);
  assert(anchor.confirmations > 0 && await core.rpc('getblockhash', [anchor.height]) === raw.blockhash, 'transaction anchor is not active');
  return { txid: signed.txid, blockHash: raw.blockhash, height: anchor.height, confirmations: anchor.confirmations };
}
async function submitExact(core: LiveLifecycleCore, directory: string, label: string, signed: Signed) {
  if (await confirmed(core, signed)) return 'confirmed';
  try { await core.rpc('getmempoolentry', [signed.txid]); return 'pending'; }
  catch (error) { if ((error as { code?: number }).code !== -5) throw error; }
  const result = await core.rpc('testmempoolaccept', [[signed.transactionHex]]);
  assert(result.length === 1 && result[0].txid === signed.txid);
  if (result[0].allowed !== true) {
    await event(core, directory, { label, kind: 'policy-rejected', txid: signed.txid, reason: result[0]['reject-reason'] ?? null });
    return 'policy-rejected';
  }
  // Write intent first. A lost response is reconciled by exact txid before any
  // resend, and never causes a newly signed replacement of this graph node.
  await event(core, directory, { label, kind: 'submit-intent', txid: signed.txid });
  try { assert.equal(await core.rpc('sendrawtransaction', [signed.transactionHex]), signed.txid); }
  catch (error) {
    // Unknown transport outcome remains unknown, not permission to recreate.
    await event(core, directory, { label, kind: 'submit-outcome-unknown', txid: signed.txid });
    throw error;
  }
  await event(core, directory, { label, kind: 'accepted', txid: signed.txid });
  return 'submitted';
}
export async function fundLiveLifecycle(core: LiveLifecycleCore, directory: string) {
  const run = runFor(core, directory);
  if (!has(directory, 'fanout.json')) {
    const balances = await core.walletRpc('getbalances');
    assert(Math.round(balances.mine.trusted * 1e8) >= 800_000, 'isolated test wallet needs at least 800000 confirmed test satoshis');
    const targets = [...run.cases.flatMap(item => item.inputs), ...run.sponsors];
    const outputs = targets.map(target => ({ [target.address]: target.valueSats / 1e8 }));
    const funded = await core.walletRpc('walletcreatefundedpsbt', [[], outputs, 0,
      { fee_rate: 2, replaceable: false, lockUnspents: true, subtractFeeFromOutputs: [] }, true]);
    assert(Math.round(funded.fee * 1e8) > 0 && Math.round(funded.fee * 1e8) <= 16_000, 'fanout fee exceeds isolated test cap');
    const signed = await core.walletRpc('walletprocesspsbt', [funded.psbt, true, 'ALL', true, true]);
    const final = await core.rpc('finalizepsbt', [signed.psbt]);
    assert.equal(final.complete, true);
    const transaction = bitcoin.Transaction.fromHex(final.hex);
    assert(targets.every(target => transaction.outs.filter(output =>
      output.value === BigInt(target.valueSats) && Buffer.from(output.script).toString('hex') === target.scriptPubKeyHex).length === 1),
    'fanout changed a reserved lifecycle output');
    saveLifecycleFile(directory, 'fanout.json', { transactionHex: final.hex, txid: transaction.getId(), feeSats: Math.round(funded.fee * 1e8) });
  }
  return { fanout: await submitExact(core, directory, 'fanout', readLifecycleFile<Signed>(directory, 'fanout.json')) };
}
async function withKeys<T>(directory: string, caseId: string, id: ParticipantId, action: (keys: PresignedParticipantKeys) => Promise<T> | T): Promise<T> {
  const kit = validatePresignedPublicKit(readLifecycleFile<PresignedPublicKit>(directory, `cases/${caseId}/kit.json`));
  const envelope = parsePresignedOfflineBackup(JSON.stringify(readLifecycleFile(directory, `cases/${caseId}/${id}.encrypted.json`)));
  const wrapping = readLifecycleFile<{ secret: string }>(directory, `keys/${caseId}-${id}.json`);
  const offlineSecret = Uint8Array.from(Buffer.from(wrapping.secret, 'base64url')); wrapping.secret = '';
  try {
    return await withRestoredPresignedOfflineBackup({ envelope, offlineSecret, expectedBinding: presignedBackupBinding(kit, id), action: async restored => {
      const derived = derivePresignedParticipantKeys(restored.participantSecret, id, kit.graph.roster.vaultId);
      try { return await action(derived.keys); } finally { clearPresignedParticipantKeys(derived.keys); }
    } });
  } finally { offlineSecret.fill(0); }
}
async function prepareCase(core: LiveLifecycleCore, directory: string, plan: CasePlan, fanout: Signed) {
  assert(/^case-[0-9]{2}$/u.test(plan.id));
  const casePath = `cases/${plan.id}`;
  if (!has(directory, `${casePath}/kit.json`)) {
    if (has(directory, casePath)) {
      assert(!has(directory, `${casePath}/wallet-signing-intent.json`) && !has(directory, `${casePath}/funding.json`),
        'funding may have been signed; never replace its missing recovery material');
      const archive = `interrupted/${plan.id}-${randomUUID()}`;
      mkdirSync(`${directory}/${archive}`, { mode: 0o700 });
      renameSync(`${directory}/${casePath}`, `${directory}/${archive}/case`);
      for (const id of PARTICIPANT_IDS) if (has(directory, `keys/${plan.id}-${id}.json`))
        renameSync(`${directory}/keys/${plan.id}-${id}.json`, `${directory}/${archive}/${id}-wrapping-key.json`);
      await event(core, directory, { kind: 'uncommitted-case-retained', case: plan.id, archive, fundingSignaturesReleased: false });
    }
    mkdirSync(`${directory}/${casePath}`, { mode: 0o700 });
    const vaultId = randomUUID(); const secrets = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomBytes(32).toString('base64url')])) as Record<ParticipantId, string>;
    const derived = PARTICIPANT_IDS.map(id => derivePresignedParticipantKeys(secrets[id], id, vaultId));
    try {
      const roster: PresignedRoster = { version: 2, protocol: PRESIGNED_PROTOCOL, vaultId, network: 'signet', genesisHash: genesisHash('signet'),
        economics: { depositSatsPerParticipant: asSats(10_000), firstWithdrawalSats: asSats(9500), secondWithdrawalSats: asSats(10_250),
          soloWithdrawalFeeSats: asSats(300), soloFeeBudgetSats: asSats(2000), cooperativeFeeSats: asSats(300), recoveryFeeSats: asSats(500),
          finalSweepFeeSats: asSats(300), recoveryDelayBlocks: 12 },
        feePolicy: { kind: 'confirmed-truc-payout-cpfp-v1', maxChildFeeSats: 10_000 }, participants: derived.map(item => item.publicIdentity) };
      const transaction = bitcoin.Transaction.fromHex(fanout.transactionHex);
      const inputs = [];
      for (const target of plan.inputs) {
        const vout = transaction.outs.findIndex(output => Buffer.from(output.script).toString('hex') === target.scriptPubKeyHex);
        assert(vout >= 0);
        const observation = await core.observeCoin({ txid: fanout.txid, vout });
        assert(observation.valueSats === target.valueSats && observation.scriptPubKeyHex === target.scriptPubKeyHex);
        inputs.push({ participantId: target.participantId, txid: fanout.txid, vout, valueSats: observation.valueSats,
          scriptPubKeyHex: observation.scriptPubKeyHex, changeScriptPubKeyHex: observation.scriptPubKeyHex,
          confirmationBlockHash: observation.confirmationBlockHash, confirmations: observation.confirmations });
      }
      const graph = buildPresignedGraph({ roster, funding: { epochId: randomUUID(), feeSats: 600, inputs } });
      const kit: PresignedPublicKit = { version: 2, protocol: PRESIGNED_PROTOCOL, graph,
        preauthorizations: derived.flatMap(item => createPreauthorizations({ graph, participantId: item.publicIdentity.id,
          privateKeys: item.keys.soloPrivateKeys, approvedGraphDigest: graph.digest })) };
      // Store all complete encrypted kits and separate wrapping material before
      // the commit marker and before calling any external wallet signing RPC.
      for (const id of PARTICIPANT_IDS) {
        const offlineSecret = Uint8Array.from(randomBytes(32));
        try {
          const envelope = await encryptPresignedOfflineBackup({ publicKit: kit, participantId: id, participantSecret: secrets[id], offlineSecret });
          saveLifecycleFile(directory, `${casePath}/${id}.encrypted.json`, JSON.parse(serializePresignedOfflineBackup(envelope)));
          saveLifecycleFile(directory, `keys/${plan.id}-${id}.json`, { secret: Buffer.from(offlineSecret).toString('base64url') });
        } finally { offlineSecret.fill(0); }
      }
      saveLifecycleFile(directory, `${casePath}/kit.json`, kit);
    } finally {
      for (const item of derived) clearPresignedParticipantKeys(item.keys);
      for (const id of PARTICIPANT_IDS) secrets[id] = '';
    }
  }
  const kit = validatePresignedPublicKit(readLifecycleFile<PresignedPublicKit>(directory, `${casePath}/kit.json`));
  if (!has(directory, `${casePath}/backup-receipts.json`)) {
    const proofs = [];
    for (const id of PARTICIPANT_IDS) {
      const envelope = parsePresignedOfflineBackup(JSON.stringify(readLifecycleFile(directory, `${casePath}/${id}.encrypted.json`)));
      const key = readLifecycleFile<{ secret: string }>(directory, `keys/${plan.id}-${id}.json`);
      const offlineSecret = Uint8Array.from(Buffer.from(key.secret, 'base64url')); key.secret = '';
      try { proofs.push(await verifyPresignedOfflineBackupRestoration({ envelope, offlineSecret, expectedBinding: presignedBackupBinding(kit, id) })); }
      finally { offlineSecret.fill(0); }
    }
    assert(proofs.length === 3 && proofs.every(proof => proof.exitProofs.length === 3));
    saveLifecycleFile(directory, `${casePath}/backup-receipts.json`, { restoredBeforeWalletSigning: true, proofs });
  }
  if (!has(directory, `${casePath}/funding.json`)) {
    // On restart, restore each saved file again. A receipt alone cannot prove
    // the currently present files still decrypt to the exact reviewed graph.
    for (const id of PARTICIPANT_IDS) await withKeys(directory, plan.id, id, () => undefined);
    for (const input of kit.graph.funding.inputs) {
      const observed = await core.observeCoin(input);
      assert(observed.valueSats === input.valueSats && observed.scriptPubKeyHex === input.scriptPubKeyHex);
      assert(await core.rpc('gettxout', [input.txid, input.vout, true]), 'a pending conflict spent a reserved funding input');
    }
    if (!has(directory, `${casePath}/wallet-signing-intent.json`)) saveLifecycleFile(directory, `${casePath}/wallet-signing-intent.json`, {
      graphDigest: kit.graph.digest, fundingTxid: kit.graph.fundingTxid, backupsVerified: true });
    const response = await core.walletRpc('walletprocesspsbt', [kit.graph.fundingPsbtBase64, true, 'ALL', true, false]);
    const signed = bitcoin.Psbt.fromBase64(response.psbt);
    const signatures = PARTICIPANT_IDS.map((id, index) => {
      const single = bitcoin.Psbt.fromBase64(kit.graph.fundingPsbtBase64);
      single.updateInput(index, { finalScriptWitness: encodedWitness(nativeWalletWitnessFromPsbt(signed.data.inputs[index]!)) });
      return authorizePresignedFundingSignedPsbt({ graph: kit.graph, participantId: id, approvedGraphDigest: kit.graph.digest, signedPsbtBase64: single.toBase64() });
    });
    saveLifecycleFile(directory, `${casePath}/funding.json`, finalizePresignedFunding({ graph: kit.graph, signatures }));
  }
  return kit;
}
async function signedStep(directory: string, plan: CasePlan, kit: PresignedPublicKit, step: string): Promise<Signed> {
  const filename = `cases/${plan.id}/step-${step.replace('/', '-')}.json`;
  if (has(directory, filename)) return readLifecycleFile<Signed>(directory, filename);
  const graph = kit.graph; let signed: Signed;
  if (step !== 'terminal') {
    const exit = graph.exits.find(item => item.id === step); assert(exit);
    signed = await withKeys(directory, plan.id, exit.leaver, keys => completePresignedExit({ graph,
      preauthorizations: kit.preauthorizations, exitId: step, participantId: exit.leaver,
      privateKey: keys.soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest }));
  } else {
    const proposal = buildPresignedSpend({ graph, proposalId: randomUUID(), kind: plan.kind === 'solo-order' ? 'final-sweep' : plan.kind,
      sourceExitId: plan.source });
    if (proposal.kind === 'final-sweep') signed = await withKeys(directory, plan.id, proposal.source.owner!, keys =>
      signPresignedFinalSweep({ graph, proposal, participantId: proposal.source.owner!, payoutPrivateKey: keys.payoutPrivateKey, approvedProposalDigest: proposal.digest }));
    else if (proposal.kind === 'recovery') {
      const contributions = [];
      for (const id of proposal.participantIds.filter(id => id !== plan.omitted)) contributions.push(await withKeys(directory, plan.id, id, keys =>
        createPresignedRecoveryContribution({ graph, proposal, participantId: id, personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: proposal.digest })));
      signed = finalizePresignedRecovery({ graph, proposal, contributions });
    } else {
      // Secret nonces live only in this process, never in resumable state. If
      // interrupted before the final file, restart every participant with fresh
      // nonces and a new proposal ID; the payment's unsigned txid is unchanged.
      const nonces = [];
      try {
        for (const id of proposal.participantIds) nonces.push(await withKeys(directory, plan.id, id, keys =>
          createPresignedCooperativeNonce({ graph, proposal, participantId: id, personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: proposal.digest })));
        const publicNonces = nonces.map(item => item.publicNonce); const partials = [];
        for (const item of nonces) partials.push(await withKeys(directory, plan.id, item.publicNonce.participantId, keys =>
          signPresignedCooperativePartial({ graph, proposal, participantId: item.publicNonce.participantId,
            personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: proposal.digest,
            publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce })));
        signed = finalizePresignedCooperative({ graph, proposal, publicNonces, partials });
      } finally { for (const item of nonces) item.secretNonce.fill(0); }
    }
    signed = { ...signed, proposal };
  }
  saveLifecycleFile(directory, filename, signed);
  return signed;
}
async function hostileChecks(core: LiveLifecycleCore, directory: string, plan: CasePlan, step: string, signed: Signed) {
  const filename = `cases/${plan.id}/negative-${step.replace('/', '-')}.json`;
  if (has(directory, filename)) return;
  const negatives = [];
  for (const mutation of ['missing-signature', 'changed-payout']) {
    const changed = bitcoin.Transaction.fromHex(signed.transactionHex);
    if (mutation === 'missing-signature') {
      const position = changed.ins[0]!.witness.findIndex(item => item.length === 64 || item.length === 65);
      assert(position >= 0); changed.ins[0]!.witness[position] = Buffer.alloc(0);
    } else changed.outs[0]!.value -= 1n;
    const response = await core.rpc('testmempoolaccept', [[changed.toHex()]]);
    assert.equal(response[0].allowed, false, 'hostile lifecycle transaction unexpectedly accepted');
    negatives.push({ mutation, rejected: true, reason: response[0]['reject-reason'] ?? null });
  }
  saveLifecycleFile(directory, filename, { txid: signed.txid, negatives });
}
function feeFamily(plan: CasePlan, step: string) {
  if (plan.id === 'case-00') return step === 'funding' ? 'funding' : step === 'alice' ? 'solo' : step === 'terminal' ? 'final-sweep' : null;
  if (plan.id === 'case-06' && step === 'terminal') return 'cooperative';
  if (plan.id === 'case-10' && step === 'terminal') return 'recovery';
  return null;
}
interface FeePair { family: string; initial: PresignedFeePackage; replacement: PresignedFeePackage }
function checkedFeePair(directory: string, plan: CasePlan, family: string) {
  const pair = readLifecycleFile<FeePair>(directory, `cases/${plan.id}/fee-${family}.json`);
  assert.equal(pair.family, family);
  const initial = validatePresignedFeePackage(pair.initial); const replacement = validatePresignedFeePackage(pair.replacement);
  assert(initial.parentTransactionHex === replacement.parentTransactionHex &&
    replacement.package.request.approval.replacement?.previousChildTransactionHex === initial.completed.transactionHex &&
    initial.completed.childFeeSats === 3000 && replacement.completed.childFeeSats === 4000,
  'saved fee pair changed its parent or exact approved child replacement');
  return { initial, replacement };
}
async function saveFeePair(core: LiveLifecycleCore, directory: string, run: Run, plan: CasePlan, step: string,
  kit: PresignedPublicKit, parent: Signed) {
  const family = feeFamily(plan, step); if (!family) return null;
  if (!has(directory, `cases/${plan.id}/fee-${family}.json`)) {
    const graph = kit.graph; const target = run.sponsors.find(item => item.family === family)!;
    const fanout = readLifecycleFile<Signed>(directory, 'fanout.json');
    const fanoutTx = bitcoin.Transaction.fromHex(fanout.transactionHex);
    const vout = fanoutTx.outs.findIndex(output => Buffer.from(output.script).toString('hex') === target.scriptPubKeyHex); assert(vout >= 0);
    const sponsorInput = await core.observeCoin({ txid: fanout.txid, vout });
    assert(sponsorInput.valueSats === target.valueSats && sponsorInput.scriptPubKeyHex === target.scriptPubKeyHex);
    assert(await core.rpc('gettxout', [fanout.txid, vout, true]), 'fresh fee sponsor has a pending conflict');
    const owner = family === 'funding' || family === 'solo' ? 'alice' : parent.proposal!.participantIds.find(id => id !== plan.omitted)!;
    // This local acceptance ceremony binds its own exact reviewed parent. It
    // does not impersonate a coordinator's passkey/runtime approval receipt.
    const base = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, epochId: graph.funding.epochId,
      proposalId: family === 'funding' ? null : parent.proposal?.proposalId ?? randomUUID(), ownerParticipantId: owner,
      parentAuthorityDigest: commitmentDigest('vault/presigned-graph-v2/isolated-live-acceptance-parent', {
        graphDigest: graph.digest, txid: parent.txid, transactionHex: parent.transactionHex }) };
    const approval = { childFeeSats: 3000, maxChildFeeSats: 4000, targetPackageRateMillisatsPerVbyte: 5000,
      minRelayRateMillisatsPerVbyte: 1000, sponsorChangeScriptPubKeyHex: sponsorInput.scriptPubKeyHex,
      approveExactNoChangeFee: false, replacement: null };
    let draft: PresignedFeeDraft;
    if (family === 'funding') draft = { ...base, mode: 'funding', request: { graph, fundingTransactionHex: parent.transactionHex,
      changeParticipantId: owner, fundingInputObservations: await Promise.all(graph.funding.inputs.map(coin => core.observeCoin(coin))), sponsorInput, approval } };
    else if (family === 'solo') {
      const exit = graph.exits.find(item => item.id === step)!;
      draft = { ...base, mode: 'solo', request: { graph, exitId: step, parentTransactionHex: parent.transactionHex,
        roundInputObservation: await core.observeCoin({ txid: exit.inputTxid, vout: exit.inputVout }), sponsorInput, approval } };
    } else draft = { ...base, mode: 'spend', request: { graph, parentSpendProposal: parent.proposal!, parentTransactionHex: parent.transactionHex,
      payoutParticipantId: owner, sourceObservation: await core.observeCoin(parent.proposal!.source), sponsorInput, approval } };
    async function sign(draft: PresignedFeeDraft): Promise<PresignedFeePackage> {
      const built = buildPresignedFeeDraft(draft);
      const wallet = bitcoin.Psbt.fromBase64(built.psbtBase64);
      wallet.updateInput(0, { nonWitnessUtxo: bitcoin.Transaction.fromHex(parent.transactionHex).toBuffer() });
      const external = await core.walletRpc('walletprocesspsbt', [wallet.toBase64(), true, 'ALL', true, false]);
      if (draft.mode === 'funding') return { ...draft, signatures: authorizePresignedFundingFeeWalletPsbt({ request: draft.request,
        roles: ['change', 'sponsor'], signedPsbtBase64: external.psbt, approvalDigest: built.approvalDigest }) };
      const payout = await withKeys(directory, plan.id, owner, keys => draft.mode === 'solo'
        ? signPresignedFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys })
        : signPresignedSpendFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys }));
      return { ...draft, signatures: { payoutSignatureHex: payout.payoutSignatureHex, sponsorSignedPsbtBase64: external.psbt } };
    }
    const initial = await sign(draft); const checked = validatePresignedFeePackage(initial);
    const replacementDraft = { ...draft, request: { ...draft.request, approval: { ...draft.request.approval, childFeeSats: 4000,
      replacement: { previousChildTransactionHex: checked.completed.transactionHex, incrementalRelayRateMillisatsPerVbyte: 1000 } } } } as PresignedFeeDraft;
    const replacement = await sign(replacementDraft); validatePresignedFeePackage(replacement);
    saveLifecycleFile(directory, `cases/${plan.id}/fee-${family}.json`, { family, initial, replacement });
  }
  const pair = checkedFeePair(directory, plan, family);
  assert.equal(pair.initial.parentTransactionHex, parent.transactionHex, 'fee parent differs from saved lifecycle transaction');
  return { family, ...pair };
}
async function mempoolContains(core: LiveLifecycleCore, txid: string) {
  try { await core.rpc('getmempoolentry', [txid]); return true; }
  catch (error) { if ((error as { code?: number }).code === -5) return false; throw error; }
}
async function submitFeePair(core: LiveLifecycleCore, directory: string, plan: CasePlan,
  pair: NonNullable<Awaited<ReturnType<typeof saveFeePair>>>, parent: Signed) {
  const first = pair.initial.completed; const replacement = pair.replacement.completed;
  const initialReceipt = `cases/${plan.id}/fee-${pair.family}-initial-accepted.json`;
  const replacementReceipt = `cases/${plan.id}/fee-${pair.family}-replacement-accepted.json`;
  async function reconcileReplacement() {
    assert(has(directory, initialReceipt) && has(directory, `cases/${plan.id}/fee-${pair.family}-replacement-intent.json`),
      'replacement lacks its initial acceptance or durable submission intent');
    assert(!await mempoolContains(core, first.txid) && !await confirmed(core, first), 'previous child remains accepted');
    if (!has(directory, replacementReceipt)) saveLifecycleFile(directory, replacementReceipt, { previousTxid: first.txid,
      txid: replacement.txid, previousNoLongerPending: true, independentlyObserved: true,
      reconciledAfterUnknownOutcome: true, observedAt: new Date().toISOString() });
  }
  const replacementAnchor = await confirmed(core, replacement);
  if (replacementAnchor) { await reconcileReplacement(); return { status: 'confirmed', anchor: replacementAnchor, child: replacement, replaced: true }; }
  const firstAnchor = await confirmed(core, first);
  if (firstAnchor) return { status: 'confirmed-before-replacement', anchor: firstAnchor, child: first, replaced: false };
  if (await mempoolContains(core, replacement.txid)) { await reconcileReplacement(); return { status: 'pending-replacement', anchor: null, child: replacement, replaced: true }; }
  async function submit(child: Signed) {
    const parentAnchor = await confirmed(core, parent);
    const intent = `cases/${plan.id}/fee-${pair.family}-${child.txid === first.txid ? 'initial' : 'replacement'}-intent.json`;
    if (!has(directory, intent)) saveLifecycleFile(directory, intent, { parentTxid: parent.txid, childTxid: child.txid, createdAt: new Date().toISOString() });
    await event(core, directory, { kind: 'fee-submit-intent', case: plan.id, family: pair.family,
      parentTxid: parent.txid, childTxid: child.txid, parentAlreadyConfirmed: Boolean(parentAnchor) });
    if (parentAnchor) assert.equal(await core.rpc('sendrawtransaction', [child.transactionHex]), child.txid);
    else {
      const result = await core.rpc('submitpackage', [[parent.transactionHex, child.transactionHex]]);
      assert.equal(result.package_msg, 'success', 'isolated fee package was not accepted');
    }
    assert(await mempoolContains(core, child.txid) || await confirmed(core, child), 'fee submit did not establish exact child presence');
  }
  if (!await mempoolContains(core, first.txid)) await submit(first);
  if (!has(directory, initialReceipt)) saveLifecycleFile(directory, initialReceipt, { txid: first.txid, parentTxid: parent.txid,
    independentlyObserved: true, observedAt: new Date().toISOString() });
  // A real miner can win this race. Preserve the payout and report that live
  // replacement proof remains missing, rather than pretending eviction passed.
  if (await confirmed(core, first)) return { status: 'confirmed-before-replacement', anchor: await confirmed(core, first), child: first, replaced: false };
  await submit(replacement);
  await reconcileReplacement();
  return { status: 'submitted-replacement', anchor: null, child: replacement, replaced: true };
}
async function auditCasePayouts(core: LiveLifecycleCore, directory: string, plan: CasePlan, funding: Signed,
  steps: Signed[]) {
  const transactions = [funding, ...steps];
  const fees = ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep'].filter(family =>
    has(directory, `cases/${plan.id}/fee-${family}.json`)).map(family => checkedFeePair(directory, plan, family));
  for (const transaction of transactions) {
    const parsed = bitcoin.Transaction.fromHex(transaction.transactionHex);
    const fee = fees.find(pair => pair.initial.completed.parentTxid === transaction.txid) ?? null;
    const confirmedChild = fee ? await confirmed(core, fee.replacement.completed) ? fee.replacement.completed : fee.initial.completed : null;
    const feeInput = confirmedChild ? bitcoin.Transaction.fromHex(confirmedChild.transactionHex).ins[0]!.index : -1;
    for (const [vout, output] of parsed.outs.entries()) {
      const successor = transactions.find(candidate => bitcoin.Transaction.fromHex(candidate.transactionHex).ins.some(input =>
        Buffer.from(input.hash).reverse().toString('hex') === transaction.txid && input.index === vout));
      if (successor) { assert(await confirmed(core, successor), 'a graph successor lost its confirmation'); continue; }
      const coin = await core.observeCoin({ txid: vout === feeInput ? confirmedChild!.txid : transaction.txid, vout: vout === feeInput ? 0 : vout });
      assert(coin.valueSats === Number(output.value) && coin.scriptPubKeyHex === Buffer.from(output.script).toString('hex'), 'full lifecycle payout or refund changed');
    }
    if (fee && confirmedChild) {
      assert(await confirmed(core, confirmedChild), 'fee child has not confirmed');
      const change = await core.observeCoin({ txid: confirmedChild.txid, vout: 1 });
      assert(change.valueSats === fee.initial.package.request.sponsorInput.valueSats - confirmedChild.childFeeSats &&
        change.scriptPubKeyHex === fee.initial.package.request.sponsorInput.scriptPubKeyHex, 'fee sponsor change differs from its exact approved charge');
    }
  }
}
export async function advanceLiveLifecycle(core: LiveLifecycleCore, directory: string) {
  const run = runFor(core, directory);
  assert(has(directory, 'fanout.json'), 'fund the reserved test outputs before advancing');
  const fanout = readLifecycleFile<Signed>(directory, 'fanout.json');
  if (!await confirmed(core, fanout)) return { complete: false, waiting: 'fanout confirmation', ...await fundLiveLifecycle(core, directory) };
  const statuses = [];
  for (const plan of run.cases) {
    const kit = await prepareCase(core, directory, plan, fanout);
    const funding = readLifecycleFile<Signed>(directory, `cases/${plan.id}/funding.json`);
    const fundingFee = await saveFeePair(core, directory, run, plan, 'funding', kit, funding);
    if (fundingFee) {
      const feeResult = await submitFeePair(core, directory, plan, fundingFee, funding);
      if (!feeResult.anchor) { statuses.push({ case: plan.id, stage: 'funding-fee', status: feeResult.status }); continue; }
    }
    const fundingAnchor = await confirmed(core, funding);
    if (!fundingAnchor) { statuses.push({ case: plan.id, stage: 'funding', status: await submitExact(core, directory, plan.id, funding) }); continue; }
    const steps = plan.kind === 'solo-order' ? [plan.first!, plan.source!, 'terminal'] : [...(plan.source ? [plan.source] : []), 'terminal'];
    const anchors: Confirmed[] = [fundingAnchor]; const signedSteps: Signed[] = []; let waiting = false;
    for (const step of steps) {
      const signed = await signedStep(directory, plan, kit, step);
      signedSteps.push(signed);
      const anchor = await confirmed(core, signed);
      if (anchor) {
        const family = feeFamily(plan, step);
        if (family) {
          const pair = await saveFeePair(core, directory, run, plan, step, kit, signed); assert(pair);
          const feeResult = await submitFeePair(core, directory, plan, pair, signed);
          if (!feeResult.anchor) { statuses.push({ case: plan.id, stage: `${step}-fee`, status: feeResult.status }); waiting = true; break; }
        }
        anchors.push(anchor); continue;
      }
      if (await mempoolContains(core, signed.txid)) {
        const family = feeFamily(plan, step);
        if (family) {
          const pair = await saveFeePair(core, directory, run, plan, step, kit, signed); assert(pair);
          await submitFeePair(core, directory, plan, pair, signed);
        }
        statuses.push({ case: plan.id, stage: step, status: 'pending' }); waiting = true; break;
      }
      if (step === 'terminal' && plan.kind === 'recovery') {
        const source = await core.observeCoin(signed.proposal!.source);
        if (source.confirmations < kit.graph.roster.economics.recoveryDelayBlocks) {
          const negative = await core.rpc('testmempoolaccept', [[signed.transactionHex]]);
          assert.equal(negative[0].allowed, false); assert.equal(negative[0]['reject-reason'], 'non-BIP68-final');
          await event(core, directory, { kind: 'csv-premature-rejected', case: plan.id, txid: signed.txid,
            sourceConfirmations: source.confirmations, required: kit.graph.roster.economics.recoveryDelayBlocks });
          statuses.push({ case: plan.id, stage: 'recovery', status: 'waiting-csv', sourceConfirmations: source.confirmations }); waiting = true; break;
        }
      }
      // Test valid bytes before negative tests, so an unrelated policy failure
      // cannot masquerade as evidence that a hostile signature was rejected.
      const positive = await core.rpc('testmempoolaccept', [[signed.transactionHex]]);
      if (positive[0].allowed === true) await hostileChecks(core, directory, plan, step, signed);
      const pair = await saveFeePair(core, directory, run, plan, step, kit, signed);
      const status = pair ? (await submitFeePair(core, directory, plan, pair, signed)).status : await submitExact(core, directory, `${plan.id}/${step}`, signed);
      statuses.push({ case: plan.id, stage: step, status }); waiting = true; break;
    }
    if (!waiting) {
      for (const step of steps) assert(has(directory, `cases/${plan.id}/negative-${step.replace('/', '-')}.json`), 'hostile transaction evidence is missing');
      await auditCasePayouts(core, directory, plan, funding, signedSteps);
      statuses.push({ case: plan.id, stage: 'complete', status: 'confirmed', anchors });
    }
  }
  const completeLifecycleEvidence = statuses.length === 19 && statuses.every(item => item.stage === 'complete');
  const feeEvidence = [];
  for (const plan of run.cases) for (const family of ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep']) {
    if (!has(directory, `cases/${plan.id}/fee-${family}.json`)) continue;
    const pair = checkedFeePair(directory, plan, family);
    feeEvidence.push({ family, parentTxid: pair.initial.completed.parentTxid, initialTxid: pair.initial.completed.txid,
      replacementTxid: pair.replacement.completed.txid,
      initialAcceptanceRecorded: has(directory, `cases/${plan.id}/fee-${family}-initial-accepted.json`),
      replacementAcceptanceRecorded: has(directory, `cases/${plan.id}/fee-${family}-replacement-accepted.json`),
      replacementAnchor: await confirmed(core, pair.replacement.completed) });
  }
  const feeLifecycleEvidence = feeEvidence.length === 5 && feeEvidence.every(item =>
    item.initialAcceptanceRecorded && item.replacementAcceptanceRecorded && item.replacementAnchor);
  const complete = completeLifecycleEvidence && feeLifecycleEvidence;
  const snapshot = { version: 2, protocol: PRESIGNED_PROTOCOL, chain: core.chain, actualGenesisHash: core.actualGenesisHash,
    sourceDigest: core.sourceDigest, complete, completeLifecycleEvidence,
    realDefaultSignetVerified: complete && core.chain === 'default-Signet', physicalPasskeysVerified: false,
    liveBrowserPasskeysVerified: false, feeLifecycleEvidence, feeEvidence,
    soloOrderingsConfirmed: statuses.filter(item => item.stage === 'complete' && run.cases.find(plan => plan.id === item.case)!.kind === 'solo-order').length,
    cooperativeRoundsConfirmed: statuses.filter(item => item.stage === 'complete' && run.cases.find(plan => plan.id === item.case)!.kind === 'cooperative').length,
    recoverySubsetsConfirmed: statuses.filter(item => item.stage === 'complete' && run.cases.find(plan => plan.id === item.case)!.kind === 'recovery').length, statuses };
  await event(core, directory, { kind: 'lifecycle-snapshot', ...snapshot });
  return snapshot;
}
export function lifecycleFilesSummary(directory: string) {
  const run = readLifecycleFile<Run>(directory, 'run.json');
  return { chain: run.chain, sourceDigest: run.sourceDigest, plannedCases: run.cases.length,
    initializedCases: readdirSync(`${directory}/cases`).length, fanoutJournaled: has(directory, 'fanout.json'),
    eventCount: readdirSync(`${directory}/events`).length, requiredTestSatsBeforeFanoutFee: run.requiredTestSatsBeforeFanoutFee };
}

/** Read-only revalidation for the acceptance producer. No preparation, new
 * signatures, wallet RPC, journal writes or broadcast can happen in this path.
 * The live CLI separately verifies actual default-Signet genesis and block 1. */
export async function verifyCompletedLiveLifecycle(core: LiveLifecycleCore, directory: string) {
  const allowed = new Set(['getblockchaininfo', 'getrawtransaction', 'getblockheader', 'getblockhash']);
  const readonlyCore: LiveLifecycleCore = { ...core,
    rpc: (method, params) => { assert(allowed.has(method), 'read-only lifecycle verification attempted a mutating RPC'); return core.rpc(method, params); },
    walletRpc: async () => { throw new Error('read-only lifecycle verification cannot call wallet RPC'); } };
  const run = runFor(readonlyCore, directory);
  const tipBefore = await readonlyCore.rpc('getblockchaininfo');
  const fanout = readLifecycleFile<Signed>(directory, 'fanout.json');
  assert(await confirmed(readonlyCore, fanout), 'test fanout is not confirmed');
  const cases = []; let restoredKits = 0; let hostileRejections = 0;
  for (const plan of run.cases) {
    const kit = validatePresignedPublicKit(readLifecycleFile<PresignedPublicKit>(directory, `cases/${plan.id}/kit.json`));
    assert(kit.graph.roster.network === 'signet' && kit.graph.roster.genesisHash === genesisHash('signet'));
    assert.equal(kit.graph.funding.inputs.length, 3);
    const fanoutTransaction = bitcoin.Transaction.fromHex(fanout.transactionHex);
    for (const target of plan.inputs) {
      const input = kit.graph.funding.inputs.find(item => item.participantId === target.participantId); assert(input);
      assert(input.txid === fanout.txid && input.valueSats === target.valueSats && input.scriptPubKeyHex === target.scriptPubKeyHex &&
        input.changeScriptPubKeyHex === target.scriptPubKeyHex);
      const output = fanoutTransaction.outs[input.vout];
      assert(output && Number(output.value) === input.valueSats && Buffer.from(output.script).toString('hex') === input.scriptPubKeyHex);
    }
    const backups = readLifecycleFile<{ restoredBeforeWalletSigning: boolean; proofs: Array<Parameters<typeof validatePresignedRestorationReceipt>[0]['proof']> }>(
      directory, `cases/${plan.id}/backup-receipts.json`);
    assert(backups.restoredBeforeWalletSigning === true && backups.proofs.length === 3);
    for (const [index, participantId] of PARTICIPANT_IDS.entries()) {
      validatePresignedRestorationReceipt({ graph: kit.graph, preauthorizations: kit.preauthorizations, participantId, proof: backups.proofs[index]! });
      await withKeys(directory, plan.id, participantId, () => undefined); restoredKits++;
    }
    const intent = readLifecycleFile<{ graphDigest: string; fundingTxid: string; backupsVerified: boolean }>(directory, `cases/${plan.id}/wallet-signing-intent.json`);
    assert(intent.graphDigest === kit.graph.digest && intent.fundingTxid === kit.graph.fundingTxid && intent.backupsVerified === true);
    const funding = readLifecycleFile<Signed>(directory, `cases/${plan.id}/funding.json`);
    assert.equal(authorizePresignedFundingTransaction({ graph: kit.graph, transactionHex: funding.transactionHex }).txid, funding.txid);
    const fundingAnchor = await confirmed(readonlyCore, funding); assert(fundingAnchor, 'funding is not currently confirmed');
    const anchors: Confirmed[] = [fundingAnchor]; const signedSteps: Signed[] = [];
    const steps = plan.kind === 'solo-order' ? [plan.first!, plan.source!, 'terminal'] : [...(plan.source ? [plan.source] : []), 'terminal'];
    for (const step of steps) {
      const signed = readLifecycleFile<Signed>(directory, `cases/${plan.id}/step-${step.replace('/', '-')}.json`);
      if (step === 'terminal') {
        assert(signed.proposal && signed.proposal.kind === (plan.kind === 'solo-order' ? 'final-sweep' : plan.kind) &&
          signed.proposal.sourceExitId === plan.source);
        assert.equal(authorizePresignedSpendTransaction({ graph: kit.graph, proposal: signed.proposal, transactionHex: signed.transactionHex }).txid, signed.txid);
        if (plan.kind === 'recovery') {
          const transaction = bitcoin.Transaction.fromHex(signed.transactionHex);
          const round = kit.graph.rounds.find(item => item.id === signed.proposal!.source.roundId); assert(round);
          const omittedPosition = round.recovery.participantIds.length - 1 - round.recovery.participantIds.indexOf(plan.omitted!);
          assert.equal(transaction.ins[0]!.witness[omittedPosition]!.length, 0, 'live recovery used a different omitted signer');
        }
      } else assert.equal(authorizePresignedExitTransaction({ graph: kit.graph, exitId: step, transactionHex: signed.transactionHex }).txid, signed.txid);
      const anchor = await confirmed(readonlyCore, signed); assert(anchor, 'lifecycle step is not currently confirmed');
      if (step === 'terminal' && plan.kind === 'recovery') assert(anchor.height - anchors.at(-1)!.height >= kit.graph.roster.economics.recoveryDelayBlocks,
        'confirmed recovery does not prove the exact relative block delay');
      const negative = readLifecycleFile<{ txid: string; negatives: Array<{ mutation: string; rejected: boolean }> }>(directory,
        `cases/${plan.id}/negative-${step.replace('/', '-')}.json`);
      assert(negative.txid === signed.txid && negative.negatives.length === 2 && negative.negatives.every(item => item.rejected === true));
      assert.deepEqual(negative.negatives.map(item => item.mutation), ['missing-signature', 'changed-payout']);
      hostileRejections += 2; anchors.push(anchor); signedSteps.push(signed);
    }
    await auditCasePayouts(readonlyCore, directory, plan, funding, signedSteps);
    cases.push({ id: plan.id, kind: plan.kind, source: plan.source, omitted: plan.omitted, graphDigest: kit.graph.digest, anchors });
  }
  const fees = [];
  for (const plan of run.cases) for (const family of ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep']) {
    if (!has(directory, `cases/${plan.id}/fee-${family}.json`)) continue;
    const pair = checkedFeePair(directory, plan, family);
    const initial = readLifecycleFile<{ txid: string; parentTxid: string; independentlyObserved: boolean }>(directory, `cases/${plan.id}/fee-${family}-initial-accepted.json`);
    const replacement = readLifecycleFile<{ txid: string; previousTxid: string; previousNoLongerPending: boolean; independentlyObserved: boolean }>(
      directory, `cases/${plan.id}/fee-${family}-replacement-accepted.json`);
    assert(initial.txid === pair.initial.completed.txid && initial.parentTxid === pair.initial.completed.parentTxid && initial.independentlyObserved === true);
    assert(replacement.txid === pair.replacement.completed.txid && replacement.previousTxid === initial.txid &&
      replacement.previousNoLongerPending === true && replacement.independentlyObserved === true);
    assert.equal(await confirmed(readonlyCore, pair.initial.completed), null, 'initial child confirmed instead of being replaced');
    const anchor = await confirmed(readonlyCore, pair.replacement.completed); assert(anchor, 'replacement fee child is not confirmed');
    fees.push({ family, parentTxid: initial.parentTxid, initialTxid: initial.txid, replacementTxid: replacement.txid, anchor });
  }
  assert.deepEqual(fees.map(item => item.family).sort(), ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep'].sort());
  const tipAfter = await readonlyCore.rpc('getblockchaininfo');
  assert(tipBefore.bestblockhash === tipAfter.bestblockhash && tipBefore.blocks === tipAfter.blocks,
    'chain tip changed during completed lifecycle verification; rerun this read-only check');
  const body = { version: 2, protocol: PRESIGNED_PROTOCOL, kind: 'presigned-v2-verified-live-lifecycle', createdAt: new Date().toISOString(),
    sourceDigest: core.sourceDigest, chain: core.chain, actualGenesisHash: core.actualGenesisHash,
    actualTip: { hash: tipAfter.bestblockhash as string, height: tipAfter.blocks as number },
    complete: true, realDefaultSignetVerified: core.chain === 'default-Signet',
    soloOrderingsConfirmed: 6, cooperativeRoundsConfirmed: 4, recoverySubsetsConfirmed: 9, feeFamiliesConfirmed: 5,
    restoredKits, hostileRejections, everyPayoutRefundAndSponsorChangeVerified: true,
    freshRandomParticipantKeys: run.freshRandomParticipantKeys, externalWalletKeysExported: run.externalWalletKeysExported,
    physicalPasskeysVerified: false, liveBrowserPasskeysVerified: false, fundingAuthorized: false, cases, fees };
  return { ...body, receiptDigest: commitmentDigest('vault/presigned-graph-v2/verified-live-lifecycle', body) };
}
