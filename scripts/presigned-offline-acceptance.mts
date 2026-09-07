import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type BrowserContext, type Page, type Download } from '@playwright/test';
import * as bitcoin from 'bitcoinjs-lib';
import { encryptPresignedOfflineBackup, serializePresignedOfflineBackup } from '../src/presigned/backup.js';
import { validatePresignedCoinObservations, type PresignedCoinObservations } from '../src/presigned/coin-observations.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { validatePresignedFeePackage } from '../src/presigned/fee-package.js';
import { authorizePresignedFundingSignedPsbt, finalizePresignedFunding } from '../src/presigned/funding.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { validatePresignedOfflineExchange, validatePresignedOfflineTransaction, type PresignedOfflineTransaction } from '../src/presigned/offline.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { nativeWalletWitnessFromPsbt } from '../src/presigned/wallet.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedPublicKit } from '../src/presigned/types.js';
import { withPresignedRegtest, type PresignedRegtest, type PresignedRegtestCoin } from './lib/presigned-regtest.js';

// Direct Playwright API: never enable traces, screenshots, videos or automatic
// error-context snapshots. Recovery keys are supplied to password inputs but
// must not be preserved in failure messages, artifacts, or public evidence.
process.umask(0o077);
const directory = mkdtempSync('/tmp/btc-presigned-offline.');
const artifact = resolve('public/offline/presigned-recovery.html');
const manifest = JSON.parse(readFileSync('public/offline/presigned-recovery.manifest.json', 'utf8'));
assert.equal(createHash('sha256').update(readFileSync(artifact)).digest('hex'), manifest.sha256);
const browser = await chromium.launch({ headless: true });
const actors: Actor[] = [];
const requests: string[] = [];
const errors: string[] = [];
const checks: string[] = [];
let stage = 'offline utility startup';
let signedTransactions = 0;
let restoredKits = 0;
const boundaryOnly = process.argv[2] === '--boundary-only';
const feesOnly = process.argv[2] === '--fees-only';
const lifecycle = !boundaryOnly && !feesOnly;
assert(process.argv.length === (boundaryOnly || feesOnly ? 3 : 2), 'unknown offline acceptance option');
let feeCases = 0;
let feeChildren = 0;
let failureDetail: { locations: Array<{ line: number; column: number }>; statuses: string[] } | null = null;
type Fixture = ReturnType<typeof createPresignedFixture>;
interface Actor { id: ParticipantId; context: BrowserContext; page: Page; kit: PresignedPublicKit; key: Uint8Array; encrypted: string }
const publicKit = (fixture: Fixture): PresignedPublicKit => ({ version: 2, protocol: PRESIGNED_PROTOCOL,
  graph: fixture.graph, preauthorizations: preauthorizePresignedFixture(fixture) });
async function secretInput(actor: Actor) {
  try { await actor.page.locator('#secret').fill(Buffer.from(actor.key).toString('base64url')); }
  catch { throw new Error('recovery-key input failed; private value redacted'); }
}
async function createActor(fixture: Fixture, id: ParticipantId): Promise<Actor> {
  const context = await browser.newContext({ acceptDownloads: true }); context.setDefaultTimeout(20_000);
  await context.setOffline(true);
  // Offline must be functional even when every HTTP(S) request is blocked.
  await context.route(/^https?:/u, route => { requests.push(new URL(route.request().url()).origin); return route.abort(); });
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('unexpected browser script error'));
  const kit = publicKit(fixture); const key = Uint8Array.from(randomBytes(32));
  const encrypted = serializePresignedOfflineBackup(await encryptPresignedOfflineBackup({ publicKit: kit,
    participantId: id, participantSecret: fixture.participantSecrets[id], offlineSecret: key }));
  const actor = { id, page, context, key, encrypted, kit }; actors.push(actor);
  await restoreActor(actor); return actor;
}
async function restoreActor(actor: Actor) {
  await actor.page.goto(pathToFileURL(artifact).href);
  await expect(actor.page.locator('#status')).toContainText('Local cryptography ready');
  await actor.page.locator('#backup').setInputFiles({ name: 'encrypted-kit.json', mimeType: 'application/json', buffer: Buffer.from(actor.encrypted) });
  await expect(actor.page.locator('#status')).toContainText('File header inspected');
  await actor.page.locator('#expected-graph').fill(actor.kit.graph.digest);
  await actor.page.locator('#expected-funding').fill(actor.kit.graph.fundingTxid);
  await secretInput(actor); await actor.page.locator('#verify').click();
  await expect(actor.page.locator('#status')).toContainText('Kit authenticated');
  assert.equal(await actor.page.locator('#secret').inputValue(), '');
  assert.equal(await actor.page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  restoredKits++;
}
async function closeActor(actor: Actor) { actor.key.fill(0); actor.encrypted = ''; await actor.context.close(); }
async function download(actor: Actor, button: string): Promise<string> {
  const pending = actor.page.waitForEvent('download');
  await actor.page.locator(button).click();
  const file = await pending; const stream = await file.createReadStream(); assert(stream);
  let raw = ''; for await (const part of stream) { raw += part.toString(); assert(raw.length <= 1_100_000); }
  return raw;
}
async function loadPublic(actor: Actor, input: string, content: unknown) {
  await actor.page.locator(input).setInputFiles({ name: 'public-peer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(content)) });
}
async function prepare(actor: Actor, kind: string, source: string) {
  await actor.page.locator('#spend-kind').selectOption(kind);
  await actor.page.locator('#source').selectOption(source);
  await actor.page.locator('#prepare').click();
  await expect(actor.page.locator('#status')).toContainText('Fixed transaction rebuilt');
  await actor.page.locator('#reviewed').check();
}
async function signedFile(actor: Actor): Promise<PresignedOfflineTransaction> {
  const value = validatePresignedOfflineTransaction(actor.kit, JSON.parse(await download(actor, '#save-transaction')));
  assert.equal(await actor.page.locator('#secret').inputValue(), '');
  return value;
}
async function single(actor: Actor, kind: 'solo' | 'final-sweep', source: string) {
  await prepare(actor, kind, source); await secretInput(actor); await actor.page.locator('#sign-single').click();
  await expect(actor.page.locator('#status')).toContainText('Exact transaction and signatures verified');
  return signedFile(actor);
}
async function peerFile(actor: Actor) { return validatePresignedOfflineExchange(actor.kit, JSON.parse(await download(actor, '#export-peer'))); }
async function importPeer(actor: Actor, incoming: unknown) {
  await loadPublic(actor, '#peer', incoming);
  await expect(actor.page.locator('#status')).toContainText('Public peer contributions verified');
  await actor.page.locator('#reviewed').check();
}
async function cooperate(group: Actor[], source: string, exerciseLostNonce: boolean): Promise<PresignedOfflineTransaction> {
  const leader = group[0]!; await prepare(leader, 'cooperative', source);
  let exchange = await peerFile(leader);
  for (const actor of group) {
    if (actor !== leader) await importPeer(actor, exchange);
    await secretInput(actor); await actor.page.locator('#nonce').click();
    await expect(actor.page.locator('#status')).toContainText('Public nonce added'); exchange = await peerFile(actor);
  }
  if (exerciseLostNonce) {
    const lost = group.at(-1)!;
    await restoreActor(lost); await importPeer(lost, exchange);
    await secretInput(lost); await lost.page.locator('#partial').click();
    await expect(lost.page.locator('#status')).toContainText('no unconsumed secret nonce');
    // A new ceremony preserves the exact unsigned payment but never copies
    // the lost/burned private nonce. All participants restart in fresh pages.
    const oldTxid = exchange.proposal.txid;
    for (const actor of group) await restoreActor(actor);
    const completed = await cooperate(group, source, false);
    assert.equal(completed.txid, oldTxid);
    checks.push('reloaded offline page cannot restore a secret nonce; fresh complete MuSig2 ceremony preserves the exact payment');
    return completed;
  }
  for (const actor of group) {
    await importPeer(actor, exchange);
    await secretInput(actor); await actor.page.locator('#partial').click();
    await expect(actor.page.locator('#status')).toContainText('Nonce consumed and partial verified');
    exchange = await peerFile(actor);
    await actor.page.locator('#partial').click();
    await expect(actor.page.locator('#status')).toContainText('no unconsumed secret nonce');
  }
  await importPeer(leader, exchange); await leader.page.locator('#finalize-peer').click();
  await expect(leader.page.locator('#status')).toContainText('Exact transaction and signatures verified');
  return signedFile(leader);
}
async function recover(group: Actor[], source: string) {
  const leader = group[0]!; await prepare(leader, 'recovery', source); let exchange = await peerFile(leader);
  for (const actor of group) {
    if (actor !== leader) await importPeer(actor, exchange);
    await secretInput(actor); await actor.page.locator('#recovery-share').click();
    await expect(actor.page.locator('#status')).toContainText('Recovery contribution verified'); exchange = await peerFile(actor);
  }
  await importPeer(leader, exchange); await leader.page.locator('#finalize-peer').click();
  await expect(leader.page.locator('#status')).toContainText('Exact transaction and signatures verified');
  return signedFile(leader);
}
async function observationsFor(core: PresignedRegtest, kit: PresignedPublicKit,
  coins: Array<Pick<PresignedRegtestCoin, 'txid' | 'vout'>>): Promise<PresignedCoinObservations> {
  const graph = kit.graph; const info = await core.rpc('getblockchaininfo');
  assert.equal(info.chain, 'regtest');
  const observed = []; const availability: PresignedCoinObservations['availability'] = [];
  for (const coin of coins) {
    const chain = await core.rpc('gettxout', [coin.txid, coin.vout, false]);
    assert(chain && chain.confirmations > 0 && chain.coinbase === false);
    const raw = await core.rpc('getrawtransaction', [coin.txid, true]);
    const block = await core.rpc('getblockheader', [raw.blockhash]);
    assert.equal(await core.rpc('getblockhash', [block.height]), raw.blockhash);
    observed.push({ ...coin, network: graph.roster.network, genesisHash: graph.roster.genesisHash,
      valueSats: Math.round(chain.value * 1e8), scriptPubKeyHex: chain.scriptPubKey.hex,
      confirmationBlockHash: raw.blockhash, confirmations: chain.confirmations, unspentInActiveChain: true as const, coinbase: false as const });
    const pending = await core.rpc('gettxspendingprevout', [[coin]]);
    const spendingTxid = pending[0].spendingtxid ?? null;
    availability.push({ ...coin, kind: spendingTxid ? 'mempool-spent' : 'available', spendingTxid });
  }
  assert.equal((await core.rpc('getblockchaininfo')).bestblockhash, info.bestblockhash);
  // Explicit TEST-ONLY format mapping: actual coins/anchors are regtest, never
  // call this synthetic identity bridge real Signet or a production receipt.
  return validatePresignedCoinObservations(graph, { version: 2, protocol: PRESIGNED_PROTOCOL,
    format: 'presigned-private-core-observations-v1', network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    tip: { network: graph.roster.network, genesisHash: graph.roster.genesisHash, hash: info.bestblockhash, height: info.blocks },
    observedAt: new Date().toISOString(), coins: observed, availability });
}
async function feeWallet(core: PresignedRegtest, actor: Actor, funding: boolean) {
  const unsigned = await download(actor, '#save-fee-psbt');
  await actor.page.locator('#fee-reviewed').check();
  if (!funding) {
    await secretInput(actor); await actor.page.locator('#sign-fee').click();
    await expect(actor.page.locator('#status')).toContainText('detached payout signature is ready');
  }
  const signed = await core.walletRpc('walletprocesspsbt', [unsigned, true, 'ALL', true, false]);
  // Real external-wallet import, not an injected browser signing substitute.
  await actor.page.locator('#wallet-fee-psbt').fill(signed.psbt);
  if (funding) await actor.page.locator('#funding-roles').selectOption('change,sponsor');
  await actor.page.locator('#import-fee-wallet').click();
  await expect(actor.page.locator('#status')).toContainText('External wallet signature(s) verified');
  const downloaded: Promise<string>[] = [];
  const listener = (file: Download) => {
    downloaded.push((async () => {
      const stream = await file.createReadStream(); assert(stream);
      let raw = ''; for await (const part of stream) { raw += part.toString(); assert(raw.length <= 1_100_000); } return raw;
    })());
  };
  actor.page.on('download', listener);
  try {
    await actor.page.locator('#finalize-fee').click();
    await expect(actor.page.locator('#status')).toContainText('Signed parent and child saved');
    await expect.poll(() => downloaded.length).toBe(2);
    const files = (await Promise.all(downloaded)).map(raw => JSON.parse(raw));
    const packageValue = files.find(value => value.mode);
    const checked = validatePresignedFeePackage(packageValue);
    const raw = files.find(value => value.format === 'presigned-offline-fee-transactions-v1');
    assert.deepEqual(raw.transactionHexes, [checked.parentTransactionHex, checked.completed.transactionHex]);
    assert.equal(raw.packageDigest, checked.packageDigest);
    return checked;
  } finally { actor.page.off('download', listener); }
}
async function feeCase(core: PresignedRegtest, kind: PresignedOfflineTransaction['kind'], walletKind: 'p2tr' | 'p2wpkh') {
  stage = `offline browser ${kind} fee rescue, ${walletKind} external wallet`;
  const fixture = createPresignedFixture();
  const scripts = [];
  for (let index = 0; index < 4; index++) {
    const address = await core.walletRpc('getnewaddress', ['offline-fee-acceptance', walletKind === 'p2tr' ? 'bech32m' : 'bech32']);
    scripts.push(Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex'));
  }
  const coins = await core.fundScripts(scripts.map((scriptPubKeyHex, index) => ({ scriptPubKeyHex, valueSats: index === 3 ? 20_000 : 12_000 })));
  await core.walletRpc('lockunspent', [false, coins.map(({ txid, vout }) => ({ txid, vout }))]);
  fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
    inputs: coins.slice(0, 3).map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
  const graph = fixture.graph;
  const walletSigned = bitcoin.Psbt.fromBase64((await core.walletRpc('walletprocesspsbt', [graph.fundingPsbtBase64, true, 'ALL', true, false])).psbt);
  const funding = finalizePresignedFunding({ graph, signatures: PARTICIPANT_IDS.map((id, index) => {
    const witness = nativeWalletWitnessFromPsbt(walletSigned.data.inputs[index]!);
    const single = bitcoin.Psbt.fromBase64(graph.fundingPsbtBase64);
    single.updateInput(index, { finalScriptWitness: Buffer.concat([Buffer.from([witness.length]),
      ...witness.flatMap(bytes => [Buffer.from([bytes.length]), bytes])]) });
    return authorizePresignedFundingSignedPsbt({ graph, participantId: id, approvedGraphDigest: graph.digest, signedPsbtBase64: single.toBase64() });
  }) });
  if (kind !== 'funding') { await core.rpc('sendrawtransaction', [funding.transactionHex]); await core.mine(); }
  let source = '';
  if (kind === 'final-sweep') {
    for (const id of ['alice','alice/bob']) {
      const exit = graph.exits.find(item => item.id === id)!;
      const signed = completePresignedExit({ graph, preauthorizations: publicKit(fixture).preauthorizations, exitId: id,
        participantId: exit.leaver, privateKey: fixture.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
      await core.rpc('sendrawtransaction', [signed.transactionHex]); await core.mine();
    }
    source = 'alice/bob';
  }
  if (kind === 'recovery') await core.mine(graph.roster.economics.recoveryDelayBlocks - 1);
  const ids: ParticipantId[] = kind === 'cooperative' ? [...PARTICIPANT_IDS] : kind === 'recovery' ? ['alice','bob'] : [kind === 'final-sweep' ? 'carol' : 'alice'];
  const group = await Promise.all(ids.map(id => createActor(fixture, id))); const actor = group[0]!;
  try {
    let parent: PresignedOfflineTransaction;
    if (kind === 'funding') {
      await actor.page.locator('#funding-hex').fill(funding.transactionHex); await actor.page.locator('#import-funding').click();
      await expect(actor.page.locator('#status')).toContainText('Exact transaction and signatures verified'); parent = await signedFile(actor);
    } else if (kind === 'solo' || kind === 'final-sweep') parent = await single(actor, kind, kind === 'solo' ? 'alice' : source);
    else if (kind === 'cooperative') parent = await cooperate(group, source, false);
    else parent = await recover(group, source);
    const parentTx = bitcoin.Transaction.fromHex(parent.transactionHex);
    const outpoints = [...parentTx.ins.map(input => ({ txid: Buffer.from(input.hash).reverse().toString('hex'), vout: input.index })),
      { txid: coins[3]!.txid, vout: coins[3]!.vout }];
    const report = await observationsFor(core, actor.kit, outpoints);
    await loadPublic(actor, '#fee-observations', report); await expect(actor.page.locator('#status')).toContainText('public coin observations');
    await actor.page.locator('#sponsor-txid').fill(coins[3]!.txid); await actor.page.locator('#sponsor-vout').fill(String(coins[3]!.vout));
    await actor.page.locator('#target-rate').fill('1000'); await actor.page.locator('#fee-cap').fill('5000');
    await actor.page.locator('#child-fee').fill('1000'); await actor.page.locator('#build-fee').click();
    await expect(actor.page.locator('#status')).toContainText('Exact fee child rebuilt');
    // A saved public draft survives closing the entire secret-bearing page.
    const draft = JSON.parse(await download(actor, '#save-fee-draft'));
    await restoreActor(actor); await loadPublic(actor, '#fee-draft-file', draft);
    await expect(actor.page.locator('#status')).toContainText('Exact fee child rebuilt');
    const first = await feeWallet(core, actor, kind === 'funding');
    assert.equal(first.parentTransactionHex, parent.transactionHex);
    const response = await core.rpc('submitpackage', [[parent.transactionHex, first.completed.transactionHex]]);
    assert.equal(response.package_msg, 'success', 'Core rejected exact offline parent/child package');
    assert(await core.rpc('getmempoolentry', [first.completed.txid]));
    // Only this explicitly named prior child may occupy the sponsor coin.
    await loadPublic(actor, '#transaction-file', parent); await expect(actor.page.locator('#status')).toContainText('Exact transaction and signatures verified');
    const pending = await observationsFor(core, actor.kit, outpoints);
    await loadPublic(actor, '#fee-observations', pending); await expect(actor.page.locator('#status')).toContainText('public coin observations');
    await actor.page.locator('#sponsor-txid').fill(coins[3]!.txid); await actor.page.locator('#sponsor-vout').fill(String(coins[3]!.vout));
    await actor.page.locator('#target-rate').fill('1000'); await actor.page.locator('#fee-cap').fill('5000');
    await actor.page.locator('#child-fee').fill('2000'); await actor.page.locator('#build-fee').click();
    await expect(actor.page.locator('#status')).toContainText('another mempool transaction');
    await actor.page.locator('#previous-child').fill(first.completed.transactionHex); await actor.page.locator('#build-fee').click();
    await expect(actor.page.locator('#status')).toContainText('Exact fee child rebuilt');
    const replacement = await feeWallet(core, actor, kind === 'funding');
    assert.equal(replacement.parentTransactionHex, parent.transactionHex);
    assert.equal((await core.rpc('submitpackage', [[parent.transactionHex, replacement.completed.transactionHex]])).package_msg, 'success');
    const mempool = await core.rpc('getrawmempool');
    assert(!mempool.includes(first.completed.txid) && mempool.includes(replacement.completed.txid));
    const child = bitcoin.Transaction.fromHex(replacement.completed.transactionHex);
    const original = bitcoin.Transaction.fromHex(first.completed.transactionHex);
    assert.deepEqual(child.outs[0], original.outs[0]);
    await core.mine(); assert((await core.rpc('getrawtransaction', [replacement.completed.txid, true])).confirmations >= 1);
    assert((await core.rpc('getrawtransaction', [parent.txid, true])).confirmations >= 1);
    // First child was Core-accepted then replaced, not falsely counted as mined.
    feeCases++; feeChildren++; checks.push(`${stage}: package accepted, public draft restored, exact child replaced and confirmed`);
    console.log(JSON.stringify({ stage, passed: true, replacedChildConfirmed: false, replacementConfirmed: true }));
  } catch (error) {
    failureDetail = { locations: error instanceof Error ? [...(error.stack ?? '').matchAll(/presigned-offline-acceptance\.mts:(\d+):(\d+)/gu)]
      .map(match => ({ line: Number(match[1]), column: Number(match[2]) })) : [],
      statuses: (await Promise.all(group.map(member => member.page.locator('#status').textContent().catch(() => 'page unavailable'))))
        .map(value => (value ?? '').replace(/[A-Za-z0-9_+\/=.-]{32,}/gu, '[redacted]').slice(0, 500)) };
    throw error;
  } finally { for (const member of group) await closeActor(member); }
}
try {
  await withPresignedRegtest(async core => {
    async function fixture(source: string | null = null) {
      const result = createPresignedFixture();
      const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: result.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })));
      result.graph = buildPresignedGraph({ roster: result.roster, funding: { ...result.graph.funding,
        inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
      await core.rpc('sendrawtransaction', [signPresignedFixtureFunding(result).transactionHex]); await core.mine();
      if (source !== null) {
        const exit = result.graph.exits.find(item => item.id === source)!;
        const signed = completePresignedExit({ graph: result.graph, preauthorizations: publicKit(result).preauthorizations,
          exitId: exit.id, participantId: exit.leaver, privateKey: result.keysById[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: result.graph.digest });
        await core.rpc('sendrawtransaction', [signed.transactionHex]); await core.mine();
      }
      return result;
    }
    async function confirm(transaction: PresignedOfflineTransaction) {
      const policy = await core.rpc('testmempoolaccept', [[transaction.transactionHex]]);
      assert.equal(policy[0].allowed, true, 'Core rejected a transaction signed by the actual offline browser');
      assert.equal(await core.rpc('sendrawtransaction', [transaction.transactionHex]), transaction.txid); await core.mine();
      assert((await core.rpc('getrawtransaction', [transaction.txid, true])).confirmations >= 1); signedTransactions++;
    }
    if (lifecycle) for (const first of PARTICIPANT_IDS) for (const second of PARTICIPANT_IDS.filter(id => id !== first)) {
      stage = `offline browser ${first}/${second} full solo ordering and final sweep`;
      const current = await fixture(); const last = PARTICIPANT_IDS.find(id => id !== first && id !== second)!;
      const group = await Promise.all([first, second, last].map(id => createActor(current, id)));
      try {
        await confirm(await single(group[0]!, 'solo', first));
        await confirm(await single(group[1]!, 'solo', `${first}/${second}`));
        await confirm(await single(group[2]!, 'final-sweep', `${first}/${second}`));
      } finally { for (const actor of group) await closeActor(actor); }
      checks.push(stage); console.log(JSON.stringify({ stage, passed: true }));
    }
    if (lifecycle) for (const source of [null, ...PARTICIPANT_IDS]) {
      stage = `offline browser cooperative round after ${source ?? 'funding'}`;
      const current = await fixture(source); const ids = PARTICIPANT_IDS.filter(id => id !== source);
      const group = await Promise.all(ids.map(id => createActor(current, id)));
      try { await confirm(await cooperate(group, source ?? '', source === null)); }
      finally { for (const actor of group) await closeActor(actor); }
      checks.push(stage); console.log(JSON.stringify({ stage, passed: true }));
    }
    if (lifecycle) for (const source of [null, ...PARTICIPANT_IDS]) for (const omitted of PARTICIPANT_IDS.filter(id => id !== source)) {
      stage = `offline browser recovery after ${source ?? 'funding'}, without ${omitted}`;
      const current = await fixture(source);
      const group = await Promise.all(PARTICIPANT_IDS.filter(id => id !== source && id !== omitted).map(id => createActor(current, id)));
      try {
        const transaction = await recover(group, source ?? '');
        const early = await core.rpc('testmempoolaccept', [[transaction.transactionHex]]);
        assert.equal(early[0].allowed, false); assert.equal(early[0]['reject-reason'], 'non-BIP68-final');
        await core.mine(current.graph.roster.economics.recoveryDelayBlocks - 1); await confirm(transaction);
      } finally { for (const actor of group) await closeActor(actor); }
      checks.push(stage); console.log(JSON.stringify({ stage, passed: true }));
    }
    if (!boundaryOnly) for (const walletKind of ['p2tr','p2wpkh'] as const)
      for (const kind of ['funding','solo','cooperative','recovery','final-sweep'] as const) await feeCase(core, kind, walletKind);
    stage = 'mainnet-format kit restoration and offline security boundary';
    const mainnet = createPresignedFixture({ network: 'mainnet' }); const actor = await createActor(mainnet, 'alice');
    try {
      stage = 'mainnet-format CSP network prohibition';
      // navigator.onLine is not a reliable file:-origin transport assertion.
      // Prove the actual CSP boundary while transport is separately disabled.
      const rejected = await actor.page.evaluate(async () => {
        try { await fetch('https://offline-acceptance.invalid'); return false; } catch { return true; }
      });
      assert.equal(rejected, true); assert.deepEqual(requests, []);
      stage = 'mainnet-format payout-address review';
      await prepare(actor, 'solo', 'alice');
      const review = JSON.parse(await actor.page.locator('#review').textContent() ?? '{}');
      assert(review.outputs.every((output: { address: string }) => output.address.startsWith('bc1')));
      const malformed = JSON.parse(actor.encrypted); malformed.binding.graphDigest = 'aa'.repeat(32);
      stage = 'mainnet-format authenticated-envelope mutation rejection';
      await actor.page.locator('#backup').setInputFiles({ name: 'changed-kit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malformed)) });
      await actor.page.locator('#expected-graph').fill(mainnet.graph.digest); await actor.page.locator('#expected-funding').fill(mainnet.graph.fundingTxid);
      await secretInput(actor); await actor.page.locator('#verify').click();
      await expect(actor.page.locator('#status')).toContainText('differs from independently rebuilt commitment');
      assert.equal(await actor.page.locator('#spending').isVisible(), false);
      stage = 'offline utility zero network and script-error audit';
      assert.deepEqual(requests, []); assert.deepEqual(errors, []);
    } finally { await closeActor(actor); }
    checks.push(stage);
    assert.equal(signedTransactions, lifecycle ? 31 : 0);
    assert.equal(feeCases, boundaryOnly ? 0 : 10); assert.equal(feeChildren, feeCases);
    const summary = { passed: true, protocol: PRESIGNED_PROTOCOL, utilitySha256: manifest.sha256,
      utilityInputDigest: manifest.inputDigest, browserOfflineMode: true, networkRequests: requests.length,
      persistentSecretStorage: false, actualBrowserSignedTransactionsConfirmedByCore: signedTransactions,
      restoredKits, fullSoloOrderings: lifecycle ? 6 : 0, cooperativeRounds: lifecycle ? 4 : 0, recoverySignerSubsets: lifecycle ? 9 : 0,
      feeRescueWalletAndParentCases: feeCases, feeChildrenAcceptedThenReplaced: feeCases, replacementFeeChildrenConfirmedByCore: feeChildren,
      completeLifecycleEvidence: lifecycle, completeFeeEvidence: !boundaryOnly,
      publicNetworkBroadcasts: 0, chain: 'isolated-regtest', realDefaultSignetEvidence: false, checks };
    writeFileSync(`${directory}/offline-browser${boundaryOnly ? '-boundary' : feesOnly ? '-fees' : ''}-acceptance.json`, JSON.stringify(summary, null, 2), { mode: 0o600, flag: 'wx' });
    core.record('offline-browser-acceptance', summary);
    console.log(JSON.stringify({ evidence: directory, ...summary }, null, 2));
  }, { maximumMinutes: lifecycle ? 45 : 15 });
} catch (error) {
  // No raw Playwright errors: they can embed the password input's fill value.
  console.error(JSON.stringify({ passed: false, stage, evidence: directory, failureDetail,
    reason: error instanceof Error ? error.message.split('\n')[0]!.replace(/[A-Za-z0-9_+\/=.-]{32,}/gu, '[redacted]').slice(0, 350)
      : 'Offline browser acceptance failed; private inputs and raw error details deliberately not retained.' }));
  process.exitCode = 1;
} finally {
  for (const actor of actors) { actor.key.fill(0); actor.encrypted = ''; await actor.context.close().catch(() => undefined); }
  await browser.close();
}
