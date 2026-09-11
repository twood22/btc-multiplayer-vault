import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect as baseExpect, test, type Locator, type Page, type Download } from '@playwright/test';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import postgres from 'postgres';
import { taggedHash } from '../../src/crypto.js';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { createPresignedFixture } from '../../src/presigned/fixtures.js';
import { presignedActionDigest } from '../../src/presigned/ceremony.js';
import { validatePresignedFeePackage, type PresignedFeePackage } from '../../src/presigned/fee-package.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph } from '../../src/presigned/types.js';
import { withPresignedRegtest, type PresignedRegtest } from '../../scripts/lib/presigned-regtest.js';
import { createV2Browser, installV2EsploraBridge, localV2Gate, seedV2Invitations, startV2CoreBridge,
  reloadV2Vault, useV2Authenticator, v2Status, type V2Browser, type V2BrowserAudit } from './presigned-v2-fixture';
import { boundedPresignedBrowserCleanup, disablePresignedFailurePageSnapshots,
  presignedBrowserFailureLocations } from './presigned-failure-report';

// Recovery keys appear briefly in the genuine UI. Never trace, screenshot, video or snapshot this test.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
disablePresignedFailurePageSnapshots();
// Retained graph/package verification is local cryptographic work. Under
// concurrent CPU-heavy acceptance, observed successful actions exceeded the
// old 20-second UI assertion budget; actual network deadlines stay unchanged.
const expect = baseExpect.configure({ timeout: 60_000 });
let runtimeStage = 'not-started';

test('real V2 browser ceremony and runtime with virtual PRF passkeys and isolated Core facts', async ({ browser, baseURL }) => {
  test.setTimeout(2_700_000);
  assert(baseURL && new URL(baseURL).hostname === 'localhost', 'only the disposable localhost test host is allowed');
  const evidence = process.env.BROWSER_TEST_EVIDENCE_DIR;
  assert(evidence, 'owner-only test evidence directory is required');
  assert(evidence.startsWith('/tmp/btc-presigned-browser.'), 'owner-only test evidence directory is required');
  // The wrapper takes this from the exact built artifact (or immutable OCI
  // runtime). It is not the hash of whichever source happens to be open later.
  const buildIdentity = JSON.parse(readFileSync(process.env.BROWSER_TEST_BUILD_IDENTITY ?? 'vault-presigned-build.json', 'utf8'));
  assert(buildIdentity.version === 2 && buildIdentity.protocol === PRESIGNED_PROTOCOL &&
    buildIdentity.network === BITCOIN_NETWORK_NAME && /^[0-9a-f]{64}$/u.test(buildIdentity.sourceDigest));
  const databaseUrl = process.env.DATABASE_URL;
  assert(databaseUrl && new URL(databaseUrl).hostname === '127.0.0.1', 'only the disposable loopback database is allowed');
  const fixture = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
  const sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined });
  const actors: V2Browser[] = [];
  const audit: V2BrowserAudit = { forbidden: [], unexpected: [], chainRequests: 0, rpcMethods: [],
    sensitiveRequestDetected: false, walletReleaseLocalGates: [] };
  let stage = 'initialize disposable V2 vault';
  let originalFailure = false;
  const checks: string[] = [];
  try {
    const provisioned = await seedV2Invitations(sql, { network: fixture.roster.network, genesisHash: fixture.roster.genesisHash,
      economics: fixture.roster.economics, feePolicy: fixture.roster.feePolicy, fundingFeeSats: fixture.graph.funding.feeSats });
    for (const id of PARTICIPANT_IDS) {
      stage = `${id} real virtual-PRF primary and recovery onboarding`;
      actors.push(await createV2Browser({ browser, baseURL, id, invitation: provisioned.invitations[id], audit }));
    }
    checks.push('three independent browser identities and six virtual PRF-backed passkey envelopes');
    for (const actor of actors) {
      stage = `${actor.id} public V2 identity registration`;
      await actor.page.getByTestId('presigned-ceremony').getByRole('button', { name: 'Register my v2 public keys' }).click();
      await expect.poll(async () => (await v2Status(actor.page)).identities.some(identity => identity.id === actor.id)).toBe(true);
    }
    const rosterDigests: string[] = [];
    for (const actor of actors) {
      stage = `${actor.id} out-of-band-equivalent public roster comparison and passkey approval`;
      await reloadV2Vault(actor);
      const status = await v2Status(actor.page); assert(status.rosterDigest);
      rosterDigests.push(status.rosterDigest);
      const panel = actor.page.getByTestId('presigned-ceremony');
      await panel.getByLabel(/I compared this digest/u).check();
      await panel.getByRole('button', { name: 'Compare and pin exact roster locally' }).click();
      await expect.poll(async () => (await v2Status(actor.page)).rosterApprovals.includes(actor.id)).toBe(true);
    }
    assert.equal(new Set(rosterDigests).size, 1);
    checks.push('all three approve the same reconstructed roster through genuine passkey endpoints');

    await withPresignedRegtest(async core => {
      stage = 'start isolated private Core and browser Esplora identity bridges';
      const bridge = await startV2CoreBridge(core, Number(process.env.BROWSER_CHAIN_FIXTURE_PORT), audit);
      try {
        for (const actor of actors) await installV2EsploraBridge(actor, core, audit);
        const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })));
        for (const [index, actor] of actors.entries()) {
          stage = `${actor.id} actual confirmed external-wallet coin commitment`;
          await reloadV2Vault(actor);
          const panel = actor.page.getByTestId('presigned-ceremony');
          await panel.getByLabel('Wallet coin transaction ID').fill(coins[index]!.txid);
          await panel.getByLabel('Output number', { exact: true }).fill(String(coins[index]!.vout));
          await panel.getByRole('button', { name: 'Verify and commit my coin' }).click();
          await expect.poll(async () => (await v2Status(actor.page)).epoch!.inputs.some(coin => coin.participantId === actor.id)).toBe(true);
        }
        for (const actor of actors) {
          stage = `${actor.id} independent graph review and four real preauthorizations`;
          await reloadV2Vault(actor);
          const panel = actor.page.getByTestId('presigned-ceremony');
          await panel.getByLabel(/I reviewed the exact inputs, payouts/u).check();
          await panel.getByRole('button', { name: 'Pin graph and preauthorize four counterparty exits' }).click();
          await expect.poll(async () => (await v2Status(actor.page)).epoch!.preauthorizations.filter(entry => entry.participantId === actor.id).length).toBe(4);
        }
        const graph = (await v2Status(actors[0]!.page)).epoch!.graph!;
        assert.equal(bitcoin.Transaction.fromHex(graph.fundingUnsignedTxHex).version, 3);
        assert.equal(graph.exits.length, 9);
        checks.push('real Core-native inputs, stable v3 funding, nine exits and twelve browser-produced counterparty signatures');
        for (const actor of actors) {
          stage = `${actor.id} encrypted portable download, file chooser and recovery-key readback`;
          console.log(JSON.stringify({ stage }));
          await reloadV2Vault(actor);
          const panel = actor.page.getByTestId('presigned-ceremony');
          await verifyBrowserUtility(actor, graph);
          const downloadEvent = actor.page.waitForEvent('download').catch(() => null);
          await panel.getByRole('button', { name: 'Create encrypted portable backup' }).click();
          const download = await downloadEvent;
          assert(download, 'encrypted portable backup download did not occur');
          const saved = join(evidence, `${actor.id}-encrypted-portable-backup.json`);
          await download.saveAs(saved);
          assert(readFileSync(saved).length > 1000, 'encrypted recovery file was not actually saved');
          let offlineSecret = '';
          try {
            offlineSecret = await panel.getByLabel('Keep this recovery key separately from the file').inputValue();
            if (!/^[A-Za-z0-9_-]{43}$/u.test(offlineSecret)) throw new Error('portable recovery key was not displayed');
            await panel.getByRole('button', { name: 'I stored the key separately; hide it' }).click();
            const chooserEvent = actor.page.waitForEvent('filechooser');
            await panel.getByLabel('Reopen the saved encrypted file').click();
            await (await chooserEvent).setFiles(saved);
            try { await panel.getByLabel('Re-enter its separate recovery key').fill(offlineSecret); }
            catch { throw new Error('Recovery-key entry failed; secret details redacted'); }
            await panel.getByRole('button', { name: 'Verify saved offline recovery' }).click();
            await expect.poll(async () => (await localV2Gate(actor.page, graph.digest)).offline).toBe(true);
            await expect.poll(async () => (await v2Status(actor.page)).epoch!.backups.some(receipt =>
              receipt.participantId === actor.id && receipt.backupKind === 'offline')).toBe(true);
            await expect(panel.getByRole('button', { name: 'Create encrypted portable backup' })).toBeEnabled();
          } finally { offlineSecret = ''; }
          stage = `${actor.id} actual independent primary and recovery PRF restores`;
          const credentials = await panel.getByLabel('Approval passkey').locator('option').evaluateAll(options => options.map(option => ({
            id: (option as HTMLOptionElement).value, name: option.textContent!.trim(),
          })));
          assert.equal(credentials.length, 2);
          for (const credential of credentials) {
            await useV2Authenticator(actor, credential.name.includes('recovery key') ? 'recovery' : 'primary');
            await panel.getByRole('button', { name: `Restore with: ${credential.name}`, exact: true }).click();
            await expect(panel.getByRole('button', { name: `Verified: ${credential.name}`, exact: true })).toBeDisabled();
            // Local crypto finishes before the separate passkey approval. Do
            // not disable this virtual authenticator while that second prompt
            // is still active, merely because its local receipt now exists.
            await expect.poll(async () => (await v2Status(actor.page)).epoch!.backups.some(receipt =>
              receipt.participantId === actor.id && receipt.restoreCredentialId === credential.id)).toBe(true);
            await expect(panel.getByRole('button', { name: 'Create encrypted portable backup' })).toBeEnabled();
          }
          await useV2Authenticator(actor, 'primary');
          const local = await localV2Gate(actor.page, graph.digest);
          assert(local.compared && local.reviewed && local.offline && local.passkeys === 2 && !local.intent);
        }
        checks.push('each browser actually reopens its saved encrypted portable file and restores with two separate virtual PRF credentials');

        if (BITCOIN_NETWORK_NAME === 'mainnet') {
          // A mainnet-format OCI build must preserve the real release gate.
          // No test flag, fabricated acceptance receipt or physical-test claim
          // is supplied to get around it. Full game execution is separately
          // required on the same source's Signet build and on real Signet.
          stage = 'mainnet image refuses funding without separate authorization and actual release evidence';
          await reloadV2Vault(actors[0]!);
          const readiness = actors[0]!.page.getByRole('region', { name: 'Presigned release readiness' });
          await readiness.getByRole('button', { name: 'Check read-only funding readiness' }).click();
          await expect(readiness.getByRole('status')).toContainText('Read-only results do not authorize');
          await expect(readiness).toContainText('Outstanding: Exact source');
          await expect(readiness).toContainText('Outstanding: Separate explicit mainnet activation');
          const downloads: Download[] = []; const record = (download: Download) => { downloads.push(download); };
          actors[0]!.page.on('download', record);
          try {
            const panel = actors[0]!.page.getByTestId('presigned-ceremony');
            await panel.getByRole('button', { name: 'Reverify and export funding PSBT' }).click();
            await expect(panel.locator('.form-message')).toContainText('mainnet funding requires separate explicit authorization');
          } finally { actors[0]!.page.off('download', record); }
          assert.equal(downloads.length, 0);
          const stopped = (await v2Status(actors[0]!.page)).epoch!;
          assert.deepEqual(stopped.walletSigningStarted, []); assert.deepEqual(stopped.signatures, []);
          assert.deepEqual(stopped.fundingApprovals, []); assert.equal(stopped.finalization, null);
          assert(!audit.rpcMethods.includes('sendrawtransaction') && !audit.rpcMethods.includes('submitpackage'));
          assert.deepEqual(await core.rpc('getrawmempool'), []);
          assert.deepEqual(audit.forbidden, []); assert.deepEqual(audit.unexpected, []); assert.equal(audit.sensitiveRequestDetected, false);
          checks.push('mainnet funding blocked before wallet PSBT export, server signing intent, signature release or send RPC; gate not bypassed');
          const summary = { passed: true, protocol: PRESIGNED_PROTOCOL, bundle: 'optimized-webpack-standalone',
            sourceDigest: buildIdentity.sourceDigest, appNetwork: BITCOIN_NETWORK_NAME, actualBitcoinChain: 'isolated-regtest',
            networkIdentityBridge: true, mainnetFundingGateVerified: true, mainnetFundingAuthorized: false,
            completeGameExecution: false, realSignetAcceptance: false, physicalPasskeyEvidence: false, virtualPrfPasskeys: 6,
            publicNetworkBroadcasts: 0, coreVersion: core.coreVersion, checks, audit };
          writeFileSync(join(evidence, 'presigned-browser-acceptance.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
          core.record('mainnet-browser-release-gate', summary);
          return;
        }

        for (const actor of actors) {
          stage = `${actor.id} wallet intent, exact exported PSBT and wallet signature release`;
          await reloadV2Vault(actor);
          const panel = actor.page.getByTestId('presigned-ceremony');
          let abortBegin = actor.id === 'alice';
          await actor.page.route('**/api/vault/presigned/action/options', async route => {
            const body = route.request().postDataJSON();
            if (body.action?.kind === 'begin-wallet-signing' && abortBegin) { abortBegin = false; await route.abort('failed'); return; }
            if (body.action?.kind === 'submit-funding-signature') {
              const local = await localV2Gate(actor.page, graph.digest);
              audit.walletReleaseLocalGates.push(local.compared && local.reviewed && local.offline && local.passkeys === 2 && local.intent);
            }
            await route.continue();
          });
          if (actor.id === 'alice') {
            const beforeIntent = await v2Status(actor.page);
            await panel.getByRole('button', { name: 'Reverify and export funding PSBT' }).click();
            await expect.poll(async () => (await localV2Gate(actor.page, graph.digest)).intent).toBe(true);
            await expect(panel.locator('.form-message')).toContainText(/fetch|failed|Failed/u);
            assert.equal((await v2Status(actor.page)).epoch!.walletSigningStarted.length, 0);
            await reloadV2Vault(actor);
            // Data-only coordinator replay after a lost request must not reopen the locally burned epoch.
            await actor.page.route('**/api/vault/presigned/status', route => route.fulfill({ status: 200,
              contentType: 'application/json', body: JSON.stringify(beforeIntent) }));
            await panel.getByRole('button', { name: 'Refresh ceremony', exact: true }).click();
            await expect(panel.getByText('Interrupted setup: request a unanimous restart', { exact: true })).toHaveCount(0);
            assert((await localV2Gate(actor.page, graph.digest)).intent);
            await actor.page.unroute('**/api/vault/presigned/status');
            checks.push('wallet intent persists before an aborted request and blocks replayed restart eligibility across reload');
          }
          const downloadEvent = actor.page.waitForEvent('download');
          await panel.getByRole('button', { name: 'Reverify and export funding PSBT' }).click();
          const saved = join(evidence, `${actor.id}-unsigned-funding.psbt.txt`);
          await (await downloadEvent).saveAs(saved);
          const exported = readFileSync(saved, 'utf8'); assert.equal(exported, graph.fundingPsbtBase64);
          const signed = signWalletInput(graph, actor.id, fixture.walletKeys[actor.id]);
          await panel.getByLabel('PSBT returned by your external wallet').fill(signed);
          await panel.getByRole('button', { name: 'Verify and release my wallet signature' }).click();
          await expect.poll(async () => (await v2Status(actor.page)).epoch!.signatures.some(signature => signature.participantId === actor.id)).toBe(true);
        }
        assert.equal(audit.walletReleaseLocalGates.length, 3); assert(audit.walletReleaseLocalGates.every(Boolean));
        for (const actor of actors) {
          stage = `${actor.id} exact final funding approval`;
          await reloadV2Vault(actor);
          await actor.page.getByTestId('presigned-ceremony').getByRole('button', { name: 'Approve exact final funding bytes' }).click();
          await expect.poll(async () => (await v2Status(actor.page)).epoch!.fundingApprovals.includes(actor.id)).toBe(true);
        }
        const finalized = (await v2Status(actors[0]!.page)).epoch!;
        assert.equal(finalized.status, 'approved'); assert(finalized.finalization);
        checks.push('three genuine wallet signatures, all local pre-release gates and three exact final passkey approvals');
        stage = 'read-only release readiness and interrupted funding fee package';
        await reloadV2Vault(actors[0]!);
        const readiness = actors[0]!.page.getByRole('region', { name: 'Presigned release readiness' });
        await readiness.getByRole('button', { name: 'Check read-only funding readiness' }).click();
        await expect(readiness.getByRole('status')).toContainText('Read-only results do not authorize');
        await expect(readiness).toContainText('Outstanding: Exact source');
        const sponsorScripts: string[] = [];
        for (let index = 0; index < 6; index++) {
          const address = await core.walletRpc('getnewaddress', ['browser-fee-acceptance', index % 2 ? 'bech32' : 'bech32m']);
          sponsorScripts.push(Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).toString('hex'));
        }
        const sponsors = await core.fundScripts(sponsorScripts.map(scriptPubKeyHex => ({ scriptPubKeyHex, valueSats: 20_000 })));
        await core.walletRpc('lockunspent', [false, sponsors.map(({ txid, vout }) => ({ txid, vout }))]);
        const fundingFee = await browserFee(actors[0]!, graph.fundingTxid, sponsors[0]!, core, fixture.walletKeys.alice, true);
        stage = 'browser funding broadcast through real API into isolated Core';
        await reloadV2Vault(actors[0]!);
        await runtimePanel(actors[0]!.page).getByRole('button', { name: 'Broadcast unanimously approved funding' }).click();
        await expect.poll(async () => (await core.rpc('getrawmempool')).includes(graph.fundingTxid)).toBe(true);
        await core.mine(); await refreshChain(actors[0]!);
        assert(await core.rpc('gettxout', [graph.fundingTxid, 0, true]));
        checks.push('funding accepted and mined by actual isolated Core via the user-facing broadcast API');
        stage = 'offline-signed funding fee resumes after parent confirmation';
        await reloadV2Vault(actors[0]!);
        const fundingFees = feePanel(actors[0]!.page);
        // setInputFiles bypasses normal click actionability and can write into
        // inert server HTML before React has installed the change handler.
        // Establish actual user-visible hydration and a completed UI action.
        console.log(JSON.stringify({ stage: 'fee import readiness', bodyInert: await actors[0]!.page.locator('body').evaluate(body => (body as HTMLElement).inert) }));
        await fundingFees.getByRole('button', { name: 'Refresh fee rescue', exact: true }).click();
        await expect(fundingFees.getByRole('status')).toContainText('Approved parents and retained fee packages refreshed');
        await fundingFees.getByLabel('Restore a public fee draft or signed package').setInputFiles({
          name: 'signed-funding-fee.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fundingFee.package)) });
        await expect(fundingFees.getByRole('status')).toContainText('Signed public package verified');
        await fundingFees.getByLabel('I approve this parent, sponsor coin, exact fee and unchanged payout/refund.').check();
        await fundingFees.getByRole('button', { name: 'Approve restored signed package' }).click();
        await expect(fundingFees.getByRole('status')).toContainText('durably approved');
        await broadcastBrowserFee(actors[0]!, fundingFee.completed.txid, core);
        await core.mine(); await refreshChain(actors[0]!);
        checks.push('funding fee saved before aborted approval, restored after parent confirmation, exactly approved and child-only broadcast through actual browser/API');

        stage = 'premature CSV recovery blocked by independent browser age check';
        await runtimePanel(actors[0]!.page).getByRole('button', { name: 'Propose timelocked recovery' }).click();
        await expect(runtimePanel(actors[0]!.page).getByRole('status')).toContainText(/at least 12 confirmations/u);
        assert.equal((await runtimeStatus(actors[0]!.page)).proposals.length, 0);
        const fundingDepth = (await core.rpc('getrawtransaction', [graph.fundingTxid, true])).confirmations;
        assert(fundingDepth < 12); await core.mine(12 - fundingDepth); await refreshChain(actors[0]!);

        stage = 'actual three-party interactive MuSig2 browser nonce and partial sequence';
        const cooperative = await createAndSignRuntime(actors, 'cooperative', core);
        assert((await core.rpc('testmempoolaccept', [[cooperative.finalized.transactionHex]]))[0].allowed);
        assert.equal(cooperative.publicNonces.length, 3); assert.equal(cooperative.partials.length, 3);
        const cooperativeFee = await browserFee(actors[0]!, cooperative.finalized.txid, sponsors[1]!, core);
        assert((await core.rpc('testmempoolaccept', [[cooperativeFee.parentTransactionHex, cooperativeFee.completed.transactionHex]]))[1].allowed);
        checks.push('three-party real interactive MuSig2, encrypted nonce survives page reload and is consumed before partial signing');
        stage = 'actual threshold CSV browser contributions at exact maturity';
        const recovery = await createAndSignRuntime(actors.slice(0, 2), 'recovery', core);
        assert((await core.rpc('testmempoolaccept', [[recovery.finalized.transactionHex]]))[0].allowed);
        assert.equal(recovery.recoveryContributions.length, 2);
        const recoveryFee = await browserFee(actors[0]!, recovery.finalized.txid, sponsors[2]!, core);
        assert((await core.rpc('testmempoolaccept', [[recoveryFee.parentTransactionHex, recoveryFee.completed.transactionHex]]))[1].allowed);
        checks.push('premature recovery blocked; two real personal-key CSV signatures accepted by Core at maturity');
        stage = 'first solo exit, second solo exit and final-owner sweep through browser APIs';
        let sponsorIndex = 3;
        for (const [actor, kind] of [[actors[0]!, 'solo'], [actors[1]!, 'solo'], [actors[2]!, 'final-sweep']] as const) {
          console.log(JSON.stringify({ stage: 'runtime-ordering', actor: actor.id, kind, step: 'refresh-before-proposal' }));
          await reloadV2Vault(actor); await refreshChain(actor);
          const state = await createAndSignRuntime([actor], kind, core);
          const fee = await browserFee(actor, state.finalized.txid, sponsors[sponsorIndex++]!, core);
          runtimeStage = `${kind}: ${actor.id} broadcast approved transaction`;
          console.log(JSON.stringify({ runtimeStage }));
          await runtimeArticle(actor.page, state.proposal.txid).getByRole('button', { name: 'Broadcast approved transaction', exact: true }).click();
          await expect.poll(async () => (await core.rpc('getrawmempool')).includes(state.finalized.txid)).toBe(true);
          await broadcastBrowserFee(actor, fee.completed.txid, core);
          runtimeStage = `${kind}: ${actor.id} mine and refresh`;
          console.log(JSON.stringify({ runtimeStage }));
          await core.mine(); await refreshChain(actor);
        }
        checks.push('actual first and second solo exits and payout-key final sweep broadcast, mined and watched through the browser path');
        assert(actors[2]!.reauthentications >= 1);
        checks.push('missing session after final-sweep signing requires genuine passkey reauthentication; exact signed transaction and local backup approvals survive');
        checks.push('all five fee parent families through real browser review, external Core sponsor PSBT, exact payout/refund signatures and passkey approval; funding/solo/final-sweep children broadcast and mined');
        assert.deepEqual(audit.forbidden, []); assert.deepEqual(audit.unexpected, []); assert.equal(audit.sensitiveRequestDetected, false);
        const summary = { passed: true, protocol: PRESIGNED_PROTOCOL, bundle: 'optimized-webpack-standalone',
          sourceDigest: buildIdentity.sourceDigest,
          completeGameExecution: true, mainnetFundingAuthorized: false,
          appNetwork: BITCOIN_NETWORK_NAME, actualBitcoinChain: 'isolated-regtest', networkIdentityBridge: true,
          realSignetAcceptance: false, physicalPasskeyEvidence: false, virtualPrfPasskeys: 6,
          publicNetworkBroadcasts: 0, coreVersion: core.coreVersion,
          reauthentications: actors.reduce((sum, actor) => sum + actor.reauthentications, 0), checks, audit };
        writeFileSync(join(evidence, 'presigned-browser-acceptance.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
        core.record('optimized-browser-acceptance', summary);
      } finally { await bridge.close(); }
    }, { maximumMinutes: 45 });
  } catch (error) {
    originalFailure = true;
    // Report before any await. A stuck renderer must not suppress the original
    // source location, and neither DOM text nor exception messages are safe.
    console.log(JSON.stringify({ stage, runtimeStage, assertionLocations: presignedBrowserFailureLocations(error),
      browserDiagnostics: actors.map(actor => ({ actor: actor.id, ...actor.diagnostics })) }));
    throw new Error(`V2 browser stage failed: ${stage}. See the safe stage and source-location diagnostic.`);
  } finally {
    // Include contexts from interrupted onboarding, before actors.push(). A
    // cleanup failure cannot replace the original error or authorize a pass.
    const contexts = await Promise.all(browser.contexts().map(context => boundedPresignedBrowserCleanup(() => context.close())));
    const browserOutcome = contexts.some(outcome => outcome !== 'completed')
      ? await boundedPresignedBrowserCleanup(() => browser.close()) : 'not-needed';
    const database = await boundedPresignedBrowserCleanup(() => sql.end({ timeout: 5 }), 6_000);
    const cleanupFailed = contexts.some(outcome => outcome !== 'completed') || database !== 'completed';
    if (cleanupFailed) {
      console.log(JSON.stringify({ stage: 'bounded browser cleanup', contexts, browser: browserOutcome, database }));
      if (!originalFailure) throw new Error('V2 browser cleanup failed; partial artifacts do not prove acceptance');
    }
  }
});

function signWalletInput(graph: PresignedGraph, id: ParticipantId, wallet: ReturnType<typeof createPresignedFixture>['walletKeys'][ParticipantId]) {
  const index = graph.funding.inputs.findIndex(input => input.participantId === id);
  const psbt = bitcoin.Psbt.fromBase64(graph.fundingPsbtBase64);
  if (wallet.kind === 'p2wpkh') psbt.signInput(index, { publicKey: wallet.publicKey, sign: hash => ecc.sign(hash, wallet.privateKey) });
  else {
    const tx = bitcoin.Transaction.fromHex(graph.fundingUnsignedTxHex);
    const hash = tx.hashForWitnessV1(index, psbt.data.inputs.map(input => input.witnessUtxo!.script),
      psbt.data.inputs.map(input => input.witnessUtxo!.value), bitcoin.Transaction.SIGHASH_DEFAULT);
    const even = wallet.publicKey[0] === 3 ? ecc.privateNegate(wallet.privateKey) : wallet.privateKey;
    const key = ecc.privateAdd(even, taggedHash('TapTweak', wallet.publicKey.subarray(1)))!;
    psbt.updateInput(index, { tapKeySig: Buffer.from(ecc.signSchnorr(hash, key)) });
  }
  return psbt.toBase64();
}
function runtimePanel(page: Page) { return page.getByRole('region', { name: 'Presigned transaction coordination' }); }
function feePanel(page: Page) { return page.getByRole('region', { name: 'Presigned fee rescue' }); }
async function downloadedText(download: Download) {
  const stream = await download.createReadStream(); assert(stream);
  let raw = '';
  for await (const chunk of stream) { raw += chunk.toString(); assert(raw.length <= 5 * 1024 * 1024); }
  return raw;
}
async function verifyBrowserUtility(actor: V2Browser, graph: PresignedGraph) {
  const panel = actor.page.getByTestId('presigned-ceremony'); const files: Download[] = [];
  const listener = (download: Download) => { files.push(download); };
  actor.page.on('download', listener);
  try {
    await panel.getByRole('button', { name: 'Save offline recovery utility and public commitments', exact: true }).click();
    await expect.poll(() => files.length).toBe(2);
    await expect(panel.getByRole('status')).toContainText('Offline utility and public commitments saved');
    const html = files.find(item => item.suggestedFilename() === 'presigned-recovery.html'); assert(html);
    const recordFile = files.find(item => item.suggestedFilename() === 'presigned-independent-recovery-record.json'); assert(recordFile);
    const record = JSON.parse(await downloadedText(recordFile));
    assert.equal(record.binding.graphDigest, graph.digest); assert.equal(record.binding.fundingTxid, graph.fundingTxid);
    assert.equal(record.binding.participantId, actor.id);
    assert.equal(createHash('sha256').update(await downloadedText(html)).digest('hex'), record.utilitySha256);
  } finally { actor.page.off('download', listener); }
}
async function feeStatus(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const response = await fetch('/api/vault/presigned/fees/status', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Fee status request failed'); return response.json();
  });
}
async function browserFee(actor: V2Browser, parentTxid: string, sponsor: { txid: string; vout: number }, core: PresignedRegtest,
  refundWallet?: ReturnType<typeof createPresignedFixture>['walletKeys'][ParticipantId], abortApproval = false) {
  runtimeStage = `fee: ${actor.id} prepare ${refundWallet ? 'funding' : 'runtime'} public draft`;
  console.log(JSON.stringify({ runtimeStage }));
  await reloadV2Vault(actor); const panel = feePanel(actor.page);
  await panel.getByRole('button', { name: 'Refresh fee rescue', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Approved parents and retained fee packages refreshed', { timeout: 60_000 });
  const parent = (await feeStatus(actor.page)).parents.find((item: any) => item.txid === parentTxid); assert(parent);
  await panel.getByLabel('Approved parent needing fee rescue').selectOption(`${parent.epochId}:${parent.proposalId ?? 'funding'}`);
  await panel.getByLabel('Confirmed sponsor transaction ID').fill(sponsor.txid);
  await panel.getByLabel('Sponsor output index').fill(String(sponsor.vout));
  await panel.getByLabel('Exact additional child fee (sats)').fill('1000');
  await panel.getByLabel('Target package rate (millisats/vB; 1000 = 1 sat/vB)').fill('1000');
  const draftEvent = actor.page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Build exact fee rescue', exact: true }).click();
  const draft = JSON.parse(await downloadedText(await draftEvent));
  assert.equal(draft.parentAuthorityDigest, parent.authorityDigest);
  await expect(panel.getByRole('status')).toContainText('Public fee draft downloaded');
  await panel.getByLabel('I approve this parent, sponsor coin, exact fee and unchanged payout/refund.').check();
  const psbtEvent = actor.page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download unsigned fee PSBT', exact: true }).click();
  const unsigned = await downloadedText(await psbtEvent);
  const wallet = await core.walletRpc('walletprocesspsbt', [unsigned, true, 'ALL', true, false]);
  await panel.getByLabel('Sponsor-only signed PSBT (base64)').fill(wallet.psbt);
  if (refundWallet) {
    const refund = bitcoin.Psbt.fromBase64(unsigned);
    if (refundWallet.kind === 'p2wpkh') refund.signInput(0, { publicKey: refundWallet.publicKey, sign: hash => ecc.sign(hash, refundWallet.privateKey) });
    else {
      const tx = bitcoin.Transaction.fromBuffer(refund.data.globalMap.unsignedTx.toBuffer());
      const hash = tx.hashForWitnessV1(0, refund.data.inputs.map(input => input.witnessUtxo!.script),
        refund.data.inputs.map(input => input.witnessUtxo!.value), bitcoin.Transaction.SIGHASH_DEFAULT);
      const even = refundWallet.publicKey[0] === 3 ? ecc.privateNegate(refundWallet.privateKey) : refundWallet.privateKey;
      const key = ecc.privateAdd(even, taggedHash('TapTweak', refundWallet.publicKey.subarray(1)))!;
      refund.updateInput(0, { tapKeySig: Buffer.from(ecc.signSchnorr(hash, key)) });
    }
    await panel.getByLabel('Refund-owner signed PSBT (base64)').fill(refund.toBase64());
  }
  runtimeStage = `fee: ${actor.id} sign exact child and approve or interrupt`;
  const route = '**/api/vault/presigned/fees/options';
  if (abortApproval) await actor.page.route(route, request => request.abort('failed'));
  try {
    const signedEvent = actor.page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Verify wallet signatures and approve exact fee package', exact: true }).click();
    const checked = validatePresignedFeePackage(JSON.parse(await downloadedText(await signedEvent)) as PresignedFeePackage);
    assert.equal(checked.completed.parentTxid, parentTxid);
    if (abortApproval) {
      await expect(panel.getByRole('status')).toContainText(/fetch|failed|Failed/u);
      assert(!(await feeStatus(actor.page)).packages.some((item: any) => item.package.parentAuthorityDigest === parent.authorityDigest));
    } else {
      await expect(panel.getByRole('status')).toContainText('durably approved');
      await expect.poll(async () => (await feeStatus(actor.page)).packages.some((item: any) =>
        item.status === 'approved' && validatePresignedFeePackage(item.package).completed.txid === checked.completed.txid)).toBe(true);
    }
    return checked;
  } finally { if (abortApproval) await actor.page.unroute(route); }
}
async function broadcastBrowserFee(actor: V2Browser, childTxid: string, core: PresignedRegtest) {
  runtimeStage = `fee: ${actor.id} broadcast exact approved child`;
  const article = feePanel(actor.page).locator('article').filter({ has: actor.page.getByRole('heading', { name: /^Retained fee package/u }) })
    .filter({ has: actor.page.locator('code', { hasText: childTxid }) });
  await article.getByRole('button', { name: 'Broadcast exact approved package', exact: true }).click();
  await expect(feePanel(actor.page).getByRole('status')).toContainText('Fee package accepted');
  await expect.poll(async () => (await core.rpc('getrawmempool')).includes(childTxid)).toBe(true);
}
function runtimeArticle(page: Page, txid: string): Locator { return runtimePanel(page).locator('article').filter({ has: page.locator('h3 + p code', { hasText: txid }) }); }
async function runtimeStatus(page: Page): Promise<any> {
  return page.evaluate(async () => { const response = await fetch('/api/vault/presigned/runtime/status', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`runtime status failed (${response.status})`); return response.json(); });
}
async function refreshChain(actor: V2Browser) {
  const panel = runtimePanel(actor.page);
  await panel.getByRole('button', { name: 'Refresh confirmed chain state' }).click();
  await expect(panel.getByRole('status')).toContainText('Private watcher refreshed');
}
async function createAndSignRuntime(actors: V2Browser[], kind: 'solo' | 'cooperative' | 'recovery' | 'final-sweep', core: PresignedRegtest) {
  const leader = actors[0]!;
  runtimeStage = `${kind}: ${leader.id} create proposal`;
  console.log(JSON.stringify({ runtimeStage }));
  await reloadV2Vault(leader); await refreshChain(leader);
  const before = new Set((await runtimeStatus(leader.page)).proposals.map((state: any) => state.proposal.proposalId));
  const name = { solo: 'Prepare my solo exit', cooperative: 'Propose cooperative exit', recovery: 'Propose timelocked recovery',
    'final-sweep': 'Prepare final-owner sweep' }[kind];
  await runtimePanel(leader.page).getByRole('button', { name, exact: true }).click();
  await expect.poll(async () => (await runtimeStatus(leader.page)).proposals.some((state: any) => !before.has(state.proposal.proposalId))).toBe(true);
  const proposed = (await runtimeStatus(leader.page)).proposals.find((state: any) => !before.has(state.proposal.proposalId));
  const txid: string = proposed.proposal.txid;
  if (kind === 'cooperative') {
    for (const actor of actors) {
      runtimeStage = `${kind}: ${actor.id} commit nonce`;
      await reloadV2Vault(actor); const article = runtimeArticle(actor.page, txid);
      await article.getByRole('checkbox').check();
      await article.getByRole('button', { name: 'Commit fresh cooperative nonce' }).click();
      await expect.poll(async () => (await runtimeStatus(actor.page)).proposals.find((state: any) => state.proposal.txid === txid)
        .publicNonces.some((entry: any) => entry.participantId === actor.id)).toBe(true);
    }
  }
  for (const actor of actors) {
    runtimeStage = `${kind}: ${actor.id} sign exact transaction`;
    await reloadV2Vault(actor); const article = runtimeArticle(actor.page, txid);
    await article.getByRole('checkbox').check();
    await article.getByRole('button', { name: kind === 'cooperative' ? 'Sign cooperative partial' : 'Sign exact transaction', exact: true }).click();
    await expect.poll(async () => { const current = (await runtimeStatus(actor.page)).proposals.find((state: any) => state.proposal.txid === txid);
      return kind === 'cooperative' ? current.partials.some((item: any) => item.participantId === actor.id)
        : kind === 'recovery' ? current.recoveryContributions.some((item: any) => item.participantId === actor.id) : Boolean(current.finalized); }).toBe(true);
  }
  const state = (await runtimeStatus(leader.page)).proposals.find((item: any) => item.proposal.txid === txid);
  assert(state.finalized, 'browser signing did not finalize the runtime transaction');
  const policy = await core.rpc('testmempoolaccept', [[state.finalized.transactionHex]]);
  assert.equal(policy[0].allowed, true, 'actual Core did not accept the browser-signed runtime transaction');
  for (const actor of actors) {
    if (!state.finalized.approverParticipantIds.includes(actor.id)) continue;
    runtimeStage = `${kind}: ${actor.id} approve broadcast`;
    if (kind === 'final-sweep') {
      // Reproduce cookie expiry at the exact boundary observed in the long
      // drill. No credentials or server sessions are manufactured by the test.
      await actor.context.clearCookies();
      const denied = await actor.page.evaluate(async () => {
        const response = await fetch('/api/vault/presigned/runtime/status', { credentials: 'same-origin', cache: 'no-store' });
        return { ok: response.ok, error: (await response.json()).error };
      });
      assert.equal(denied.ok, false); assert.match(denied.error, /authentication required/u);
    }
    await reloadV2Vault(actor); const article = runtimeArticle(actor.page, txid);
    await article.getByRole('checkbox').check();
    await article.getByRole('button', { name: 'Approve exact signed bytes for broadcast' }).click();
    await expect.poll(async () => (await runtimeStatus(actor.page)).proposals.find((item: any) => item.proposal.txid === txid)
      .broadcastApprovals.includes(actor.id)).toBe(true);
  }
  return (await runtimeStatus(leader.page)).proposals.find((item: any) => item.proposal.txid === txid);
}
