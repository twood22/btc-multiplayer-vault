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
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys, payoutScript } from '../../src/presigned/roster.js';
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
import { buildRecyclingIntent, coinId, MINIMUM_SEQUENTIAL_CAPITAL, RECYCLING_FEE_CAP,
  signRecyclingPayout, validateRecyclingIntent, validateRecyclingWalletPsbt, validateSignedRecycling,
  type RecyclingCoin, type RecyclingIntent, type RecyclingSigned } from './presigned-live-recycling.js';

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
  version: 3; protocol: typeof PRESIGNED_PROTOCOL; chain: LiveLifecycleCore['chain']; actualGenesisHash: string;
  execution: 'bounded-sequential-recycling-v1'; capitalLimitSats: number; initialCapitalSats: number; initialCoin: RecyclingCoin;
  sourceDigest: string; createdAt: string; freshRandomParticipantKeys: true; externalWalletKeysExported: false;
  requiredTestSatsBeforeFanoutFee: number; cases: CasePlan[];
  sponsors: Array<{ family: string; address: string; scriptPubKeyHex: string; valueSats: number }>;
  reserves: Array<{ id: string; address: string; scriptPubKeyHex: string }>;
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
  assert(run.version === 3 && run.execution === 'bounded-sequential-recycling-v1' && run.protocol === PRESIGNED_PROTOCOL && run.chain === core.chain &&
    run.actualGenesisHash === core.actualGenesisHash && run.sourceDigest === core.sourceDigest &&
    run.cases.length === 19 && run.freshRandomParticipantKeys === true && run.externalWalletKeysExported === false,
  'lifecycle run identity changed; retain its state and do not reinterpret it');
  assert.deepEqual(run.cases.map(({ inputs: _inputs, ...definition }) => definition), lifecycleCaseDefinitions(),
    'lifecycle cases omit, duplicate or substitute a required ordering or signer subset');
  assert.deepEqual(run.sponsors.map(item => item.family), ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep']);
  assert(Number.isSafeInteger(run.capitalLimitSats) && run.capitalLimitSats >= MINIMUM_SEQUENTIAL_CAPITAL && run.capitalLimitSats <= 1_000_000 &&
    run.initialCapitalSats === run.initialCoin.valueSats && run.initialCapitalSats >= MINIMUM_SEQUENTIAL_CAPITAL &&
    run.initialCapitalSats <= run.capitalLimitSats && run.initialCoin.participantId === null);
  assert.deepEqual(run.reserves.map(item => item.id), [...run.cases.map(item => item.id), 'return']);
  for (const plan of run.cases) {
    assert.deepEqual(plan.inputs.map(item => item.participantId), [...PARTICIPANT_IDS]);
    assert(plan.inputs.every(item => item.valueSats === 12_000));
  }
  assert(run.sponsors.every(item => item.valueSats === 20_000));
  const scripts = [...run.cases.flatMap(plan => plan.inputs.map(item => item.scriptPubKeyHex)),
    ...run.sponsors.map(item => item.scriptPubKeyHex), ...run.reserves.map(item => item.scriptPubKeyHex)];
  assert(new Set(scripts).size === scripts.length && scripts.every(script => /^(?:0014[0-9a-f]{40}|5120[0-9a-f]{64})$/u.test(script)),
    'reserved capital scripts must be unique native wallet outputs');
  return run;
}
async function walletTarget(core: LiveLifecycleCore, index: number, valueSats: number) {
  const address = await core.walletRpc('getnewaddress', ['presigned-v2-isolated-lifecycle', index % 2 ? 'bech32' : 'bech32m']);
  const info = await core.walletRpc('getaddressinfo', [address]);
  assert(info.ismine === true && typeof info.scriptPubKey === 'string');
  return { address, scriptPubKeyHex: info.scriptPubKey, valueSats };
}
export async function initializeLiveLifecycle(core: LiveLifecycleCore, directory: string,
  options: { capitalLimitSats: number; initialOutpoint: { txid: string; vout: number } }) {
  assert(!has(directory, 'run.json'), 'lifecycle already initialized');
  assert(Number.isSafeInteger(options.capitalLimitSats) && options.capitalLimitSats >= MINIMUM_SEQUENTIAL_CAPITAL &&
    options.capitalLimitSats <= 1_000_000, 'sequential acceptance needs its bounded initial capital budget');
  const observed = await core.observeCoin(options.initialOutpoint);
  assert(observed.valueSats >= MINIMUM_SEQUENTIAL_CAPITAL && observed.valueSats <= options.capitalLimitSats &&
    /^(?:0014[0-9a-f]{40}|5120[0-9a-f]{64})$/u.test(observed.scriptPubKeyHex), 'selected initial native coin is outside the test capital budget');
  assert(await core.rpc('gettxout', [observed.txid, observed.vout, true]), 'selected initial coin has a pending conflict');
  const parent = await core.rpc('getrawtransaction', [observed.txid, true]);
  assert(parent.confirmations > 0 && parent.vin.every((input: { coinbase?: string }) => input.coinbase === undefined),
    'initial capital must be an exact confirmed non-coinbase output');
  const seedAddress = parent.vout?.[observed.vout]?.scriptPubKey?.address;
  assert(typeof seedAddress === 'string', 'initial native coin has no Core network address');
  const walletInfo = await core.walletRpc('getaddressinfo', [seedAddress]);
  assert(walletInfo.ismine === true && walletInfo.scriptPubKey === observed.scriptPubKeyHex, 'initial capital is not owned by the isolated wallet');
  const initialCoin: RecyclingCoin = { txid: observed.txid, vout: observed.vout, valueSats: observed.valueSats,
    scriptPubKeyHex: observed.scriptPubKeyHex, participantId: null, parentTransactionHex: parent.hex };
  for (const name of ['cases', 'keys', 'events', 'interrupted', 'allocations']) mkdirSync(`${directory}/${name}`, { mode: 0o700 });
  const cases: CasePlan[] = lifecycleCaseDefinitions().map(definition => ({ ...definition, inputs: [] }));
  let index = 0;
  for (const item of cases) for (const participantId of PARTICIPANT_IDS)
    item.inputs.push({ participantId, ...await walletTarget(core, index++, 12_000) });
  const sponsors: Run['sponsors'] = [];
  for (const family of ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep'])
    sponsors.push({ family, ...await walletTarget(core, index++, 20_000) });
  const reserves: Run['reserves'] = [];
  for (const id of [...cases.map(item => item.id), 'return']) {
    const target = await walletTarget(core, index++, 0);
    reserves.push({ id, address: target.address, scriptPubKeyHex: target.scriptPubKeyHex });
  }
  const run: Run = { version: 3, protocol: PRESIGNED_PROTOCOL, execution: 'bounded-sequential-recycling-v1',
    chain: core.chain, actualGenesisHash: core.actualGenesisHash,
    capitalLimitSats: options.capitalLimitSats, initialCapitalSats: initialCoin.valueSats, initialCoin, reserves,
    sourceDigest: core.sourceDigest, createdAt: new Date().toISOString(), freshRandomParticipantKeys: true,
    externalWalletKeysExported: false, requiredTestSatsBeforeFanoutFee: 96_000, cases, sponsors };
  saveLifecycleFile(directory, 'run.json', run);
  return { initialized: true, chain: core.chain, cases: cases.length, requiredTestSatsBeforeFanoutFee: 96_000,
    initialCapitalSats: initialCoin.valueSats, capitalLimitSats: options.capitalLimitSats,
    maximumUniqueConfirmedFeesSats: 47_000 + 20 * RECYCLING_FEE_CAP };
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
  const allocation = await ensureAllocation(core, directory, run, run.cases[0]!.id);
  return { fanout: await submitExact(core, directory, 'initial-capital-allocation', allocation.signed) };
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
    const fanout = readAllocation(directory, run, plan.id).signed;
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
const caseSteps = (plan: CasePlan) => plan.kind === 'solo-order'
  ? [plan.first!, plan.source!, 'terminal'] : [...(plan.source ? [plan.source] : []), 'terminal'];
const caseFeeFamilies = (plan: CasePlan) => ['funding', ...caseSteps(plan)].map(step => feeFamily(plan, step))
  .filter((family): family is NonNullable<ReturnType<typeof feeFamily>> => family !== null);
const runDigest = (run: Run) => commitmentDigest('vault/presigned-graph-v2/isolated-capital-run', run);
const inputId = (input: bitcoin.Transaction['ins'][number]) => `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`;
function allocationShape(run: Run, id: string) {
  const plan = run.cases.find(item => item.id === id);
  assert(plan || id === 'return');
  const reserve = run.reserves.find(item => item.id === id); assert(reserve);
  const targets = plan ? [...plan.inputs, ...caseFeeFamilies(plan).map(family => run.sponsors.find(item => item.family === family)!)] : [];
  return { reserve, targets: targets.map(target => ({ scriptPubKeyHex: target.scriptPubKeyHex, valueSats: target.valueSats })) };
}
function readAllocation(directory: string, run: Run, id: string) {
  const intent = validateRecyclingIntent(readLifecycleFile<RecyclingIntent>(directory, `allocations/${id}.intent.json`));
  const signed = validateSignedRecycling(intent, readLifecycleFile<RecyclingSigned>(directory, `allocations/${id}.signed.json`));
  const shape = allocationShape(run, id);
  assert(intent.id === id && intent.sourceDigest === run.sourceDigest && intent.runDigest === runDigest(run) &&
    intent.reserveScriptPubKeyHex === shape.reserve.scriptPubKeyHex && intent.inputSats <= run.initialCapitalSats);
  assert.deepEqual(intent.targets, shape.targets);
  return { intent, signed };
}
/** Exact completed transaction DAG, including wallet refunds, fee-child payout
 * preservation, sponsor change and the untouched allocation reserve. No live
 * spendability assumption is made here: those leaves may already be recycled. */
function completedCaseJournal(directory: string, run: Run, plan: CasePlan) {
  const allocation = readAllocation(directory, run, plan.id);
  const kit = validatePresignedPublicKit(readLifecycleFile<PresignedPublicKit>(directory, `cases/${plan.id}/kit.json`));
  const fundingIntent = readLifecycleFile<{ graphDigest: string; fundingTxid: string; backupsVerified: boolean }>(
    directory, `cases/${plan.id}/wallet-signing-intent.json`);
  assert(fundingIntent.graphDigest === kit.graph.digest && fundingIntent.fundingTxid === kit.graph.fundingTxid &&
    fundingIntent.backupsVerified === true, 'completed predecessor lost its exact pre-funding backup intent');
  assert.deepEqual(kit.graph.roster.economics, { depositSatsPerParticipant: 10_000, firstWithdrawalSats: 9500,
    secondWithdrawalSats: 10_250, soloWithdrawalFeeSats: 300, soloFeeBudgetSats: 2000,
    cooperativeFeeSats: 300, recoveryFeeSats: 500, finalSweepFeeSats: 300, recoveryDelayBlocks: 12 });
  const allocationTx = bitcoin.Transaction.fromHex(allocation.signed.transactionHex);
  for (const target of plan.inputs) {
    const input = kit.graph.funding.inputs.find(item => item.participantId === target.participantId); assert(input);
    const output = allocationTx.outs[input.vout];
    assert(input.txid === allocation.signed.txid && input.valueSats === target.valueSats &&
      input.scriptPubKeyHex === target.scriptPubKeyHex && input.changeScriptPubKeyHex === target.scriptPubKeyHex &&
      output?.value === BigInt(input.valueSats) && Buffer.from(output.script).toString('hex') === input.scriptPubKeyHex,
    'case funding is not confined to its exact allocation');
  }
  const backups = readLifecycleFile<{ restoredBeforeWalletSigning: boolean; proofs: Array<Parameters<typeof validatePresignedRestorationReceipt>[0]['proof']> }>(
    directory, `cases/${plan.id}/backup-receipts.json`);
  assert(backups.restoredBeforeWalletSigning && backups.proofs.length === 3);
  for (const [index, participantId] of PARTICIPANT_IDS.entries()) validatePresignedRestorationReceipt({
    graph: kit.graph, preauthorizations: kit.preauthorizations, participantId, proof: backups.proofs[index]! });
  const funding = readLifecycleFile<Signed>(directory, `cases/${plan.id}/funding.json`);
  assert.equal(authorizePresignedFundingTransaction({ graph: kit.graph, transactionHex: funding.transactionHex }).txid, funding.txid);
  const steps = caseSteps(plan).map(step => {
    const signed = readLifecycleFile<Signed>(directory, `cases/${plan.id}/step-${step.replace('/', '-')}.json`);
    if (step === 'terminal') {
      assert(signed.proposal && signed.proposal.kind === (plan.kind === 'solo-order' ? 'final-sweep' : plan.kind) &&
        signed.proposal.sourceExitId === plan.source);
      assert.equal(authorizePresignedSpendTransaction({ graph: kit.graph, proposal: signed.proposal, transactionHex: signed.transactionHex }).txid, signed.txid);
      if (plan.kind === 'recovery') {
        const transaction = bitcoin.Transaction.fromHex(signed.transactionHex);
        const round = kit.graph.rounds.find(item => item.id === signed.proposal!.source.roundId); assert(round);
        const position = round.recovery.participantIds.length - 1 - round.recovery.participantIds.indexOf(plan.omitted!);
        assert.equal(transaction.ins[0]!.witness[position]!.length, 0, 'recycling case used a different recovery subset');
      }
    } else assert.equal(authorizePresignedExitTransaction({ graph: kit.graph, exitId: step, transactionHex: signed.transactionHex }).txid, signed.txid);
    const negative = readLifecycleFile<{ txid: string; negatives: Array<{ mutation: string; rejected: boolean }> }>(
      directory, `cases/${plan.id}/negative-${step.replace('/', '-')}.json`);
    assert(negative.txid === signed.txid && negative.negatives.length === 2 && negative.negatives.every(item => item.rejected === true));
    assert.deepEqual(negative.negatives.map(item => item.mutation), ['missing-signature', 'changed-payout']);
    return { step, signed };
  });
  const graphNodes = [funding, ...steps.map(item => item.signed)];
  const fees = caseFeeFamilies(plan).map(family => {
    const pair = checkedFeePair(directory, plan, family);
    const step = ['funding', ...caseSteps(plan)].find(item => feeFamily(plan, item) === family)!;
    const parent = step === 'funding' ? funding : steps.find(item => item.step === step)!.signed;
    const target = run.sponsors.find(item => item.family === family)!;
    const sponsor = pair.replacement.package.request.sponsorInput;
    const output = allocationTx.outs[sponsor.vout];
    assert(pair.replacement.parentTransactionHex === parent.transactionHex && sponsor.txid === allocation.signed.txid &&
      sponsor.valueSats === target.valueSats && sponsor.scriptPubKeyHex === target.scriptPubKeyHex &&
      output?.value === BigInt(sponsor.valueSats) && Buffer.from(output.script).toString('hex') === sponsor.scriptPubKeyHex,
    'fee child imports an unallocated sponsor or substitutes its parent');
    const initial = readLifecycleFile<{ txid: string; parentTxid: string; independentlyObserved: boolean }>(directory,
      `cases/${plan.id}/fee-${family}-initial-accepted.json`);
    const replacement = readLifecycleFile<{ txid: string; previousTxid: string; previousNoLongerPending: boolean; independentlyObserved: boolean }>(directory,
      `cases/${plan.id}/fee-${family}-replacement-accepted.json`);
    assert(initial.txid === pair.initial.completed.txid && initial.parentTxid === parent.txid && initial.independentlyObserved &&
      replacement.txid === pair.replacement.completed.txid && replacement.previousTxid === initial.txid &&
      replacement.previousNoLongerPending && replacement.independentlyObserved, 'fee replacement evidence is incomplete');
    return { family, ...pair };
  });
  const nodes = [...graphNodes, ...fees.map(item => item.replacement.completed)];
  assert(new Set(nodes.map(item => item.txid)).size === nodes.length);
  const inventory = new Map<string, { txid: string; vout: number; valueSats: number; scriptPubKeyHex: string; parentTransactionHex: string }>();
  for (const node of [allocation.signed, ...nodes]) {
    const tx = bitcoin.Transaction.fromHex(node.transactionHex);
    tx.outs.forEach((output, vout) => inventory.set(`${node.txid}:${vout}`, { txid: node.txid, vout,
      valueSats: Number(output.value), scriptPubKeyHex: Buffer.from(output.script).toString('hex'), parentTransactionHex: node.transactionHex }));
  }
  const consumed = new Set<string>(); let fixedFeesSats = 0;
  for (const node of nodes) {
    const tx = bitcoin.Transaction.fromHex(node.transactionHex); let inputSats = 0;
    for (const input of tx.ins) {
      const id = inputId(input); const coin = inventory.get(id);
      assert(coin && !consumed.has(id), 'case transaction imports capital or double-spends its authorized DAG');
      consumed.add(id); inputSats += coin.valueSats;
    }
    const fee = inputSats - tx.outs.reduce((sum, output) => sum + Number(output.value), 0);
    assert(fee > 0); fixedFeesSats += fee;
  }
  const expectedGraphFees = plan.kind === 'solo-order' ? 1800 : 600 + (plan.source ? 300 : 0) + (plan.kind === 'recovery' ? 500 : 300);
  assert.equal(fixedFeesSats, expectedGraphFees + fees.length * 4000, 'case changed the fixed acceptance economics');
  const walletScripts = new Set([...plan.inputs.map(item => item.scriptPubKeyHex),
    ...caseFeeFamilies(plan).map(family => run.sponsors.find(item => item.family === family)!.scriptPubKeyHex),
    allocation.intent.reserveScriptPubKeyHex]);
  const leaves: RecyclingCoin[] = [...inventory.entries()].filter(([id]) => !consumed.has(id)).map(([, coin]) => {
    const participantId = PARTICIPANT_IDS.find(id => payoutScript(kit.graph.roster, id).toString('hex') === coin.scriptPubKeyHex) ?? null;
    assert(participantId !== null || walletScripts.has(coin.scriptPubKeyHex), 'unfinished vault or unknown output cannot become recycled capital');
    return { ...coin, participantId };
  });
  assert(leaves.length <= 10 && leaves.filter(coin => coin.participantId !== null).length === 3,
    'completed case does not contain all three participant payouts');
  assert.equal(leaves.reduce((sum, coin) => sum + coin.valueSats, 0),
    allocation.intent.inputSats - allocation.intent.feeSats - fixedFeesSats, 'case capital conservation failed');
  const digest = commitmentDigest('vault/presigned-graph-v2/completed-isolated-capital-case', {
    case: plan.id, allocationIntentDigest: allocation.intent.intentDigest, graphDigest: kit.graph.digest,
    funding, steps, backups, feeChildren: fees.map(item => ({ family: item.family,
      initial: item.initial.completed, replacement: item.replacement.completed })), leaves });
  return { kit, allocation, funding, steps, nodes, fees, leaves, fixedFeesSats, digest };
}
function expectedAllocation(directory: string, run: Run, id: string) {
  const position = id === 'return' ? run.cases.length : run.cases.findIndex(plan => plan.id === id);
  assert(position >= 0);
  const previous = position > 0 ? completedCaseJournal(directory, run, run.cases[position - 1]!) : null;
  const shape = allocationShape(run, id);
  return { previous, intent: buildRecyclingIntent({ id, sourceDigest: run.sourceDigest, runDigest: runDigest(run),
    previousCaseDigest: previous?.digest ?? null, inputs: previous?.leaves ?? [run.initialCoin],
    targets: shape.targets, reserveScriptPubKeyHex: shape.reserve.scriptPubKeyHex }) };
}
async function freshAllocationInputs(core: LiveLifecycleCore, intent: RecyclingIntent) {
  for (const coin of intent.inputs) {
    assert(await confirmed(core, { txid: coin.txid, transactionHex: coin.parentTransactionHex }), 'allocation input parent lost its active confirmation');
    const observed = await core.observeCoin(coin);
    assert(observed.txid === coin.txid && observed.vout === coin.vout && observed.valueSats === coin.valueSats && observed.scriptPubKeyHex === coin.scriptPubKeyHex);
    const live = await core.rpc('gettxout', [coin.txid, coin.vout, true]);
    assert(live && live.confirmations > 0 && Math.round(live.value * 1e8) === coin.valueSats &&
      live.scriptPubKey.hex === coin.scriptPubKeyHex, 'reserved capital input is missing or has a pending conflict');
  }
}
async function ensureAllocation(core: LiveLifecycleCore, directory: string, run: Run, id: string) {
  const expected = expectedAllocation(directory, run, id);
  const intentName = `allocations/${id}.intent.json`; const signedName = `allocations/${id}.signed.json`;
  if (has(directory, intentName)) assert.deepEqual(validateRecyclingIntent(readLifecycleFile<RecyclingIntent>(directory, intentName)), expected.intent,
    'allocation intent differs from the exact completed predecessor');
  else {
    assert(!has(directory, signedName), 'signed allocation has lost its durable intent');
    await freshAllocationInputs(core, expected.intent);
    const shape = allocationShape(run, id);
    for (const target of [...(run.cases.find(plan => plan.id === id)?.inputs ?? []),
      ...run.sponsors.filter(target => shape.targets.some(item => item.scriptPubKeyHex === target.scriptPubKeyHex)), shape.reserve]) {
      const info = await core.walletRpc('getaddressinfo', [target.address]);
      assert(info.ismine === true && info.scriptPubKey === target.scriptPubKeyHex, 'allocation destination is not controlled by the isolated wallet');
    }
    // Commit the entire exact PSBT/template, input ancestry and fee before any
    // wallet signing or participant-key restoration for capital recycling.
    saveLifecycleFile(directory, intentName, expected.intent);
  }
  if (!has(directory, signedName)) {
    await freshAllocationInputs(core, expected.intent);
    const response = await core.walletRpc('walletprocesspsbt', [expected.intent.psbtBase64, true, 'ALL', true, false]);
    const walletWitnesses = validateRecyclingWalletPsbt(expected.intent, response.psbt);
    const unsigned = bitcoin.Transaction.fromHex(expected.intent.unsignedTransactionHex);
    walletWitnesses.forEach((witness, index) => { if (witness) unsigned.setWitness(index, witness); });
    // Validate every prevout and wallet signature before restoring local keys.
    for (const [index, coin] of expected.intent.inputs.entries()) {
      if (coin.participantId === null) continue;
      else {
        assert(expected.previous, 'initial capital cannot use participant keys');
        const participant = expected.previous.kit.graph.roster.participants.find(item => item.id === coin.participantId)!;
        const witness = await withKeys(directory, run.cases[(id === 'return' ? run.cases.length : run.cases.findIndex(plan => plan.id === id)) - 1]!.id,
          coin.participantId, keys => signRecyclingPayout(expected.intent, index, coin.participantId!, keys.payoutPrivateKey, participant.payoutXonlyPublicKeyHex));
        unsigned.setWitness(index, [witness]);
      }
    }
    const signed = validateSignedRecycling(expected.intent, { transactionHex: unsigned.toHex(), txid: unsigned.getId(), intentDigest: expected.intent.intentDigest });
    saveLifecycleFile(directory, signedName, signed);
  }
  const allocation = readAllocation(directory, run, id);
  if (!await confirmed(core, allocation.signed) && !await mempoolContains(core, allocation.signed.txid))
    await freshAllocationInputs(core, allocation.intent);
  return allocation;
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
async function auditCasePayouts(core: LiveLifecycleCore, directory: string, run: Run, plan: CasePlan) {
  const journal = completedCaseJournal(directory, run, plan);
  for (const node of [journal.allocation.signed, ...journal.nodes])
    assert(await confirmed(core, node), 'a completed case or capital predecessor lost its active confirmation');
  for (const fee of journal.fees) assert.equal(await confirmed(core, fee.initial.completed), null,
    'initial fee child confirmed instead of the required replacement');
  const nextId = run.cases[run.cases.findIndex(item => item.id === plan.id) + 1]?.id ?? 'return';
  let exactNextPresent = false;
  if (has(directory, `allocations/${nextId}.intent.json`)) {
    const expected = expectedAllocation(directory, run, nextId).intent;
    assert.deepEqual(validateRecyclingIntent(readLifecycleFile<RecyclingIntent>(directory, `allocations/${nextId}.intent.json`)), expected);
    if (has(directory, `allocations/${nextId}.signed.json`)) {
      const next = readAllocation(directory, run, nextId);
      exactNextPresent = Boolean(await confirmed(core, next.signed)) || await mempoolContains(core, next.signed.txid);
    }
  }
  for (const coin of journal.leaves) {
    const live = await core.rpc('gettxout', [coin.txid, coin.vout, true]);
    if (live) {
      assert(!exactNextPresent && live.confirmations > 0 && Math.round(live.value * 1e8) === coin.valueSats &&
        live.scriptPubKey.hex === coin.scriptPubKeyHex, 'historical payout or current capital inventory changed');
    } else assert(exactNextPresent, 'completed payout was spent outside its exact authorized recycling transaction');
  }
  return journal;
}
async function verifyCapitalReturn(core: LiveLifecycleCore, directory: string, run: Run) {
  let allocationFeesSats = 0; let fixedConfirmedFeesSats = 0; const ids = new Set<string>();
  for (const id of [...run.cases.map(item => item.id), 'return']) {
    const allocation = readAllocation(directory, run, id);
    assert.deepEqual(allocation.intent, expectedAllocation(directory, run, id).intent);
    assert(await confirmed(core, allocation.signed), 'capital allocation is not currently confirmed');
    assert(!ids.has(allocation.signed.txid)); ids.add(allocation.signed.txid);
    allocationFeesSats += allocation.intent.feeSats;
    const plan = run.cases.find(item => item.id === id);
    if (plan) {
      const journal = await auditCasePayouts(core, directory, run, plan);
      fixedConfirmedFeesSats += journal.fixedFeesSats;
      for (const node of journal.nodes) { assert(!ids.has(node.txid)); ids.add(node.txid); }
    }
  }
  const returned = readAllocation(directory, run, 'return');
  assert(returned.intent.targets.length === 0 && bitcoin.Transaction.fromHex(returned.signed.transactionHex).outs.length === 1);
  const live = await core.rpc('gettxout', [returned.signed.txid, 0, true]);
  assert(live && live.confirmations > 0 && Math.round(live.value * 1e8) === returned.intent.reserveSats &&
    live.scriptPubKey.hex === returned.intent.reserveScriptPubKeyHex, 'final capital return is not currently available');
  const uniqueConfirmedFeesSats = allocationFeesSats + fixedConfirmedFeesSats;
  assert(fixedConfirmedFeesSats === 47_000 && ids.size === 84 && allocationFeesSats <= 20 * RECYCLING_FEE_CAP);
  assert.equal(run.initialCapitalSats, returned.intent.reserveSats + uniqueConfirmedFeesSats,
    'closed capital DAG imported funds or lost unaccounted value');
  return { version: 1, execution: run.execution, initialOutpoint: { txid: run.initialCoin.txid, vout: run.initialCoin.vout },
    initialCapitalSats: run.initialCapitalSats, capitalLimitSats: run.capitalLimitSats, unrelatedWalletInputsUsed: 0,
    confirmedAllocations: 20, uniqueConfirmedTransactions: ids.size, fixedConfirmedFeesSats, allocationFeesSats,
    uniqueConfirmedFeesSats, maximumUniqueConfirmedFeesSats: 47_000 + 20 * RECYCLING_FEE_CAP,
    returnedSats: returned.intent.reserveSats, returnTxid: returned.signed.txid,
    allTerminalOutputsAndReservesConsumedExactlyOnce: true, finalWalletReturnConfirmedAndUnspent: true };
}
export async function advanceLiveLifecycle(core: LiveLifecycleCore, directory: string) {
  const run = runFor(core, directory);
  assert(has(directory, 'allocations/case-00.intent.json'), 'fund the initial reserved test outputs before advancing');
  const statuses = [];
  for (const plan of run.cases) {
    const allocation = await ensureAllocation(core, directory, run, plan.id);
    if (!await confirmed(core, allocation.signed)) {
      statuses.push({ case: plan.id, stage: 'allocation', status: await submitExact(core, directory, `${plan.id}/capital-allocation`, allocation.signed) }); break;
    }
    const kit = await prepareCase(core, directory, plan, allocation.signed);
    const funding = readLifecycleFile<Signed>(directory, `cases/${plan.id}/funding.json`);
    const fundingFee = await saveFeePair(core, directory, run, plan, 'funding', kit, funding);
    if (fundingFee) {
      const feeResult = await submitFeePair(core, directory, plan, fundingFee, funding);
      if (!feeResult.anchor || !feeResult.replaced) { statuses.push({ case: plan.id, stage: 'funding-fee', status: feeResult.status }); break; }
    }
    const fundingAnchor = await confirmed(core, funding);
    if (!fundingAnchor) { statuses.push({ case: plan.id, stage: 'funding', status: await submitExact(core, directory, plan.id, funding) }); break; }
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
          if (!feeResult.anchor || !feeResult.replaced) { statuses.push({ case: plan.id, stage: `${step}-fee`, status: feeResult.status }); waiting = true; break; }
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
      await auditCasePayouts(core, directory, run, plan);
      statuses.push({ case: plan.id, stage: 'complete', status: 'confirmed', anchors });
    } else break;
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
  let capitalRecyclingEvidence: Awaited<ReturnType<typeof verifyCapitalReturn>> | null = null;
  let capitalReturnStatus: string | null = null;
  if (completeLifecycleEvidence && feeLifecycleEvidence) {
    const returned = await ensureAllocation(core, directory, run, 'return');
    capitalReturnStatus = await submitExact(core, directory, 'final-capital-return', returned.signed);
    if (capitalReturnStatus === 'confirmed') capitalRecyclingEvidence = await verifyCapitalReturn(core, directory, run);
  }
  const complete = completeLifecycleEvidence && feeLifecycleEvidence && capitalRecyclingEvidence !== null;
  const snapshot = { version: 2, protocol: PRESIGNED_PROTOCOL, chain: core.chain, actualGenesisHash: core.actualGenesisHash,
    sourceDigest: core.sourceDigest, complete, completeLifecycleEvidence,
    realDefaultSignetVerified: complete && core.chain === 'default-Signet', physicalPasskeysVerified: false,
    liveBrowserPasskeysVerified: false, feeLifecycleEvidence, feeEvidence, capitalRecyclingEvidence, capitalReturnStatus,
    soloOrderingsConfirmed: statuses.filter(item => item.stage === 'complete' && run.cases.find(plan => plan.id === item.case)!.kind === 'solo-order').length,
    cooperativeRoundsConfirmed: statuses.filter(item => item.stage === 'complete' && run.cases.find(plan => plan.id === item.case)!.kind === 'cooperative').length,
    recoverySubsetsConfirmed: statuses.filter(item => item.stage === 'complete' && run.cases.find(plan => plan.id === item.case)!.kind === 'recovery').length, statuses };
  await event(core, directory, { kind: 'lifecycle-snapshot', ...snapshot });
  return snapshot;
}
export function lifecycleFilesSummary(directory: string) {
  const run = readLifecycleFile<Run>(directory, 'run.json');
  return { chain: run.chain, sourceDigest: run.sourceDigest, plannedCases: run.cases.length,
    initializedCases: readdirSync(`${directory}/cases`).length, fanoutJournaled: has(directory, 'allocations/case-00.signed.json'),
    allocationsJournaled: run.reserves.filter(item => has(directory, `allocations/${item.id}.signed.json`)).length,
    initialCapitalSats: run.initialCapitalSats, capitalLimitSats: run.capitalLimitSats, execution: run.execution,
    eventCount: readdirSync(`${directory}/events`).length, requiredTestSatsBeforeFanoutFee: run.requiredTestSatsBeforeFanoutFee };
}

/** Read-only revalidation for the acceptance producer. No preparation, new
 * signatures, wallet RPC, journal writes or broadcast can happen in this path.
 * The live CLI separately verifies actual default-Signet genesis and block 1. */
export async function verifyCompletedLiveLifecycle(core: LiveLifecycleCore, directory: string) {
  const allowed = new Set(['getblockchaininfo', 'getrawtransaction', 'getblockheader', 'getblockhash', 'gettxout']);
  const readonlyCore: LiveLifecycleCore = { ...core,
    rpc: (method, params) => { assert(allowed.has(method), 'read-only lifecycle verification attempted a mutating RPC'); return core.rpc(method, params); },
    walletRpc: async () => { throw new Error('read-only lifecycle verification cannot call wallet RPC'); } };
  const run = runFor(readonlyCore, directory);
  const tipBefore = await readonlyCore.rpc('getblockchaininfo');
  const cases = []; let restoredKits = 0; let hostileRejections = 0;
  for (const plan of run.cases) {
    const allocation = readAllocation(directory, run, plan.id);
    assert.deepEqual(allocation.intent, expectedAllocation(directory, run, plan.id).intent);
    const fanout = allocation.signed;
    assert(await confirmed(readonlyCore, fanout), 'case capital allocation is not currently confirmed');
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
    await auditCasePayouts(readonlyCore, directory, run, plan);
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
  const capitalRecyclingEvidence = await verifyCapitalReturn(readonlyCore, directory, run);
  const tipAfter = await readonlyCore.rpc('getblockchaininfo');
  assert(tipBefore.bestblockhash === tipAfter.bestblockhash && tipBefore.blocks === tipAfter.blocks,
    'chain tip changed during completed lifecycle verification; rerun this read-only check');
  const body = { version: 2, protocol: PRESIGNED_PROTOCOL, kind: 'presigned-v2-verified-live-lifecycle', createdAt: new Date().toISOString(),
    sourceDigest: core.sourceDigest, chain: core.chain, actualGenesisHash: core.actualGenesisHash,
    actualTip: { hash: tipAfter.bestblockhash as string, height: tipAfter.blocks as number },
    complete: true, realDefaultSignetVerified: core.chain === 'default-Signet',
    soloOrderingsConfirmed: 6, cooperativeRoundsConfirmed: 4, recoverySubsetsConfirmed: 9, feeFamiliesConfirmed: 5,
    restoredKits, hostileRejections, everyPayoutRefundAndSponsorChangeVerified: true, capitalRecyclingEvidence,
    freshRandomParticipantKeys: run.freshRandomParticipantKeys, externalWalletKeysExported: run.externalWalletKeysExported,
    physicalPasskeysVerified: false, liveBrowserPasskeysVerified: false, fundingAuthorized: false, cases, fees };
  return { ...body, receiptDigest: commitmentDigest('vault/presigned-graph-v2/verified-live-lifecycle', body) };
}
