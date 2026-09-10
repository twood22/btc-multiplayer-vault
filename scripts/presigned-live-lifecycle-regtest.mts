/** Tests exact low-capital resumable orchestration, not real Signet proof. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../src/presigned/core.js';
import { genesisHash } from '../src/presigned/validation.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';
import { advanceLiveLifecycle, fundLiveLifecycle, initializeLiveLifecycle, readLifecycleFile,
  saveLifecycleFile, verifyCompletedLiveLifecycle, verifyRestoredLiveLifecycleCustody, type LiveLifecycleCore } from './lib/presigned-live-lifecycle.js';
import { validatePresignedFeePackage, type PresignedFeePackage } from '../src/presigned/fee-package.js';
import type { PresignedSpendProposal } from '../src/presigned/spends.js';
import type { PresignedPublicKit } from '../src/presigned/types.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { coinId, MINIMUM_SEQUENTIAL_CAPITAL, RECYCLING_FEE_CAP,
  validateRecyclingIntent, validateSignedRecycling,
  type RecyclingCoin, type RecyclingIntent, type RecyclingSigned } from './lib/presigned-live-recycling.js';
import { LIVE_REGTEST_CAPITAL_SATS, LIVE_CAPITAL_EXECUTION } from './lib/presigned-live-capital.js';
import { createDurableLifecycleJournal } from './lib/presigned-durable-journal.js';
import { restoreLifecyclePrimary } from './lib/presigned-primary-restore.js';

const CAPITAL_SATS = LIVE_REGTEST_CAPITAL_SATS;
const FIXED_CONFIRMED_FEES_SATS = 47_000;
const LOST_RESPONSE = 'deliberately lost successful Core response';
const INTERRUPTED_INITIALIZATION = 'deliberately interrupted exact native initialization';
const CASE_IDS = Array.from({ length: 19 }, (_, index) => `case-${String(index).padStart(2, '0')}`);
const ALLOCATION_IDS = [...CASE_IDS, 'return'];
const FAMILIES = ['funding', 'solo', 'cooperative', 'recovery', 'final-sweep'];
interface StoredSigned { transactionHex: string; txid: string }
interface CaseDefinition {
  id: string; kind: 'solo-order' | 'cooperative' | 'recovery';
  source: string | null; first: string | null; second: string | null;
}
interface RunEvidence {
  execution: string; initialCapitalSats: number; capitalLimitSats: number;
  initialCoin: RecyclingCoin; sourceDigest: string; cases: CaseDefinition[];
}
interface CsvBoundaryRecord {
  caseId: string; delayBlocks: number; sourceTxid: string; sourceVout: number; sourceAnchor: string;
  initialConfirmations: number; justBeforeConfirmations: number; maturityConfirmations: number;
  transactionTxid: string; transactionSha256: string;
  justBeforeMaturityRejected: boolean; matureTransactionAllowed: boolean; sameStoredTransactionBytes: boolean;
}
const inputId = (input: bitcoin.Transaction['ins'][number]) =>
  `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`;
const sumOutputs = (tx: bitcoin.Transaction) => tx.outs.reduce((sum, output) => sum + Number(output.value), 0);
const caseSteps = (plan: CaseDefinition) => plan.kind === 'solo-order'
  ? [plan.first!, plan.source!, 'terminal'] : [...(plan.source ? [plan.source] : []), 'terminal'];

process.umask(0o077);
// Diagnostic-only early stop. The fixed full acceptance command has no such
// argument and its parser rejects this deliberately incomplete smoke summary.
assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--custody-smoke'));
const custodySmoke = process.argv[2] === '--custody-smoke';
await withPresignedRegtest(async host => {
  const fixtureRoot = mkdtempSync('/tmp/btc-presigned-live-runner.');
  let directory = `${fixtureRoot}/primary`; mkdirSync(directory, { mode: 0o700 });
  const backupDirectory = mkdtempSync('/tmp/btc-presigned-live-backup.');
  const anchorDirectory = mkdtempSync('/tmp/btc-presigned-live-anchor.');
  const restorationParent = mkdtempSync('/tmp/btc-presigned-live-restores.');
  // Deliberately leave the host wallet's much larger coins available. The
  // lifecycle must select only this confirmed non-coinbase seed and its heirs.
  const seedAddress = await host.walletRpc('getnewaddress', ['bounded-lifecycle-seed', 'bech32m']);
  const seedInfo = await host.walletRpc('getaddressinfo', [seedAddress]);
  const [seed] = await host.fundScripts([{ scriptPubKeyHex: seedInfo.scriptPubKey, valueSats: CAPITAL_SATS }]);
  assert(seed && seed.valueSats === CAPITAL_SATS);
  const seedParent = await host.rpc('getrawtransaction', [seed.txid, true]);
  assert(seedParent.confirmations > 0 && seedParent.vin.every((input: { coinbase?: string }) => input.coinbase === undefined));
  const excludedWalletCoins = new Set<string>((await host.walletRpc('listunspent')).map(coinId));
  excludedWalletCoins.delete(coinId(seed));
  assert(excludedWalletCoins.size > 0, 'fixture must retain unrelated large wallet coins');
  // Format-only mapping is confined to this network-disabled test executable.
  // Live CLI verifies both real genesis and block 1 and offers no bypass flag.
  const rpc: PresignedCoreRpc = async <T,>(method: string, params: unknown[] = []) => {
    try {
      const value = await host.rpc(method, params);
      if (method === 'getblockchaininfo') return { ...value, chain: 'signet' } as T;
      if (method === 'getblockhash' && params[0] === 0) return genesisHash('signet') as T;
      return value as T;
    } catch (error) { throw Object.assign(new Error('isolated test RPC failed'), { code: (error as { rpcCode?: number }).rpcCode }); }
  };
  const backend = createPresignedCoreBackend({ network: 'signet', genesisHash: genesisHash('signet'), rpc });
  const lost = new Set<string>(); const submissions = new Map<string, number>();
  const sendAttempts = new Map<string, number>(); const allocationSignRequests = new Map<string, number>();
  const csvBoundaryRecords = new Map<string, CsvBoundaryRecord>();
  let backupGateChecks = 0; let walletCalls = 0; let finalReturnPendingChecks = 0; let historicalIntentRefusals = 0;
  let primaryLossRestorations = 0; let initializationInterruptions = 0; let nativeTargetsCreated = 0;
  let initializationTargetFault = true; let initializationBackupFault = true; let durableSendChecks = 0;
  const submittedTransactionIds = new Set<string>();
  // Hash only public allocation journals, never kits' separate wrapping keys.
  // Every later invocation must preserve the exact bytes already published.
  const immutableAllocationFiles = new Map<string, string>();
  const checkAllocationJournal = () => {
    if (!existsSync(`${directory}/allocations`)) return;
    for (const [name, digest] of immutableAllocationFiles) {
      assert(existsSync(`${directory}/allocations/${name}`), 'a committed allocation file disappeared');
      assert.equal(createHash('sha256').update(readFileSync(`${directory}/allocations/${name}`)).digest('hex'), digest,
        'a committed allocation file changed during resumption');
    }
    for (const name of readdirSync(`${directory}/allocations`).filter(name => /^(?:case-(?:0[0-9]|1[0-8])|return)\.(?:intent|signed)\.json$/u.test(name))) {
      readLifecycleFile(directory, `allocations/${name}`); // Enforce owner-only, bounded, no-follow reads.
      immutableAllocationFiles.set(name, createHash('sha256').update(readFileSync(`${directory}/allocations/${name}`)).digest('hex'));
    }
  };
  const allocationForTxid = (txid: string) => ALLOCATION_IDS.find(id => existsSync(`${directory}/allocations/${id}.intent.json`) &&
    readLifecycleFile<RecyclingIntent>(directory, `allocations/${id}.intent.json`).txid === txid);
  const interruptedRpc: LiveLifecycleCore['rpc'] = async (method, params = []) => {
    let txid: string | undefined;
    if (method === 'submitpackage' || method === 'sendrawtransaction') {
      const hex = method === 'submitpackage' ? (params[0] as string[]).at(-1)! : params[0] as string;
      for (const transactionHex of method === 'submitpackage' ? params[0] as string[] : [hex])
        submittedTransactionIds.add(bitcoin.Transaction.fromHex(transactionHex).getId());
      txid = bitcoin.Transaction.fromHex(hex).getId(); sendAttempts.set(txid, (sendAttempts.get(txid) ?? 0) + 1);
      const checkpoint = core.durableJournal.assertCurrent().snapshot; assert(checkpoint);
      assert(checkpoint.files.some(file => file.path === 'wallet-recovery.json'));
      assert(checkpoint.files.filter(file => file.path.startsWith('events/')).some(file => {
        const intent = readLifecycleFile<{ kind: string; txid?: string; childTxid?: string }>(directory, file.path);
        return (intent.kind === 'submit-intent' && intent.txid === txid) || (intent.kind === 'fee-submit-intent' && intent.childTxid === txid);
      }), 'public-chain path would send without an independently checkpointed exact transaction intent');
      durableSendChecks++;
      const allocationId = allocationForTxid(txid);
      if (allocationId) {
        assert.equal(method, 'sendrawtransaction');
        const intent = readLifecycleFile<RecyclingIntent>(directory, `allocations/${allocationId}.intent.json`);
        const signed = readLifecycleFile<RecyclingSigned>(directory, `allocations/${allocationId}.signed.json`);
        validateSignedRecycling(intent, signed);
        assert.equal(signed.transactionHex, hex, 'allocation broadcast preceded its exact durable signed journal');
        checkAllocationJournal();
      }
    }
    const result = await rpc(method, params);
    if (txid) {
      submissions.set(txid, (submissions.get(txid) ?? 0) + 1);
      let label: string | null = null;
      if (method === 'submitpackage' && existsSync(`${directory}/cases/case-00/fee-funding.json`)) {
        const pair = readLifecycleFile<{ initial: PresignedFeePackage; replacement: PresignedFeePackage }>(directory, 'cases/case-00/fee-funding.json');
        if (validatePresignedFeePackage(pair.initial).completed.txid === txid) label = 'initial-fee-response';
        if (validatePresignedFeePackage(pair.replacement).completed.txid === txid) label = 'replacement-fee-response';
      }
      if (method === 'sendrawtransaction' && existsSync(`${directory}/cases/case-01/funding.json`) &&
        readLifecycleFile<{ txid: string }>(directory, 'cases/case-01/funding.json').txid === txid) label = 'funding-response';
      const allocationId = allocationForTxid(txid);
      if (allocationId === 'case-01') label = 'allocation-send-response';
      if (allocationId === 'return') label = 'final-return-send-response';
      if (label && !lost.has(label)) { lost.add(label); throw new Error(LOST_RESPONSE); }
    }
    return result;
  };
  const walletRpc: LiveLifecycleCore['walletRpc'] = async (method, params = []) => {
    walletCalls++;
    assert(['getnewaddress', 'getaddressinfo', 'walletprocesspsbt', 'backupwallet'].includes(method),
      'lifecycle attempted wallet coin selection, key import/export, or an unexpected wallet mutation');
    if (method === 'getnewaddress' && nativeTargetsCreated === 7 && initializationTargetFault) {
      initializationTargetFault = false; throw new Error(INTERRUPTED_INITIALIZATION);
    }
    if (method === 'backupwallet' && initializationBackupFault) {
      initializationBackupFault = false; throw new Error(INTERRUPTED_INITIALIZATION);
    }
    if (method === 'backupwallet') assert(typeof params[0] === 'string' && params[0].startsWith(`${backupDirectory}/wallet-restore-proof.`) &&
      params[0].endsWith('/wallet.dat'), 'native test-wallet backup escaped its private scope');
    let allocationId: string | undefined;
    if (method === 'walletprocesspsbt') {
      const checkpoint = core.durableJournal.assertCurrent().snapshot; assert(checkpoint);
      assert(checkpoint.files.some(file => file.path === 'wallet-recovery.json'), 'wallet signing lacks its independently verified full native backup');
      const tx = bitcoin.Transaction.fromBuffer(bitcoin.Psbt.fromBase64(params[0] as string).data.globalMap.unsignedTx.toBuffer());
      if (tx.version === 2) {
        allocationId = allocationForTxid(tx.getId()); assert(allocationId, 'allocation signing preceded its immutable intent');
        const intent = validateRecyclingIntent(readLifecycleFile<RecyclingIntent>(directory, `allocations/${allocationId}.intent.json`));
        assert.equal(tx.toHex(), intent.unsignedTransactionHex);
        assert(!existsSync(`${directory}/allocations/${allocationId}.signed.json`), 'already journaled allocation was signed again');
        assert(intent.inputs.every(coin => !excludedWalletCoins.has(coinId(coin))), 'allocation selected an unrelated wallet coin');
        allocationSignRequests.set(allocationId, (allocationSignRequests.get(allocationId) ?? 0) + 1);
        checkAllocationJournal();
      }
      if (tx.version === 3 && tx.ins.length === 3) {
        const item = readdirSync(`${directory}/cases`).find(id => existsSync(`${directory}/cases/${id}/kit.json`) &&
          readLifecycleFile<PresignedPublicKit>(directory, `cases/${id}/kit.json`).graph.fundingTxid === tx.getId()); assert(item);
        const receipts = readLifecycleFile<{ proofs: unknown[]; restoredBeforeWalletSigning: boolean }>(directory, `cases/${item}/backup-receipts.json`);
        assert(receipts.restoredBeforeWalletSigning && receipts.proofs.length === 3);
        assert(existsSync(`${directory}/cases/${item}/wallet-signing-intent.json`));
        assert(checkpoint.files.some(file => file.path === `cases/${item}/independent-restoration.json`),
          'funding wallet signing preceded actual independent complete-case restoration');
        for (const id of ['alice', 'bob', 'carol']) assert(existsSync(`${directory}/cases/${item}/${id}.encrypted.json`) &&
          existsSync(`${directory}/keys/${item}-${id}.json`));
        backupGateChecks++;
      }
    }
    const result = await host.walletRpc(method, params);
    if (method === 'getnewaddress') nativeTargetsCreated++;
    if (allocationId === 'case-01' && !lost.has('allocation-sign-response')) {
      lost.add('allocation-sign-response'); throw new Error(LOST_RESPONSE);
    }
    return result;
  };
  const core: LiveLifecycleCore = { rpc: interruptedRpc, walletRpc, observeCoin: point => backend.observeConfirmedCoin(point),
    chain: 'isolated-regtest', actualGenesisHash: await host.rpc('getblockhash', [0]), sourceDigest: presignedSourceDigest(),
    durableJournal: createDurableLifecycleJournal(directory, backupDirectory, anchorDirectory, {
      chain: 'isolated-regtest', actualGenesisHash: await host.rpc('getblockhash', [0]), sourceDigest: presignedSourceDigest() }),
    restorationParent, nativeWalletBackup: {
      binary: process.env.BITCOIN_CORE_BIN ?? '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind',
      binarySha256: createHash('sha256').update(readFileSync(process.env.BITCOIN_CORE_BIN ??
        '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind')).digest('hex'), parentDirectory: backupDirectory } };
  const losePrimaryAndRestore = async () => {
    const previous = directory; const retained = `${previous}.retained-${randomUUID()}`;
    const checkpoint = core.durableJournal.assertCurrent().snapshot; assert(checkpoint);
    renameSync(previous, retained);
    const restored = await restoreLifecyclePrimary(previous, backupDirectory, anchorDirectory, restorationParent, {
      sourceDigest: core.sourceDigest, chain: core.chain, actualGenesisHash: core.actualGenesisHash },
    async journal => { await verifyRestoredLiveLifecycleCustody({ ...core, durableJournal: journal }, journal.directory); });
    assert.equal(restored.journal.assertCurrent().snapshot?.checkpointDigest, checkpoint.checkpointDigest);
    assert.equal(restored.journal.directory, previous);
    directory = previous; core.durableJournal = restored.journal; primaryLossRestorations++;
  };
  for (const capitalLimitSats of [MINIMUM_SEQUENTIAL_CAPITAL - 1, CAPITAL_SATS - 1]) {
    const rejectedDirectory = mkdtempSync('/tmp/btc-presigned-live-capital-refusal.');
    const callsBefore = walletCalls;
    await assert.rejects(() => initializeLiveLifecycle(core, rejectedDirectory, { capitalLimitSats, initialOutpoint: seed }),
      /capital budget/u);
    assert(!existsSync(`${rejectedDirectory}/run.json`));
    assert.equal(walletCalls, callsBefore, 'insufficient capital touched the wallet');
    assert.equal(sendAttempts.size, 0, 'insufficient capital attempted a broadcast');
  }
  const initializationOptions = { capitalLimitSats: CAPITAL_SATS, initialOutpoint: seed };
  await assert.rejects(() => initializeLiveLifecycle(core, directory, initializationOptions), new RegExp(INTERRUPTED_INITIALIZATION, 'u'));
  initializationInterruptions++;
  assert.equal(nativeTargetsCreated, 7); assert(!existsSync(`${directory}/run.json`));
  const originalTargets = readdirSync(`${directory}/initialization`).filter(name => name.startsWith('wallet-target-'))
    .map(name => ({ name, digest: createHash('sha256').update(readFileSync(`${directory}/initialization/${name}`)).digest('hex') }));
  await losePrimaryAndRestore();
  await assert.rejects(() => initializeLiveLifecycle(core, directory, initializationOptions), new RegExp(INTERRUPTED_INITIALIZATION, 'u'));
  initializationInterruptions++;
  assert.equal(nativeTargetsCreated, 82); assert(existsSync(`${directory}/run.json`) && !existsSync(`${directory}/wallet-recovery.json`));
  assert.equal(sendAttempts.size, 0);
  const beforeIncompleteProof = walletCalls;
  await assert.rejects(() => fundLiveLifecycle(core, directory)); assert.equal(walletCalls, beforeIncompleteProof);
  await assert.rejects(() => initializeLiveLifecycle(core, directory, { ...initializationOptions, capitalLimitSats: CAPITAL_SATS + 1 }),
    /exact original capital approval/u);
  assert.equal(walletCalls, beforeIncompleteProof);
  const initialized = await initializeLiveLifecycle(core, directory, initializationOptions);
  assert.equal(nativeTargetsCreated, 82);
  for (const target of originalTargets) assert.equal(createHash('sha256').update(readFileSync(`${directory}/initialization/${target.name}`)).digest('hex'), target.digest);
  assert.equal(initialized.cases, 19);
  assert.equal(initialized.initialCapitalSats, CAPITAL_SATS); assert.equal(initialized.capitalLimitSats, CAPITAL_SATS);
  assert.equal(initialized.maximumUniqueConfirmedFeesSats, FIXED_CONFIRMED_FEES_SATS + 20 * RECYCLING_FEE_CAP);
  const fanout = await fundLiveLifecycle(core, directory); assert.equal(fanout.fanout, 'submitted');
  assert.equal((await fundLiveLifecycle(core, directory)).fanout, 'pending');
  await host.mine();
  mkdirSync(`${directory}/cases/case-00`, { mode: 0o700 });
  saveLifecycleFile(directory, 'cases/case-00/uncommitted.json', { incompleteBeforeFundingSignatures: true });
  let result: Awaited<ReturnType<typeof advanceLiveLifecycle>> | undefined;
  let advanceInvocations = 0;
  for (let iteration = 0; iteration < 250; iteration++) {
    // After the first case has genuinely settled, corrupt only its public
    // historical approval journal, before the next allocation is committed.
    // Missing/mismatched approval must fail before another wallet call or send.
    if (historicalIntentRefusals === 0 && existsSync(`${directory}/cases/case-00/fee-final-sweep.json`) &&
      !existsSync(`${directory}/allocations/case-01.intent.json`)) {
      const pair = readLifecycleFile<{ replacement: PresignedFeePackage }>(directory, 'cases/case-00/fee-final-sweep.json');
      const terminalChild = validatePresignedFeePackage(pair.replacement).completed;
      const observation = await host.rpc('getrawtransaction', [terminalChild.txid, true]);
      if (observation.confirmations > 0) {
        mkdirSync(`${directory}/journal-test-fixtures`, { mode: 0o700 });
        const name = 'cases/case-00/wallet-signing-intent.json';
        const originalPath = `${directory}/${name}`;
        const retainedPath = `${directory}/journal-test-fixtures/original-wallet-signing-intent.json`;
        const original = readLifecycleFile<{ graphDigest: string; fundingTxid: string; backupsVerified: boolean }>(directory, name);
        const originalDigest = createHash('sha256').update(readFileSync(originalPath)).digest('hex');
        const assertNoNewAuthority = (walletCallsBefore: number, attemptsBefore: Array<[string, number]>) => {
          assert.equal(walletCalls, walletCallsBefore, 'invalid historical funding intent reached the wallet');
          assert.deepEqual([...sendAttempts.entries()], attemptsBefore, 'invalid historical funding intent attempted a send');
          assert(!existsSync(`${directory}/allocations/case-01.intent.json`), 'invalid historical intent committed a new allocation');
          assert.equal(createHash('sha256').update(readFileSync(originalPath)).digest('hex'), originalDigest, 'historical intent was not restored byte-for-byte');
          checkAllocationJournal();
        };
        let walletCallsBefore = walletCalls; let attemptsBefore = [...sendAttempts.entries()];
        renameSync(originalPath, retainedPath);
        try {
          await assert.rejects(() => advanceLiveLifecycle(core, directory), /committed lifecycle bytes are missing or changed/u);
        } finally { renameSync(retainedPath, originalPath); }
        assertNoNewAuthority(walletCallsBefore, attemptsBefore); historicalIntentRefusals++;

        walletCallsBefore = walletCalls; attemptsBefore = [...sendAttempts.entries()];
        renameSync(originalPath, retainedPath);
        try {
          saveLifecycleFile(directory, name, { ...original, graphDigest: '00'.repeat(32) });
          await assert.rejects(() => advanceLiveLifecycle(core, directory), /committed lifecycle bytes are missing or changed/u);
        } finally {
          if (existsSync(originalPath)) renameSync(originalPath, `${directory}/journal-test-fixtures/mismatched-wallet-signing-intent.json`);
          renameSync(retainedPath, originalPath);
        }
        assertNoNewAuthority(walletCallsBefore, attemptsBefore); historicalIntentRefusals++;
        console.log(JSON.stringify({ stage: 'historical-intent-refusals-before-recycling', rejected: historicalIntentRefusals,
          extraWalletCalls: 0, extraBroadcastAttempts: 0, originalBytesRestored: true }));
      }
    }
    // Every invocation reloads all durable state: no in-process journal cache.
    advanceInvocations++; checkAllocationJournal();
    try { result = await advanceLiveLifecycle(core, directory); checkAllocationJournal(); }
    catch (error) {
      checkAllocationJournal();
      if (!(error instanceof Error) || error.message !== LOST_RESPONSE) throw error;
      if (lost.has('initial-fee-response') && primaryLossRestorations === 1) {
        // The actual funding/child was already accepted. Remove the ENTIRE
        // primary from its expected path and resume only from backup + anchor.
        await losePrimaryAndRestore(); checkAllocationJournal();
      }
      console.log(JSON.stringify({ stage: 'resumable-runner-lost-response', observedFaults: lost.size })); continue;
    }
    console.log(JSON.stringify({ stage: 'resumable-runner-advance', iteration, complete: result.complete }));
    if (custodySmoke && primaryLossRestorations === 2 && lost.has('replacement-fee-response')) {
      const custody = await verifyRestoredLiveLifecycleCustody(core, directory);
      assert.equal(custody.nativeWalletProof?.actualRestoredNativeSignatures, 83);
      assert.equal(custody.completeParticipantKitsRestored, 3);
      assert([...sendAttempts.values()].every(count => count === 1));
      console.log(JSON.stringify({ passed: true, scope: 'isolated-durable-custody-smoke-only', primaryLossRestorations,
        initializationInterruptions, actualNativeWalletRestoredSignatures: 83, participantKitsRestored: 3,
        initialFundingAndReplacementReconciled: true, duplicateSends: 0, fullLifecycleAcceptanceCompleted: false,
        realDefaultSignetVerified: false, publicNetworkBroadcasts: 0, coreVersion: host.coreVersion, evidence: directory }));
      return;
    }
    if (result.complete) break;
    if (existsSync(`${directory}/allocations/return.signed.json`) && finalReturnPendingChecks === 0) {
      const finalReturn = readLifecycleFile<RecyclingSigned>(directory, 'allocations/return.signed.json');
      const observation = await host.rpc('getrawtransaction', [finalReturn.txid, true]);
      assert(!observation.blockhash && !(observation.confirmations > 0));
      const attempts = [...sendAttempts.entries()];
      assert.equal((await advanceLiveLifecycle(core, directory)).complete, false, 'mempool return was mistaken for completed acceptance');
      assert.deepEqual([...sendAttempts.entries()], attempts, 'pending final return was resubmitted');
      finalReturnPendingChecks++;
    }
    const waitingCsv = result.statuses.filter(item => item.status === 'waiting-csv');
    assert(waitingCsv.length <= 1, 'sequential run has multiple active CSV waits');
    if (waitingCsv.length === 1) {
      const waiting = waitingCsv[0]!;
      assert(waiting.stage === 'recovery' && 'sourceConfirmations' in waiting);
      assert(!csvBoundaryRecords.has(waiting.case), 'one recovery case repeated its maturity boundary');
      const plan = readLifecycleFile<RunEvidence>(directory, 'run.json').cases.find(item => item.id === waiting.case);
      assert(plan?.kind === 'recovery');
      const kit = readLifecycleFile<PresignedPublicKit>(directory, `cases/${waiting.case}/kit.json`);
      const delayBlocks = kit.graph.roster.economics.recoveryDelayBlocks; assert.equal(delayBlocks, 12);
      const signedName = `cases/${waiting.case}/step-terminal.json`;
      const signed = readLifecycleFile<StoredSigned & { proposal: PresignedSpendProposal }>(directory, signedName);
      assert(signed.proposal.kind === 'recovery' && signed.proposal.sourceExitId === plan.source);
      const transaction = bitcoin.Transaction.fromHex(signed.transactionHex);
      assert.equal(transaction.getId(), signed.txid); assert.equal(transaction.version, 3);
      assert.equal(transaction.ins.length, 1); assert.equal(transaction.ins[0]!.sequence, delayBlocks);
      assert.equal(inputId(transaction.ins[0]!), coinId(signed.proposal.source));
      const source = await backend.observeConfirmedCoin(signed.proposal.source);
      assert.equal(source.confirmations, waiting.sourceConfirmations);
      assert(source.confirmations >= 1 && source.confirmations < delayBlocks);
      assert.equal(source.valueSats, signed.proposal.source.valueSats);
      assert.equal(source.scriptPubKeyHex, signed.proposal.source.scriptPubKeyHex);
      assert.equal((await host.rpc('getrawmempool')).length, 0, 'CSV batch could prematurely confirm a pending fee replacement');

      // Test-only mining acceleration: the exact saved transaction has already
      // received a genuine premature rejection from the normal advance path.
      // Mine real blocks up to depth11, recheck those same bytes immediately
      // before maturity, then mine one block to depth12 and check them again.
      // Every normal maturity, signature, hostile, and broadcast gate still
      // runs on the next unchanged advance; no public chain can be mined here.
      const blocksToJustBefore = delayBlocks - 1 - source.confirmations;
      if (blocksToJustBefore > 0) assert.equal((await host.mine(blocksToJustBefore)).length, blocksToJustBefore);
      const justBefore = await backend.observeConfirmedCoin(signed.proposal.source);
      assert.equal(justBefore.confirmations, delayBlocks - 1);
      assert.equal(justBefore.confirmationBlockHash, source.confirmationBlockHash);
      const beforeBytes = readLifecycleFile<StoredSigned>(directory, signedName).transactionHex;
      assert.equal(beforeBytes, signed.transactionHex);
      const negative = await host.rpc('testmempoolaccept', [[beforeBytes]]);
      assert.equal(negative.length, 1); assert.equal(negative[0].txid, signed.txid);
      assert.equal(negative[0].allowed, false); assert.equal(negative[0]['reject-reason'], 'non-BIP68-final');

      assert.equal((await host.mine(1)).length, 1);
      const mature = await backend.observeConfirmedCoin(signed.proposal.source);
      assert.equal(mature.confirmations, delayBlocks); assert.equal(mature.confirmationBlockHash, source.confirmationBlockHash);
      const matureBytes = readLifecycleFile<StoredSigned>(directory, signedName).transactionHex;
      assert.equal(matureBytes, signed.transactionHex);
      const positive = await host.rpc('testmempoolaccept', [[matureBytes]]);
      assert.equal(positive.length, 1); assert.equal(positive[0].txid, signed.txid); assert.equal(positive[0].allowed, true);
      const record: CsvBoundaryRecord = { caseId: waiting.case, delayBlocks, sourceTxid: source.txid, sourceVout: source.vout,
        sourceAnchor: source.confirmationBlockHash, initialConfirmations: source.confirmations,
        justBeforeConfirmations: justBefore.confirmations, maturityConfirmations: mature.confirmations,
        transactionTxid: signed.txid, transactionSha256: createHash('sha256').update(Buffer.from(signed.transactionHex, 'hex')).digest('hex'),
        justBeforeMaturityRejected: negative[0].allowed === false && negative[0]['reject-reason'] === 'non-BIP68-final',
        matureTransactionAllowed: positive[0].allowed === true,
        sameStoredTransactionBytes: beforeBytes === signed.transactionHex && matureBytes === signed.transactionHex };
      saveLifecycleFile(directory, `cases/${waiting.case}/csv-boundary-test.json`, record);
      csvBoundaryRecords.set(waiting.case, record);
      console.log(JSON.stringify({ stage: 'exact-csv-boundary-verified', cases: csvBoundaryRecords.size,
        delayBlocks: record.delayBlocks, justBeforeConfirmations: record.justBeforeConfirmations,
        maturityConfirmations: record.maturityConfirmations, sameStoredTransactionBytes: record.sameStoredTransactionBytes }));
      continue; // Remain at depth12 until the next normal advance tests/submits.
    }
    await host.mine();
  }
  assert(result?.complete && 'soloOrderingsConfirmed' in result);
  assert.equal(result.soloOrderingsConfirmed, 6); assert.equal(result.cooperativeRoundsConfirmed, 4); assert.equal(result.recoverySubsetsConfirmed, 9);
  assert.equal(result.realDefaultSignetVerified, false);
  assert.equal(result.feeLifecycleEvidence, true); assert.equal(result.feeEvidence.length, 5);
  assert(advanceInvocations > 25, 'sequential CSV cases were silently parallelized or skipped');
  assert.deepEqual([...lost].sort(), ['initial-fee-response', 'replacement-fee-response', 'funding-response',
    'allocation-sign-response', 'allocation-send-response', 'final-return-send-response'].sort());
  assert.equal(backupGateChecks, 19); assert.equal(finalReturnPendingChecks, 1); assert.equal(historicalIntentRefusals, 2);
  assert.equal(allocationSignRequests.size, 20);
  assert.equal(allocationSignRequests.get('case-01'), 2, 'lost wallet response did not retry the committed allocation');
  assert([...allocationSignRequests].every(([id, count]) => count === (id === 'case-01' ? 2 : 1)));
  assert.equal(readdirSync(`${directory}/interrupted`).length, 1);
  assert([...submissions.values()].every(count => count === 1), 'a lost reply caused a duplicate send');
  assert([...sendAttempts.values()].every(count => count === 1), 'a lost reply caused a duplicate send attempt');
  const resumed = await advanceLiveLifecycle(core, directory);
  assert.deepEqual(resumed, result, 'repeat completed observation changed evidence');
  assert.equal((await host.rpc('getrawmempool')).length, 0);
  const run = readLifecycleFile<RunEvidence>(directory, 'run.json');
  assert.equal(run.execution, LIVE_CAPITAL_EXECUTION);
  assert.equal(run.initialCapitalSats, CAPITAL_SATS); assert.equal(run.capitalLimitSats, CAPITAL_SATS);
  assert.equal(coinId(run.initialCoin), coinId(seed)); assert.equal(run.sourceDigest, core.sourceDigest);
  assert.deepEqual(run.cases.map(item => item.id), CASE_IDS);
  for (const item of run.cases) {
    const receipt = readLifecycleFile<{ restoredBeforeWalletSigning: boolean; proofs: Array<{ exitProofs: unknown[] }> }>(directory, `cases/${item.id}/backup-receipts.json`);
    assert(receipt.restoredBeforeWalletSigning && receipt.proofs.length === 3 && receipt.proofs.every(proof => proof.exitProofs.length === 3));
  }
  const csvRecords = [...csvBoundaryRecords.values()];
  assert.deepEqual([...csvBoundaryRecords.keys()].sort(), run.cases.filter(item => item.kind === 'recovery').map(item => item.id).sort());
  assert.equal(csvRecords.length, 9);
  for (const record of csvRecords) {
    assert.equal(record.delayBlocks, 12); assert.equal(record.justBeforeConfirmations, 11); assert.equal(record.maturityConfirmations, 12);
    assert.deepEqual(readLifecycleFile<CsvBoundaryRecord>(directory, `cases/${record.caseId}/csv-boundary-test.json`), record);
    const retained = readLifecycleFile<StoredSigned>(directory, `cases/${record.caseId}/step-terminal.json`);
    assert.equal(retained.txid, record.transactionTxid);
    assert.equal(createHash('sha256').update(Buffer.from(retained.transactionHex, 'hex')).digest('hex'), record.transactionSha256);
  }
  const csvBoundaryAudit = { cases: csvRecords.length, delayBlocks: csvRecords[0]!.delayBlocks,
    justBeforeMaturityRejected: csvRecords.filter(record => record.justBeforeMaturityRejected && record.justBeforeConfirmations === record.delayBlocks - 1).length,
    matureTransactionsAllowed: csvRecords.filter(record => record.matureTransactionAllowed && record.maturityConfirmations === record.delayBlocks).length,
    sameStoredTransactionBytes: csvRecords.every(record => record.sameStoredTransactionBytes) };
  assert.deepEqual(csvBoundaryAudit, { cases: 9, delayBlocks: 12, justBeforeMaturityRejected: 9,
    matureTransactionsAllowed: 9, sameStoredTransactionBytes: true });

  // Independently reconstruct the entire confirmed money trail from raw bytes.
  // Do not derive conservation from the producer's summary or its fee fields.
  const rawCache = new Map<string, bitcoin.Transaction>();
  const rawTransaction = async (txid: string) => {
    let tx = rawCache.get(txid);
    if (!tx) { tx = bitcoin.Transaction.fromHex((await host.rpc('getrawtransaction', [txid, true])).hex); rawCache.set(txid, tx); }
    assert.equal(tx.getId(), txid); return tx;
  };
  const confirmedFees = new Map<string, number>();
  const actualConfirmedFee = async (signed: StoredSigned) => {
    assert(!confirmedFees.has(signed.txid), 'confirmed fee audit counted a transaction twice');
    const observation = await host.rpc('getrawtransaction', [signed.txid, true]);
    assert(observation.confirmations > 0 && observation.blockhash);
    const header = await host.rpc('getblockheader', [observation.blockhash]);
    assert(header.confirmations > 0 && await host.rpc('getblockhash', [header.height]) === observation.blockhash);
    assert.equal(observation.hex, signed.transactionHex);
    const tx = await rawTransaction(signed.txid); let inputSats = 0;
    for (const input of tx.ins) {
      const parent = await rawTransaction(Buffer.from(input.hash).reverse().toString('hex'));
      assert(parent.outs[input.index]); inputSats += Number(parent.outs[input.index]!.value);
    }
    const fee = inputSats - sumOutputs(tx); assert(fee > 0); confirmedFees.set(signed.txid, fee); return fee;
  };
  const allocations = ALLOCATION_IDS.map(id => {
    const intent = validateRecyclingIntent(readLifecycleFile<RecyclingIntent>(directory, `allocations/${id}.intent.json`));
    const signed = validateSignedRecycling(intent, readLifecycleFile<RecyclingSigned>(directory, `allocations/${id}.signed.json`));
    assert.equal(intent.id, id); assert.equal(intent.sourceDigest, core.sourceDigest);
    assert.equal(intent.maximumFeeSats, RECYCLING_FEE_CAP); assert(intent.feeSats <= 338);
    assert(intent.inputs.every(coin => !excludedWalletCoins.has(coinId(coin))));
    assert.equal(intent.previousCaseDigest === null, id === 'case-00');
    assert.throws(() => validateRecyclingIntent({ ...intent, feeSats: intent.feeSats + 1 }));
    assert.throws(() => validateRecyclingIntent({ ...intent, inputs: [...intent.inputs, intent.inputs[0]!] }));
    assert.throws(() => validateSignedRecycling(intent, { ...signed, intentDigest: '00'.repeat(32) }));
    return { intent, signed };
  });
  assert.equal(immutableAllocationFiles.size, 40);
  assert.deepEqual(allocations[0]!.intent.inputs.map(coinId), [coinId(seed)]);
  assert.equal(allocations[0]!.intent.inputSats, CAPITAL_SATS);
  let allocationFeesSats = 0; let fixedFeesSats = 0; let recycledParticipantPayouts = 0;
  const replacedFeeChildIds = new Set<string>();
  for (const allocation of allocations) {
    const fee = await actualConfirmedFee(allocation.signed); assert.equal(fee, allocation.intent.feeSats);
    assert(fee <= RECYCLING_FEE_CAP); allocationFeesSats += fee;
  }
  for (const [index, plan] of run.cases.entries()) {
    const current = allocations[index]!; const next = allocations[index + 1]!;
    const kit = readLifecycleFile<PresignedPublicKit>(directory, `cases/${plan.id}/kit.json`);
    assert.deepEqual(kit.graph.roster.economics, { depositSatsPerParticipant: 10_000, firstWithdrawalSats: 9500,
      secondWithdrawalSats: 10_250, soloWithdrawalFeeSats: 300, soloFeeBudgetSats: 2000,
      cooperativeFeeSats: 300, recoveryFeeSats: 500, finalSweepFeeSats: 300, recoveryDelayBlocks: 12 });
    const funding = readLifecycleFile<StoredSigned>(directory, `cases/${plan.id}/funding.json`);
    assert.equal(await actualConfirmedFee(funding), 600); fixedFeesSats += 600;
    assert(kit.graph.funding.inputs.every(input => input.txid === current.signed.txid));
    const transactions = [await rawTransaction(current.signed.txid), await rawTransaction(funding.txid)];
    const steps = caseSteps(plan);
    for (const [stepIndex, step] of steps.entries()) {
      const signed = readLifecycleFile<StoredSigned>(directory, `cases/${plan.id}/step-${step.replace('/', '-')}.json`);
      const fee = await actualConfirmedFee(signed);
      const expectedFee = plan.kind === 'solo-order' ? [300, 600, 300][stepIndex]
        : step === 'terminal' && plan.kind === 'recovery' ? 500 : 300;
      assert.equal(fee, expectedFee, `${plan.id}/${step} changed the agreed transaction economics`);
      fixedFeesSats += fee; transactions.push(await rawTransaction(signed.txid));
    }
    for (const family of FAMILIES) if (existsSync(`${directory}/cases/${plan.id}/fee-${family}.json`)) {
      const pair = readLifecycleFile<{ initial: PresignedFeePackage; replacement: PresignedFeePackage }>(directory, `cases/${plan.id}/fee-${family}.json`);
      replacedFeeChildIds.add(validatePresignedFeePackage(pair.initial).completed.txid);
      const replacement = validatePresignedFeePackage(pair.replacement).completed;
      const fee = await actualConfirmedFee(replacement); assert.equal(fee, 4000);
      fixedFeesSats += fee; transactions.push(await rawTransaction(replacement.txid));
    }
    const remaining = new Map<string, { valueSats: number; scriptPubKeyHex: string }>();
    for (const tx of transactions) tx.outs.forEach((output, vout) => remaining.set(`${tx.getId()}:${vout}`,
      { valueSats: Number(output.value), scriptPubKeyHex: Buffer.from(output.script).toString('hex') }));
    for (const tx of transactions) for (const input of tx.ins) remaining.delete(inputId(input));
    assert.deepEqual(next.intent.inputs.map(coinId).sort(), [...remaining.keys()].sort(),
      `${plan.id} did not recycle every terminal payout, refund, sponsor change and reserve exactly once`);
    const reserve = `${current.signed.txid}:${bitcoin.Transaction.fromHex(current.signed.transactionHex).outs.length - 1}`;
    assert(remaining.has(reserve) && next.intent.inputs.some(input => coinId(input) === reserve), 'unallocated reserve was lost');
    for (const coin of next.intent.inputs) {
      assert.deepEqual({ valueSats: coin.valueSats, scriptPubKeyHex: coin.scriptPubKeyHex }, remaining.get(coinId(coin)));
      if (coin.participantId !== null) {
        const participant = kit.graph.roster.participants.find(item => item.id === coin.participantId); assert(participant);
        const script = bitcoin.payments.p2tr({ internalPubkey: Buffer.from(participant.payoutXonlyPublicKeyHex, 'hex') }).output!;
        assert.equal(Buffer.from(script).toString('hex'), coin.scriptPubKeyHex); recycledParticipantPayouts++;
        const address = bitcoin.address.fromOutputScript(script, bitcoin.networks.regtest);
        assert.equal((await host.walletRpc('getaddressinfo', [address])).ismine, false, 'participant keys were imported into Core');
      }
    }
  }
  assert.equal(fixedFeesSats, FIXED_CONFIRMED_FEES_SATS);
  assert.equal(confirmedFees.size, 84, 'expected exactly 20 allocations, 19 funding transactions, 40 exits, and five confirmed fee children');
  assert.equal(replacedFeeChildIds.size, 5);
  assert([...sendAttempts.keys()].every(txid => confirmedFees.has(txid) || replacedFeeChildIds.has(txid)),
    'runner broadcast an extra transaction outside the independently audited lifecycle');
  assert.equal(recycledParticipantPayouts, 57, 'not all 57 independently restored participant payouts were recycled');
  const finalAllocation = allocations.at(-1)!;
  assert.deepEqual(finalAllocation.intent.targets, []);
  const finalTx = await rawTransaction(finalAllocation.signed.txid); assert.equal(finalTx.outs.length, 1);
  const returnedSats = Number(finalTx.outs[0]!.value);
  assert.equal(CAPITAL_SATS, returnedSats + fixedFeesSats + allocationFeesSats, 'the complete run imported or lost unaccounted capital');
  assert(returnedSats >= CAPITAL_SATS - FIXED_CONFIRMED_FEES_SATS - 20 * RECYCLING_FEE_CAP);
  const returnedCoin = await host.rpc('gettxout', [finalAllocation.signed.txid, 0, true]);
  assert(returnedCoin && returnedCoin.confirmations > 0 && Math.round(returnedCoin.value * 1e8) === returnedSats);
  const returnAddress = bitcoin.address.fromOutputScript(finalTx.outs[0]!.script, bitcoin.networks.regtest);
  assert.equal((await host.walletRpc('getaddressinfo', [returnAddress])).ismine, true);
  assert(allocations.slice(0, -1).every(item => item.intent.reserveScriptPubKeyHex !== finalAllocation.intent.reserveScriptPubKeyHex),
    'final return reused an earlier reserve address');
  const capitalAudit = { initialCapitalSats: CAPITAL_SATS, fixedConfirmedFeesSats: fixedFeesSats,
    allocationFeesSats, returnedSats, confirmedAllocations: allocations.length, recycledParticipantPayouts,
    unrelatedWalletInputsUsed: 0, allTerminalOutputsAndReservesConsumedExactlyOnce: true };

  const eventCount = readdirSync(`${directory}/events`).length;
  const submissionCounts = [...submissions.entries()];
  const verification = await verifyCompletedLiveLifecycle(core, directory);
  assert.equal(verification.realDefaultSignetVerified, false); assert.equal(verification.restoredKits, 57);
  assert.equal(verification.hostileRejections, 80); assert.equal(verification.feeFamiliesConfirmed, 5);
  assert.equal(verification.everyPayoutRefundAndSponsorChangeVerified, true);
  assert.equal(verification.durableCustodyEvidence.actualNativeWalletRestoredSignatures, 83);
  assert.equal(verification.durableCustodyEvidence.independentlyRestoredCasesBeforeFunding, 19);
  assert.equal(primaryLossRestorations, 2); assert.equal(initializationInterruptions, 2);
  assert.equal(durableSendChecks, 84); assert.equal(submittedTransactionIds.size, 89);
  assert.equal(readdirSync(`${directory}/events`).length, eventCount, 'read-only verification wrote a journal event');
  assert.deepEqual([...submissions.entries()], submissionCounts, 'read-only verification resubmitted a transaction');
  await assert.rejects(() => verifyCompletedLiveLifecycle({ ...core, sourceDigest: '00'.repeat(32) }, directory));
  renameSync(`${directory}/cases/case-00/alice.encrypted.json`, `${directory}/cases/case-00/alice.encrypted.retained`);
  try { await assert.rejects(() => verifyCompletedLiveLifecycle(core, directory)); }
  finally { renameSync(`${directory}/cases/case-00/alice.encrypted.retained`, `${directory}/cases/case-00/alice.encrypted.json`); }
  const lastBlock = await host.rpc('getbestblockhash');
  await host.rpc('invalidateblock', [lastBlock]);
  try { await assert.rejects(() => verifyCompletedLiveLifecycle(core, directory)); }
  finally { await host.rpc('reconsiderblock', [lastBlock]); }
  assert.equal((await verifyCompletedLiveLifecycle(core, directory)).everyPayoutRefundAndSponsorChangeVerified, true);
  checkAllocationJournal(); assert.equal(presignedSourceDigest(), core.sourceDigest, 'source changed during this acceptance run');
  host.record('resumable-lifecycle-runner', { passed: true, evidence: directory, lostRepliesWithoutResending: lost.size,
    lostReplyKinds: [...lost].sort(), sameTemplateWalletSigningRequestsAfterLostReply: allocationSignRequests.get('case-01'),
    preFundingBackupGateChecks: backupGateChecks, interruptedUncommittedCaseRetained: true,
    lowCapitalRefusalsBeforeWalletAccess: 2, historicalIntentRefusalsBeforeRecycling: historicalIntentRefusals,
    advanceInvocations, finalReturnPendingChecks, primaryLossRestorations, initializationInterruptions, durableSendChecks,
    immutablePublicAllocationFiles: immutableAllocationFiles.size, capitalAudit,
    readOnlyCompletionVerification: verification, readOnlyReorganizationAndMissingBackupRejections: true, ...resumed,
    csvBoundaryAudit, csvBoundaryRecords: csvRecords });
  console.log(JSON.stringify({ passed: true, evidence: directory, realDefaultSignetVerified: false, cases: 19,
    publicNetworkBroadcasts: 0, coreVersion: host.coreVersion, chain: 'isolated-regtest',
    feeFamilies: 5, lostRepliesWithoutResending: lost.size, capitalAudit, csvBoundaryAudit,
    durableCustodyAudit: { primaryLossRestorations, initializationInterruptions, durableSendChecks,
      uniqueSubmittedTransactions: submittedTransactionIds.size,
      actualNativeWalletRestoredSignatures: 83, independentlyRestoredCasesBeforeFunding: 19, nativeTargetsRegenerated: 0 } }));
}, { maximumMinutes: 90 });
