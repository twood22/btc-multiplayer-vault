/** Actual saved HTML; public deterministic fixtures only. No Core, service or network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Download, type Page } from '@playwright/test';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { createPresignedPublicKit, encryptPresignedOfflineBackup, serializePresignedOfflineBackup } from '../src/presigned/backup.js';
import { buildPresignedFeeDraft, validatePresignedFeePackage, type PresignedFeeDraft } from '../src/presigned/fee-package.js';
import { type FeeCoinObservation } from '../src/presigned/fees.js';
import { authorizePresignedFundingFeeWalletPsbt, type PresignedFundingFeeRole } from '../src/presigned/funding-fees.js';
import { createPresignedFixture, preauthorizePresignedFixture, authorizePresignedFixtureRecoveries,
  signPresignedFixtureFunding } from '../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../src/presigned/graph.js';
import { clearPresignedParticipantKeys } from '../src/presigned/roster.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type ParticipantId, type PresignedProtocol, type PresignedPublicKit } from '../src/presigned/types.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';

// No traces, screenshots, videos, browser console forwarding, file-backed kits,
// or raw exception output. Playwright receives only public synthetic fixture keys.
assert.equal(process.version, `v${readFileSync('.node-version', 'utf8').trim()}`);
assert.equal(process.argv.length, 2, 'this focused offline suite accepts no arguments');
const artifactPath = resolve('public/offline/presigned-recovery.html');
const manifestPath = resolve('public/offline/presigned-recovery.manifest.json');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const artifactSha256 = hash(readFileSync(artifactPath));
const manifestSha256 = hash(readFileSync(manifestPath));
const suiteSha256 = hash(readFileSync(new URL(import.meta.url)));
function verifyArtifact() {
  const bytes = readFileSync(artifactPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(hash(bytes), artifactSha256, 'saved HTML changed during the suite');
  assert.equal(hash(readFileSync(manifestPath)), manifestSha256, 'offline manifest changed during the suite');
  assert.equal(manifest.sha256, artifactSha256);
  assert.equal(manifest.byteLength, bytes.length);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.protocol, PRESIGNED_PROTOCOL_V3);
  assert.equal(manifest.format, 'presigned-offline-utility-v3');
  assert.deepEqual(manifest.supportedProtocols, [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]);
  assert.equal(hash(JSON.stringify(manifest.inputs)), manifest.inputDigest);
  assert(Array.isArray(manifest.inputs) && manifest.inputs.length > 0);
  for (const input of manifest.inputs) {
    assert(typeof input.path === 'string' && input.path.length > 0 && !input.path.startsWith('/') &&
      !input.path.split('/').includes('..'), 'offline input escapes source inventory');
    assert.equal(hash(readFileSync(input.path)), input.sha256, 'offline artifact input differs from current source');
  }
  return manifest.inputDigest as string;
}

type Fixture = ReturnType<typeof createPresignedFixture>;
type SoloDraft = Extract<PresignedFeeDraft, { mode: 'solo' }>;
type FundingDraft = Extract<PresignedFeeDraft, { mode: 'funding' }>;
interface Actor {
  context: BrowserContext; page: Page; fixture: Fixture; kit: PresignedPublicKit;
  wrap: Uint8Array; encrypted: string; downloads: Download[]; requests: number; pageErrors: number;
}
let browser: Browser | undefined;
let actor: Actor | undefined;
let stage = 'verify exact saved artifact';
let inputDigest = '';
let validPackages = 0;
let rejectedImports = 0;
let refusedActions = 0;
let asyncInvalidations = 0;
let validFundingPackages = 0;
let fundingConflictingImportsRejected = 0;
let fundingIncompleteFinalizationsRefused = 0;
const protocolsCompleted: PresignedProtocol[] = [];

function kitFor(fixture: Fixture): PresignedPublicKit {
  return createPresignedPublicKit({ graph: fixture.graph, preauthorizations: preauthorizePresignedFixture(fixture),
    ...(fixture.graph.version === 3 ? { recoveryAuthorizations: authorizePresignedFixtureRecoveries(fixture) } : {}) });
}
function observation(fixture: Fixture, coin: Pick<FeeCoinObservation, 'txid' | 'vout' | 'valueSats' | 'scriptPubKeyHex'>): FeeCoinObservation {
  return { ...coin, network: fixture.graph.roster.network, genesisHash: fixture.graph.roster.genesisHash,
    confirmationBlockHash: '55'.repeat(32), confirmations: 12, unspentInActiveChain: true, coinbase: false };
}
function draftFor(fixture: Fixture, owner: ParticipantId = 'alice'): SoloDraft {
  const { graph } = fixture;
  const exit = graph.exits.find(item => item.id === owner)!;
  const parent = completePresignedExit({ graph, preauthorizations: preauthorizePresignedFixture(fixture),
    exitId: exit.id, participantId: owner, privateKey: fixture.keysById[owner].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
  const draft: SoloDraft = { version: graph.version, protocol: graph.protocol, epochId: graph.funding.epochId,
    proposalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerParticipantId: owner, parentAuthorityDigest: '77'.repeat(32), mode: 'solo',
    request: { graph, exitId: exit.id, parentTransactionHex: parent.transactionHex,
      roundInputObservation: observation(fixture, { txid: exit.inputTxid, vout: exit.inputVout,
        valueSats: exit.inputValueSats, scriptPubKeyHex: exit.inputScriptPubKeyHex }),
      sponsorInput: observation(fixture, { txid: '66'.repeat(32), vout: 1, valueSats: 20_000,
        scriptPubKeyHex: fixture.walletKeys.alice.scriptPubKeyHex }),
      approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 1_000,
        minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: fixture.walletKeys.alice.scriptPubKeyHex,
        approveExactNoChangeFee: false, replacement: null } } };
  buildPresignedFeeDraft(draft);
  return draft;
}
function sponsorPsbt(fixture: Fixture, draft: SoloDraft): string {
  const built = buildPresignedFeeDraft(draft);
  const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
  const wallet = fixture.walletKeys.alice;
  const secret = Buffer.from(wallet.privateKey);
  let even: Buffer | undefined; let tweaked: Buffer | undefined;
  try {
    even = Buffer.from(wallet.publicKey[0] === 3 ? ecc.privateNegate(secret) : secret);
    tweaked = Buffer.from(ecc.privateAdd(even, bitcoin.crypto.taggedHash('TapTweak', wallet.publicKey.subarray(1)))!);
    const transaction = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
    const message = transaction.hashForWitnessV1(1,
      psbt.data.inputs.map(input => input.witnessUtxo!.script),
      psbt.data.inputs.map(input => input.witnessUtxo!.value), bitcoin.Transaction.SIGHASH_DEFAULT);
    psbt.updateInput(1, { tapKeySig: ecc.signSchnorr(message, tweaked) });
    return psbt.toBase64();
  } finally { secret.fill(0); even?.fill(0); tweaked?.fill(0); }
}
function fundingDraftFor(fixture: Fixture): FundingDraft {
  const { graph } = fixture;
  const funding = signPresignedFixtureFunding(fixture);
  const draft: FundingDraft = { version: graph.version, protocol: graph.protocol, epochId: graph.funding.epochId,
    proposalId: null, ownerParticipantId: 'alice', parentAuthorityDigest: '88'.repeat(32), mode: 'funding',
    request: { graph, fundingTransactionHex: funding.transactionHex, changeParticipantId: 'alice',
      fundingInputObservations: graph.funding.inputs.map(({ txid, vout, valueSats, scriptPubKeyHex }) =>
        observation(fixture, { txid, vout, valueSats, scriptPubKeyHex })),
      sponsorInput: observation(fixture, { txid: '66'.repeat(32), vout: 1, valueSats: 20_000,
        scriptPubKeyHex: fixture.walletKeys.alice.scriptPubKeyHex }),
      approval: { childFeeSats: 3_000, maxChildFeeSats: 10_000, targetPackageRateMillisatsPerVbyte: 1_000,
        minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: fixture.walletKeys.alice.scriptPubKeyHex,
        approveExactNoChangeFee: false, replacement: null } } };
  buildPresignedFeeDraft(draft);
  return draft;
}
function fundingWalletPsbt(fixture: Fixture, draft: FundingDraft, roles: PresignedFundingFeeRole[], auxByte: number): string {
  const psbt = bitcoin.Psbt.fromBase64(buildPresignedFeeDraft(draft).psbtBase64);
  const transaction = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const wallet = fixture.walletKeys.alice;
  const secret = Buffer.from(wallet.privateKey);
  let even: Buffer | undefined; let tweaked: Buffer | undefined;
  try {
    even = Buffer.from(wallet.publicKey[0] === 3 ? ecc.privateNegate(secret) : secret);
    tweaked = Buffer.from(ecc.privateAdd(even, bitcoin.crypto.taggedHash('TapTweak', wallet.publicKey.subarray(1)))!);
    for (const role of roles) {
      const index = role === 'change' ? 0 : 1;
      const message = transaction.hashForWitnessV1(index, psbt.data.inputs.map(input => input.witnessUtxo!.script),
        psbt.data.inputs.map(input => input.witnessUtxo!.value), bitcoin.Transaction.SIGHASH_DEFAULT);
      // Different public aux bytes deliberately produce two distinct VALID
      // Schnorr signatures, not a malformed-signature shortcut to rejection.
      psbt.updateInput(index, { tapKeySig: ecc.signSchnorr(message, tweaked, Buffer.alloc(32, auxByte)) });
    }
    return psbt.toBase64();
  } finally { secret.fill(0); even?.fill(0); tweaked?.fill(0); }
}
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const button = document.getElementById('sign-fee') as HTMLButtonElement | null;
    return button !== null && !button.disabled;
  });
}
async function statusIncludes(current: Actor, expected: string): Promise<void> {
  await current.page.waitForFunction(text => document.getElementById('status')?.textContent?.includes(text), expected);
  await settle(current.page);
}
async function secretInput(current: Actor): Promise<void> {
  try { await current.page.locator('#secret').fill(Buffer.from(current.wrap).toString('base64url')); }
  catch { throw new Error('synthetic recovery-key input failed; value suppressed'); }
}
async function restore(current: Actor): Promise<void> {
  await current.page.goto(pathToFileURL(artifactPath).href);
  await statusIncludes(current, 'Local cryptography ready');
  await current.page.locator('#backup').setInputFiles({ name: 'public-synthetic-encrypted-kit.json', mimeType: 'application/json',
    buffer: Buffer.from(current.encrypted) });
  await statusIncludes(current, 'File header inspected');
  await current.page.locator('#expected-graph').fill(current.kit.graph.digest);
  await current.page.locator('#expected-funding').fill(current.kit.graph.fundingTxid);
  await secretInput(current); await current.page.locator('#verify').click();
  await statusIncludes(current, 'Kit authenticated');
  assert.equal(await current.page.locator('#secret').inputValue(), '');
}
async function newActor(protocol: PresignedProtocol): Promise<Actor> {
  const fixture = createPresignedFixture({ protocol }); const kit = kitFor(fixture);
  const wrap = new Uint8Array(32).fill(91); // Public fixture only, never real custody.
  const encrypted = serializePresignedOfflineBackup(await encryptPresignedOfflineBackup({ publicKit: kit,
    participantId: 'alice', participantSecret: fixture.participantSecrets.alice, offlineSecret: wrap }));
  const context = await browser!.newContext({ acceptDownloads: true }); context.setDefaultTimeout(15_000);
  await context.setOffline(true);
  const page = await context.newPage();
  const current: Actor = { context, page, fixture, kit, wrap, encrypted, downloads: [], requests: 0, pageErrors: 0 };
  await context.route(/^https?:/u, route => { current.requests++; return route.abort(); });
  page.on('request', request => { if (/^https?:/u.test(request.url())) current.requests++; });
  page.on('pageerror', () => { current.pageErrors++; });
  page.on('download', item => { current.downloads.push(item); });
  await restore(current); return current;
}
async function loadDraft(current: Actor, raw: string): Promise<void> {
  await current.page.locator('#fee-draft-file').setInputFiles({ name: 'public-synthetic-fee-draft.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
  await current.page.waitForFunction(() => (document.getElementById('fee-draft-file') as HTMLInputElement).value === '');
  await settle(current.page);
}
async function readDownload(file: Download): Promise<string> {
  const stream = await file.createReadStream(); assert(stream);
  let value = '';
  for await (const bytes of stream) { value += bytes.toString(); assert(value.length <= 1_100_000); }
  return value;
}
async function actionDownloads(current: Actor, button: string, expected: number): Promise<string[]> {
  const before = current.downloads.length;
  await current.page.locator(button).click(); await settle(current.page);
  if (expected) {
    const deadline = Date.now() + 5_000;
    while (current.downloads.length < before + expected && Date.now() < deadline) await current.page.waitForTimeout(20);
  }
  // The click action has returned and all its synchronous save() calls ran. Give
  // browser download events one additional event-loop window, not an RPC wait.
  await current.page.waitForTimeout(50);
  assert.equal(current.downloads.length - before, expected, 'unexpected number of public downloads');
  return Promise.all(current.downloads.slice(before).map(readDownload));
}
async function reviewedDraft(current: Actor, draft: PresignedFeeDraft): Promise<void> {
  await loadDraft(current, JSON.stringify(draft)); await statusIncludes(current, 'Exact fee child rebuilt');
  const review = JSON.parse(await current.page.locator('#fee-review').textContent() ?? '{}');
  assert.equal(review.approvalDigest, buildPresignedFeeDraft(draft).approvalDigest);
  assert.equal(review.childFeeSats, draft.request.approval.childFeeSats);
  assert.equal(await current.page.locator('#fee-reviewed').isChecked(), false);
  await current.page.locator('#fee-reviewed').check();
}
async function completedDraft(current: Actor, draft: SoloDraft): Promise<void> {
  await reviewedDraft(current, draft);
  const [savedDraft] = await actionDownloads(current, '#save-fee-draft', 1);
  assert.deepEqual(JSON.parse(savedDraft!), draft);
  const [unsigned] = await actionDownloads(current, '#save-fee-psbt', 1);
  const savedPsbt = bitcoin.Psbt.fromBase64(unsigned!);
  assert.equal(Buffer.from(savedPsbt.data.globalMap.unsignedTx.toBuffer()).toString('hex'),
    Buffer.from(bitcoin.Psbt.fromBase64(buildPresignedFeeDraft(draft).psbtBase64).data.globalMap.unsignedTx.toBuffer()).toString('hex'));
  await secretInput(current); await current.page.locator('#sign-fee').click();
  await statusIncludes(current, 'Your detached payout signature is ready');
  assert.equal(await current.page.locator('#secret').inputValue(), '');
  await current.page.locator('#wallet-fee-psbt').fill(sponsorPsbt(current.fixture, draft));
  await current.page.locator('#import-fee-wallet').click(); await statusIncludes(current, 'External wallet signature(s) verified');
  const files = (await actionDownloads(current, '#finalize-fee', 2)).map(raw => JSON.parse(raw));
  const signed = files.find(value => value.mode === 'solo'); assert(signed);
  const checked = validatePresignedFeePackage(signed);
  assert.equal(checked.completed.txid, buildPresignedFeeDraft(draft).unsignedTxid);
  assert.equal(signed.protocol, current.kit.protocol);
  assert.deepEqual(signed.request, draft.request);
  const transactionFile = files.find(value => value.format === 'presigned-offline-fee-transactions-v1'); assert(transactionFile);
  assert.deepEqual(transactionFile.transactionHexes, [checked.parentTransactionHex, checked.completed.transactionHex]);
  validPackages++;
}
async function atomicFundingImport(current: Actor): Promise<void> {
  const draft = fundingDraftFor(current.fixture); const built = buildPresignedFeeDraft(draft);
  const originalSponsor = fundingWalletPsbt(current.fixture, draft, ['sponsor'], 1);
  const conflictingBoth = fundingWalletPsbt(current.fixture, draft, ['change', 'sponsor'], 2);
  const changeOnly = fundingWalletPsbt(current.fixture, draft, ['change'], 2);
  const original = authorizePresignedFundingFeeWalletPsbt({ request: draft.request, roles: ['sponsor'],
    signedPsbtBase64: originalSponsor, approvalDigest: built.approvalDigest })[0]!;
  const incoming = authorizePresignedFundingFeeWalletPsbt({ request: draft.request, roles: ['change', 'sponsor'],
    signedPsbtBase64: conflictingBoth, approvalDigest: built.approvalDigest });
  assert.equal(incoming.length, 2);
  assert.notDeepEqual(incoming.find(item => item.role === 'sponsor')!.witness, original.witness);
  await reviewedDraft(current, draft);
  await current.page.locator('#funding-roles').selectOption('sponsor');
  await current.page.locator('#wallet-fee-psbt').fill(originalSponsor);
  await current.page.locator('#import-fee-wallet').click();
  await statusIncludes(current, 'External wallet signature(s) verified');
  await actionDownloads(current, '#finalize-fee', 0);
  await statusIncludes(current, 'funding fee needs both external wallet signatures');
  fundingIncompleteFinalizationsRefused++;

  await current.page.locator('#funding-roles').selectOption('change,sponsor');
  await current.page.locator('#wallet-fee-psbt').fill(conflictingBoth);
  await current.page.locator('#import-fee-wallet').click();
  await statusIncludes(current, 'retained funding fee wallet contribution');
  fundingConflictingImportsRejected++;
  // With the old non-atomic merge, the new change role was appended before the
  // existing sponsor conflict threw, so this exact finalization wrongly worked.
  await actionDownloads(current, '#finalize-fee', 0);
  await statusIncludes(current, 'funding fee needs both external wallet signatures');
  fundingIncompleteFinalizationsRefused++;

  await current.page.locator('#funding-roles').selectOption('change');
  await current.page.locator('#wallet-fee-psbt').fill(changeOnly);
  await current.page.locator('#import-fee-wallet').click();
  await statusIncludes(current, 'External wallet signature(s) verified');
  const files = (await actionDownloads(current, '#finalize-fee', 2)).map(raw => JSON.parse(raw));
  const signed = files.find(value => value.mode === 'funding'); assert(signed);
  const checked = validatePresignedFeePackage(signed);
  assert.equal(checked.completed.txid, built.unsignedTxid);
  assert.equal(signed.protocol, current.kit.protocol);
  assert.deepEqual(signed.request, draft.request);
  assert.equal(signed.signatures.length, 2);
  assert.deepEqual(signed.signatures.find((item: { role: string }) => item.role === 'sponsor'), original,
    'failed import changed the previously accepted sponsor signature');
  assert.deepEqual(signed.signatures.find((item: { role: string }) => item.role === 'change'), incoming[0],
    'successful change-only import did not contribute the exact intended witness');
  const transactionFile = files.find(value => value.format === 'presigned-offline-fee-transactions-v1'); assert(transactionFile);
  assert.deepEqual(transactionFile.transactionHexes, [checked.parentTransactionHex, checked.completed.transactionHex]);
  validPackages++; validFundingPackages++;
}
async function assertNoDraftAuthority(current: Actor, draft: SoloDraft): Promise<void> {
  assert.equal(await current.page.locator('#fee-review').textContent(), 'No fee draft.');
  assert.equal(await current.page.locator('#fee-reviewed').isChecked(), false);
  await current.page.locator('#fee-reviewed').check(); await secretInput(current);
  await current.page.locator('#sign-fee').click(); await settle(current.page);
  assert(!(await current.page.locator('#status').textContent())?.includes('detached payout signature is ready'), 'rejected draft remained signable');
  refusedActions++;
  for (const button of ['#save-fee-draft', '#save-fee-psbt', '#finalize-fee']) {
    await actionDownloads(current, button, 0); refusedActions++;
  }
  // A fresh valid external signature must not revive either the rejected draft
  // or a fully signed draft retained from before the import error.
  await current.page.locator('#wallet-fee-psbt').fill(sponsorPsbt(current.fixture, draft));
  await current.page.locator('#import-fee-wallet').click(); await settle(current.page);
  assert(!(await current.page.locator('#status').textContent())?.includes('External wallet signature(s) verified'));
  refusedActions++;
  await actionDownloads(current, '#finalize-fee', 0); refusedActions++;
  await current.page.locator('#secret').fill('');
}
async function interruptedSigning(current: Actor, draft: SoloDraft, change: 'approval' | 'approval-aba' | 'fee-input'): Promise<void> {
  await reviewedDraft(current, draft); await secretInput(current);
  const wasPending = await current.page.evaluate(which => {
    const button = document.getElementById('sign-fee') as HTMLButtonElement;
    button.click();
    const pending = button.disabled;
    if (which === 'approval' || which === 'approval-aba') {
      const approval = document.getElementById('fee-reviewed') as HTMLInputElement;
      approval.checked = false;
      approval.dispatchEvent(new Event('change', { bubbles: true }));
      if (which === 'approval-aba') {
        approval.checked = true;
        approval.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      const input = document.getElementById('child-fee') as HTMLInputElement;
      input.value = String(Number(input.value) + 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return pending;
  }, change);
  assert(wasPending, 'DOM approval edit did not overlap asynchronous signing');
  await settle(current.page);
  assert(!(await current.page.locator('#status').textContent())?.includes('detached payout signature is ready'), 'changed review published an asynchronous signature');
  assert.equal(await current.page.locator('#fee-reviewed').isChecked(), change === 'approval-aba');
  await current.page.locator('#fee-reviewed').check();
  await current.page.locator('#wallet-fee-psbt').fill(sponsorPsbt(current.fixture, draft));
  await current.page.locator('#import-fee-wallet').click(); await settle(current.page);
  assert(!(await current.page.locator('#status').textContent())?.includes('External wallet signature(s) verified'), 'stale asynchronous signature revived');
  await actionDownloads(current, '#finalize-fee', 0);
  asyncInvalidations++;
}
function clearFixture(fixture: Fixture): void {
  Object.values(fixture.keysById).forEach(clearPresignedParticipantKeys);
  Object.values(fixture.walletKeys).forEach(wallet => wallet.privateKey.fill(0));
  for (const id of Object.keys(fixture.participantSecrets) as ParticipantId[]) fixture.participantSecrets[id] = '';
}
async function closeActor(current: Actor): Promise<void> {
  current.wrap.fill(0); current.encrypted = ''; clearFixture(current.fixture); await current.context.close();
}

try {
  inputDigest = verifyArtifact();
  browser = await chromium.launch({ headless: true });
  for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]) {
    stage = `${protocol}: restore synthetic owner`; actor = await newActor(protocol);
    const current = actor; const valid = draftFor(current.fixture);
    stage = `${protocol}: valid draft export, owner signing, external sponsor and finalization`;
    await completedDraft(current, valid);
    const foreign = createPresignedFixture({ protocol });
    foreign.graph = buildPresignedGraph({ roster: foreign.roster, funding: { ...foreign.graph.funding,
      epochId: '44444444-4444-4444-8444-444444444444' } });
    const changedSponsor = structuredClone(valid);
    changedSponsor.request.approval.sponsorChangeScriptPubKeyHex = current.fixture.walletKeys.bob.scriptPubKeyHex;
    const noChange = structuredClone(valid);
    noChange.request.sponsorInput.valueSats = noChange.request.approval.childFeeSats;
    noChange.request.approval.sponsorChangeScriptPubKeyHex = null;
    noChange.request.approval.approveExactNoChangeFee = true;
    buildPresignedFeeDraft(changedSponsor); buildPresignedFeeDraft(noChange);
    const hostile = [
      { name: 'foreign graph', raw: JSON.stringify(draftFor(foreign)) },
      { name: 'foreign payout owner', raw: JSON.stringify(draftFor(current.fixture, 'bob')) },
      { name: 'foreign sponsor change', raw: JSON.stringify(changedSponsor) },
      { name: 'no-change opt-in', raw: JSON.stringify(noChange) },
      { name: 'malformed JSON', raw: '{' },
      { name: 'malformed request shape', raw: JSON.stringify({ ...valid, request: {} }) },
    ];
    clearFixture(foreign);
    for (const precedingState of ['fresh', 'fully signed'] as const) for (const hostileDraft of hostile) {
      stage = `${protocol}: ${precedingState} state rejects ${hostileDraft.name}`;
      if (precedingState === 'fresh') await restore(current);
      else await completedDraft(current, valid);
      await loadDraft(current, hostileDraft.raw);
      assert(!(await current.page.locator('#status').textContent())?.includes('Exact fee child rebuilt'), 'hostile draft unexpectedly reviewed');
      await assertNoDraftAuthority(current, valid); rejectedImports++;
    }
    for (const change of ['approval', 'approval-aba', 'fee-input'] as const) {
      stage = `${protocol}: ${change} changes during asynchronous signing`;
      await interruptedSigning(current, valid, change);
    }
    stage = `${protocol}: failed multi-role funding import cannot retain a partial merge`;
    await atomicFundingImport(current);
    assert.equal(current.requests, 0, 'offline page attempted a network request');
    assert.equal(current.pageErrors, 0, 'offline page emitted an uncaught script error');
    assert.equal(await current.page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    protocolsCompleted.push(protocol); await closeActor(current); actor = undefined;
  }
  stage = 'verify final exact saved artifact'; verifyArtifact();
  assert.equal(validPackages, 16); assert.equal(rejectedImports, 24); assert.equal(refusedActions, 144); assert.equal(asyncInvalidations, 6);
  assert.equal(validFundingPackages, 2); assert.equal(fundingConflictingImportsRejected, 2); assert.equal(fundingIncompleteFinalizationsRefused, 4);
  console.log(JSON.stringify({ passed: true, kind: 'actual-saved-html-fee-review-boundary', sourceDigest: presignedSourceDigest(),
    suiteSha256, artifactSha256, manifestSha256, inputDigest, protocols: protocolsCompleted,
    validPackages, rejectedImports, refusedActions, asyncInvalidations,
    validFundingPackages, fundingConflictingImportsRejected, fundingIncompleteFinalizationsRefused, actualBrowserExecuted: true,
    syntheticPublicFixturesOnly: true, actualBlockchainContact: false, networkRequests: 0, publicNetworkBroadcasts: 0 }));
} catch (error) {
  const locations = error instanceof Error ? [...(error.stack ?? '').matchAll(/presigned-offline-fee-review-acceptance\.mts:(\d+):(\d+)/gu)]
    .map(match => ({ line: Number(match[1]), column: Number(match[2]) })) : [];
  console.error(JSON.stringify({ passed: false, stage, locations, suiteSha256, artifactSha256, manifestSha256,
    protocolsCompleted, validPackages, rejectedImports, refusedActions, asyncInvalidations,
    validFundingPackages, fundingConflictingImportsRejected, fundingIncompleteFinalizationsRefused,
    detail: 'Fixture secrets, raw browser state and raw exception details intentionally suppressed.' }));
  process.exitCode = 1;
} finally {
  if (actor) await closeActor(actor).catch(() => undefined);
  await browser?.close();
}
