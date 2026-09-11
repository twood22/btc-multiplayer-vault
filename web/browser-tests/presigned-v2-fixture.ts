/** Real virtual-PRF browsers and real regtest facts. ONLY chain/genesis labels are bridged for the Signet bundle. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, type Browser, type BrowserContext, type CDPSession, type Page, type Request } from '@playwright/test';
import type postgres from 'postgres';
import { BITCOIN_CORE_CHAIN, BITCOIN_GENESIS_HASH } from '../../src/network.js';
import { newPresignedCeremony, type PresignedCeremonySettings } from '../../src/presigned/ceremony.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from '../../src/presigned/types.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import type { PresignedCeremonyStatus } from '../lib/server/presigned-store.js';
import type { PresignedRegtest } from '../../scripts/lib/presigned-regtest.js';
import { boundedPresignedBrowserCleanup } from './presigned-failure-report';

export interface V2Browser { id: ParticipantId; context: BrowserContext; page: Page; cdp: CDPSession;
  primary: string; recovery: string; authenticatedAt: number; reauthentications: number;
  diagnostics: { pageErrors: number; crashes: number; failedScriptRequests: number } }
export interface V2BrowserAudit { forbidden: string[]; unexpected: string[]; chainRequests: number;
  rpcMethods: string[]; sensitiveRequestDetected: boolean; walletReleaseLocalGates: boolean[] }

export async function seedV2Invitations(sql: ReturnType<typeof postgres>, settings: PresignedCeremonySettings) {
  const vaultId = randomUUID();
  const state = newPresignedCeremony(vaultId, settings);
  const invitations = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomBytes(32).toString('base64url')])) as Record<ParticipantId, string>;
  await sql`INSERT INTO vaults(id,name,protocol) VALUES (${vaultId}::uuid,'Isolated presigned browser acceptance',${PRESIGNED_PROTOCOL})`;
  await sql`INSERT INTO presigned_ceremonies(vault_id,settings_json,settings_digest,state_json,state_digest)
    VALUES (${vaultId}::uuid,${sql.json(state.settings as never)},${Buffer.from(state.settingsDigest,'hex')},
      ${sql.json(state as never)},${Buffer.from(commitmentDigest('vault/presigned-graph-v2/ceremony/state',state),'hex')})`;
  for (const id of PARTICIPANT_IDS) await sql`INSERT INTO invites(vault_id,participant_id,token_hash,expires_at)
    VALUES (${vaultId}::uuid,${id},${createHash('sha256').update(invitations[id]).digest()},now()+interval '1 hour')`;
  return { vaultId, invitations };
}

export async function createV2Browser(input: { browser: Browser; baseURL: string; id: ParticipantId;
  invitation: string; audit: V2BrowserAudit }): Promise<V2Browser> {
  const context = await input.browser.newContext({ baseURL: input.baseURL, acceptDownloads: true });
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  // Counts only: never retain exception text, script URLs or request payloads.
  const diagnostics = { pageErrors: 0, crashes: 0, failedScriptRequests: 0 };
  page.on('pageerror', () => { diagnostics.pageErrors++; });
  page.on('crash', () => { diagnostics.crashes++; });
  page.on('requestfailed', request => { if (request.resourceType() === 'script') diagnostics.failedScriptRequests++; });
  context.on('request', request => auditRequest(request, input.audit));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId: primary } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticator('internal', true) });
  let recovery = '';
  try {
    try { await page.goto(`/join/${input.invitation}`); }
    catch { throw new Error('Disposable invitation navigation failed (bearer URL redacted)'); }
    await page.getByLabel('Your name').fill(`${input.id} acceptance`);
    await page.getByRole('button', { name: 'Create my passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Your seat is secured' })).toBeVisible();
    const readiness = page.getByTestId('setup-funding-requirements');
    await expect(readiness).toContainText('both distinct passkeys and their saved offline recovery kit');
    await expect(readiness).toContainText('independently verify the same graph and exact payouts');
    await expect(readiness).toContainText('presigned');
    await expect(readiness).not.toContainText(/Sigbash|second passkey or/i);
    await page.goto('/vault');
    await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toBeVisible();
    recovery = (await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticator('usb', false) })).authenticatorId;
    let switched = false;
    const onAssert = (event: { authenticatorId: string }) => {
      if (switched || event.authenticatorId !== primary) return;
      switched = true;
      void Promise.all([cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: primary, enabled: false }),
        cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: recovery, enabled: true })]);
    };
    cdp.on('WebAuthn.credentialAsserted', onAssert);
    await page.getByLabel('Recovery passkey name').fill(`${input.id} recovery key`);
    await page.getByRole('button', { name: 'Add recovery passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toHaveCount(0);
    cdp.off('WebAuthn.credentialAsserted', onAssert);
    const actor = { id: input.id, context, page, cdp, primary, recovery, authenticatedAt: Date.now(), reauthentications: 0, diagnostics };
    await useV2Authenticator(actor, 'primary');
    await expect(page.getByTestId('presigned-ceremony')).toBeVisible();
    return actor;
  } catch {
    await boundedPresignedBrowserCleanup(() => context.close());
    throw new Error(`Virtual PRF onboarding failed for ${input.id}; invitation and authenticator details redacted`);
  }
}
export async function useV2Authenticator(actor: V2Browser, chosen: 'primary' | 'recovery') {
  await actor.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: actor.primary, enabled: chosen === 'primary' });
  await actor.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: actor.recovery, enabled: chosen === 'recovery' });
}
/** Long cryptographic drills can outlast the real fifteen-minute session.
 * Authenticate through the actual passkey login UI; never lengthen sessions,
 * forge cookies, bypass authentication, or replace the encrypted local state. */
export async function reloadV2Vault(actor: V2Browser) {
  const renew = Date.now() - actor.authenticatedAt >= 8 * 60_000;
  await actor.page.goto(renew ? '/' : '/vault');
  if (new URL(actor.page.url()).pathname === '/') {
    await useV2Authenticator(actor, 'primary');
    await actor.page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await expect(actor.page.getByTestId('presigned-ceremony')).toBeVisible({ timeout: 60_000 });
    const current = await v2Status(actor.page);
    assert.equal(current.participantId, actor.id, 'passkey reauthentication selected a different participant');
    actor.authenticatedAt = Date.now(); actor.reauthentications++;
  }
  await expect(actor.page.getByTestId('presigned-ceremony')).toBeVisible({ timeout: 60_000 });
  // Visibility alone can describe inert server HTML. Do not remove the guard
  // or force a click: require the genuine hydration effect to make it usable.
  await expect(actor.page.locator('body')).not.toHaveAttribute('inert', { timeout: 60_000 });
  await expect(actor.page.locator('body')).not.toHaveAttribute('aria-busy', { timeout: 60_000 });
}
export async function v2Status(page: Page): Promise<PresignedCeremonyStatus> {
  return page.evaluate(async () => {
    const response = await fetch('/api/vault/presigned/status', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(`V2 status failed (${response.status})`);
    return response.json();
  });
}
export async function localV2Gate(page: Page, graphDigest: string) {
  return page.evaluate(digest => {
    const records = Object.keys(localStorage).filter(key => key.startsWith('presigned-local-v2:'))
      .map(key => JSON.parse(localStorage.getItem(key)!)) as Array<Record<string, any>>;
    const backups = records.filter(record => record.kind === 'backup-restored' && record.graphDigest === digest);
    return { compared: records.some(record => record.kind === 'roster-compared'),
      reviewed: records.some(record => record.kind === 'graph-reviewed' && record.graphDigest === digest),
      offline: backups.some(record => record.backupKind === 'offline'),
      passkeys: new Set(backups.filter(record => record.backupKind === 'passkey').map(record => record.credentialId)).size,
      intent: records.some(record => record.kind === 'wallet-signing-started' && record.graphDigest === digest) };
  }, graphDigest);
}

export async function startV2CoreBridge(core: PresignedRegtest, port: number, audit: V2BrowserAudit) {
  const allowed = new Set(['getblockchaininfo','getindexinfo','getblockhash','getblockheader','getrawtransaction','gettxout',
    'getrawmempool','getmempoolentry','testmempoolaccept','sendrawtransaction','submitpackage','getmempoolinfo','getnetworkinfo','gettxspendingprevout']);
  const server = createServer((request, response) => { void (async () => {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('presigned-browser-test:public-test-fixture').toString('base64')}`);
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; assert(length <= 1_000_000); chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; params: unknown[]; id: unknown };
    assert(allowed.has(body.method), 'unapproved test RPC method'); audit.rpcMethods.push(body.method);
    let result: unknown;
    if (body.method === 'getblockhash' && body.params[0] === 0) result = BITCOIN_GENESIS_HASH;
    else {
      result = await core.rpc(body.method, body.params);
      if (body.method === 'getblockchaininfo') result = { ...(result as object), chain: BITCOIN_CORE_CHAIN };
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: body.id, result, error: null }));
  })().catch(error => {
    const code = typeof error?.rpcCode === 'number' ? error.rpcCode : -1;
    if (code === -1) audit.unexpected.push('private RPC bridge rejected an unexpected request');
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: null, error: { code, message: 'isolated Core request rejected' }, id: null }));
  }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

export async function installV2EsploraBridge(actor: V2Browser, core: PresignedRegtest, audit: V2BrowserAudit) {
  await actor.context.route('https://chain.example/api/**', async route => {
    audit.chainRequests += 1;
    try {
      const request = route.request(); const headers = await request.allHeaders();
      assert(!headers.cookie && !headers.authorization && !headers.referer, 'browser chain request leaked coordinator credentials or referrer');
      const path = new URL(request.url()).pathname.slice(4);
      let result: unknown; let text = false;
      if (path === '/blocks/tip/hash') { result = await core.rpc('getbestblockhash'); text = true; }
      else if (path.startsWith('/block-height/')) {
        const height = Number(path.slice('/block-height/'.length));
        result = height === 0 ? BITCOIN_GENESIS_HASH : await core.rpc('getblockhash', [height]); text = true;
      } else if (/^\/block\/[0-9a-f]{64}$/u.test(path)) {
        const header = await core.rpc('getblockheader', [path.slice('/block/'.length), true]);
        result = { id: header.hash, height: header.height };
      } else {
        const match = /^\/tx\/([0-9a-f]{64})\/(hex|status|outspend\/\d+)$/u.exec(path);
        assert(match, 'unexpected Esplora test path');
        const [, txid, operation] = match;
        if (operation === 'hex') { result = await core.rpc('getrawtransaction', [txid, false]); text = true; }
        else if (operation === 'status') {
          const raw = await core.rpc('getrawtransaction', [txid, true]);
          const header = raw.blockhash ? await core.rpc('getblockheader', [raw.blockhash, true]) : null;
          result = header && header.confirmations > 0 ? { confirmed: true, block_hash: header.hash, block_height: header.height } : { confirmed: false };
        } else {
          const vout = Number(operation!.slice('outspend/'.length));
          const available = await core.rpc('gettxout', [txid, vout, true]);
          if (available) result = { spent: false };
          else {
            const onChain = await core.rpc('gettxout', [txid, vout, false]);
            if (!onChain) result = { spent: true, status: { confirmed: true } };
            else {
              const spenders = await core.rpc('gettxspendingprevout', [[{ txid, vout }]]);
              assert(/^[0-9a-f]{64}$/u.test(spenders[0]?.spendingtxid), 'pending Core spender lookup raced');
              result = { spent: true, txid: spenders[0].spendingtxid, status: { confirmed: false } };
            }
          }
        }
      }
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        contentType: text ? 'text/plain' : 'application/json', body: text ? String(result) : JSON.stringify(result) });
    } catch (error) {
      // Core -5 is authoritative absence, which real Esplora represents with
      // 404. Keep outages and malformed observations as 503/unknown. The
      // pre-broadcast fee workflow legitimately queries an absent parent.
      if ((error as { rpcCode?: number }).rpcCode === -5 &&
        /^\/api\/tx\/[0-9a-f]{64}\/(status|hex)$/u.test(new URL(route.request().url()).pathname)) {
        await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
          body: 'transaction not found' });
        return;
      }
      audit.unexpected.push('independent Esplora bridge could not establish requested Core facts');
      await route.fulfill({ status: 503, body: 'isolated chain observation unavailable' });
    }
  });
}
function auditRequest(request: Request, audit: V2BrowserAudit) {
  const url = new URL(request.url());
  if (url.hostname.endsWith('sigbash.com') || url.pathname.startsWith('/api/sigbash/')) audit.forbidden.push(`${url.hostname}${url.pathname}`);
  const data = request.postData();
  if (data && /"(?:participantSecret|prfOutput|secretNonce|personalPrivateKey|payoutPrivateKey)"\s*:/u.test(data)) audit.sensitiveRequestDetected = true;
  if (data) { try { const body = JSON.parse(data);
    if (body?.response?.clientExtensionResults?.prf?.results) audit.sensitiveRequestDetected = true;
  } catch { /* non-JSON internal transport */ } }
}
function authenticator(transport: 'internal' | 'usb', automaticPresenceSimulation: boolean) {
  return { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport, hasResidentKey: true, hasUserVerification: true,
    automaticPresenceSimulation, isUserVerified: true, hasPrf: true } as const;
}
