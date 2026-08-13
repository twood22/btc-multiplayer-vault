import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import postgres from 'postgres';
import { deterministicKeypair, sha256Hex } from '../../src/crypto.js';
import type { FundingProposal } from '../../src/funding-ceremony.js';
import { MAINNET_GENESIS_HASH } from '../../src/network.js';
import { unsignedTx } from '../../src/psbt.js';
import {
  createConfirmedParticipantFixture,
  disposeParticipantFixture,
  participants,
  seedSyntheticSigbashReadinessPrerequisite,
  type ConfirmedParticipantFixture,
  type ParticipantBrowser,
  type ParticipantId,
} from './participant-fixture';

interface WalletCoin {
  participantId: ParticipantId;
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
}

interface BrowserFundingStatus {
  proposal: FundingProposal | null;
  finalization: null | {
    finalTxid: string;
    finalizationDigest: string;
    transactionHex: string;
    approvedParticipantIds: string[];
    readyForOperatorBroadcast: boolean;
  };
}

const walletKeys = Object.fromEntries(participants.map((participantId) => [
  participantId,
  deterministicKeypair('funding-wallet-browser-acceptance', participantId),
])) as Record<ParticipantId, ReturnType<typeof deterministicKeypair>>;

const walletCoins: WalletCoin[] = participants.map((participantId, index) => ({
  participantId,
  txid: sha256Hex(`funding-wallet-browser-coin:${participantId}`),
  vout: 0,
  valueSats: 10_530,
  scriptPubKeyHex: index === 0
    ? Buffer.from(bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(walletKeys[participantId].publicKeyHex, 'hex'),
        network: bitcoin.networks.bitcoin,
      }).output!).toString('hex')
    : `5120${walletKeys[participantId].xonlyPubKeyHex}`,
}));

test('three passkey participants coordinate independent wallet-format signatures without broadcasting', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error('browser test base URL is required');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for funding-wallet browser acceptance');
  const corePort = Number(process.env.BROWSER_CHAIN_FIXTURE_PORT);
  if (!Number.isSafeInteger(corePort) || corePort < 1024 || corePort > 65535) {
    throw new Error('BROWSER_CHAIN_FIXTURE_PORT is required for isolated funding-wallet acceptance');
  }
  const coreMethods: string[] = [];
  const unexpectedCoreRequests: string[] = [];
  const core = await startMainnetCoreFixture(corePort, coreMethods, unexpectedCoreRequests);
  const sql = postgres(databaseUrl, { max: 4 });
  const forbiddenRequests: string[] = [];
  let fixture: ConfirmedParticipantFixture | null = null;
  const browserChainRequests: string[] = [];
  const unexpectedBrowserChainRequests: string[] = [];

  try {
    fixture = await createConfirmedParticipantFixture({
      browser,
      baseURL,
      sql,
      name: 'Three external-wallet browser acceptance',
      onRequest: forbiddenMutationRecorder(forbiddenRequests),
    });
    await seedSyntheticSigbashReadinessPrerequisite(sql, fixture);
    await installBrowserChainFixture(
      fixture.browsers,
      browserChainRequests,
      unexpectedBrowserChainRequests,
    );

    for (const participant of fixture.browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', {
        name: 'Approve your own funding coin',
      })).toBeVisible();
      const coin = walletCoins.find((item) => item.participantId === participant.id)!;
      const rosterParticipant = fixture.artifact.participants
        .find((item) => item.id === participant.id)!;
      await participant.page.getByLabel('Wallet transaction ID').fill(coin.txid);
      await participant.page.getByLabel('Output number').fill(String(coin.vout));
      await participant.page.getByLabel(
        'Change address (leave blank only for an exact-value coin)',
      ).fill(rosterParticipant.payoutAddress);
      await participant.page.getByRole('button', { name: 'Verify and approve my coin' }).click();
      await expect(participant.page.getByText(participant.id === 'carol'
        ? 'All three real wallet inputs are approved; the exact unsigned PSBT is ready for wallet signing.'
        : /Your real wallet input is approved; waiting for friends/u)).toBeVisible();
    }

    const statuses: BrowserFundingStatus[] = [];
    for (const participant of fixture.browsers) {
      await participant.page.reload();
      await expect(participant.page.getByRole('heading', {
        name: 'Exact funding transaction assembled',
      })).toBeVisible();
      statuses.push(await fundingStatus(participant.page));
    }
    expect(statuses.every((status) => status.proposal)).toBe(true);
    expect(new Set(statuses.map((status) => status.proposal!.digest)).size).toBe(1);
    expect(new Set(statuses.map((status) => status.proposal!.psbtBase64)).size).toBe(1);
    const proposal = statuses[0]!.proposal!;

    for (const [index, participant] of fixture.browsers.entries()) {
      const walletSignedPsbt = signOnlyParticipantInput(proposal.psbtBase64, participant.id);
      await participant.page.getByLabel('PSBT returned by your external wallet').fill(walletSignedPsbt);
      await participant.page.getByRole('button', {
        name: 'Verify and approve my wallet signature',
      }).click();
      await expect(participant.page.getByText(index === fixture.browsers.length - 1
        ? 'All three wallet signatures verify and the exact final transaction reproduces here. Review it before final passkey approval.'
        : /Your wallet signature is verified; waiting for friends/u)).toBeVisible();
    }

    for (const participant of fixture.browsers) {
      await participant.page.reload();
      await expect(participant.page.getByRole('heading', {
        name: 'Exact finalized transaction',
      })).toBeVisible();
      await participant.page.getByRole('button', { name: 'Approve exact final transaction' }).click();
      await expect(participant.page.getByText(participant.id === 'carol'
        ? 'Unanimous final approval recorded. Funding is still not broadcast; the separate operator release gate remains closed.'
        : /Your final approval is recorded/u)).toBeVisible();
    }

    for (const participant of fixture.browsers) {
      await participant.page.reload();
      await expect(participant.page.getByText(
        'All three wallets signed and all three passkeys approved the exact final transaction. Operator release gates still remain closed.',
      )).toBeVisible();
      await expect(participant.page.getByRole('button', {
        name: 'Approve exact final transaction',
      })).toHaveCount(0);
    }

    const rows = await sql<Array<{
      vault_status: string;
      finalization_status: string;
      final_txid: Buffer;
      transaction_hex: string;
      inputs: number;
      signatures: number;
      approvals: number;
      readiness: number;
      current_coins: number;
      signature_kinds: string[];
      submission_started_at: Date | null;
      broadcast_at: Date | null;
    }>>`
      SELECT v.status AS vault_status, f.status AS finalization_status,
        f.final_txid, f.transaction_hex, f.submission_started_at, f.broadcast_at,
        (SELECT count(*)::integer FROM participant_funding_inputs i
          WHERE i.vault_id = v.id) AS inputs,
        (SELECT count(*)::integer FROM participant_funding_signatures s
          WHERE s.vault_id = v.id) AS signatures,
        (SELECT count(*)::integer FROM funding_final_approvals a
          WHERE a.vault_id = v.id) AS approvals,
        (SELECT count(*)::integer FROM participant_sigbash_readiness_proofs r
          WHERE r.vault_id = v.id) AS readiness,
        (SELECT count(*)::integer FROM vault_coins c
          WHERE c.vault_id = v.id AND c.status = 'current') AS current_coins,
        (SELECT array_agg(s.signature_kind ORDER BY s.input_index)
          FROM participant_funding_signatures s WHERE s.vault_id = v.id) AS signature_kinds
      FROM vaults v JOIN funding_finalizations f ON f.vault_id = v.id
      WHERE v.id = ${fixture.vaultId}::uuid
    `;
    expect(rows).toHaveLength(1);
    const result = rows[0]!;
    expect(result.vault_status).toBe('ready');
    expect(result.finalization_status).toBe('approved');
    expect(result.inputs).toBe(3);
    expect(result.signatures).toBe(3);
    expect(result.approvals).toBe(3);
    expect(result.readiness).toBe(9);
    expect(result.current_coins).toBe(0);
    expect(result.signature_kinds).toEqual(['p2wpkh', 'p2tr', 'p2tr']);
    expect(result.submission_started_at).toBeNull();
    expect(result.broadcast_at).toBeNull();

    const transaction = bitcoin.Transaction.fromHex(result.transaction_hex);
    expect(transaction.getId()).toBe(result.final_txid.toString('hex'));
    expect(transaction.getId()).toBe(proposal.unsignedTxid);
    expect(transaction.ins.map((input) => input.witness.length)).toEqual([2, 1, 1]);
    expect(transaction.outs).toHaveLength(4);
    expect(Number(transaction.outs[0]!.value)).toBe(fixture.artifact.funding.valueSats);
    expect(Buffer.from(transaction.outs[0]!.script).toString('hex'))
      .toBe(fixture.artifact.funding.outputScriptHex);
    expect(transaction.outs.slice(1).map((output) => Number(output.value))).toEqual([330, 330, 330]);
    expect(browserChainRequests).toHaveLength(12);
    expect(coreMethods.filter((method) => method === 'getblockchaininfo')).toHaveLength(6);
    expect(coreMethods.filter((method) => method === 'getindexinfo')).toHaveLength(6);
    expect(coreMethods.filter((method) => method === 'gettxout')).toHaveLength(6);
    expect(unexpectedBrowserChainRequests).toEqual([]);
    expect(unexpectedCoreRequests).toEqual([]);
    expect(forbiddenRequests).toEqual([]);
  } finally {
    if (fixture) await disposeParticipantFixture(sql, fixture);
    await core.close();
  }
});

function signOnlyParticipantInput(psbtBase64: string, participantId: ParticipantId): string {
  const index = participants.indexOf(participantId);
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
  const key = walletKeys[participantId];
  if (index === 0) {
    psbt.signInput(index, {
      publicKey: Buffer.from(key.publicKeyHex, 'hex'),
      sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, Buffer.from(key.privateKeyHex, 'hex'))),
    }, [bitcoin.Transaction.SIGHASH_ALL]);
  } else {
    const transaction = unsignedTx(psbt);
    const scripts = psbt.data.inputs.map((input) => input.witnessUtxo!.script);
    const values = psbt.data.inputs.map((input) => input.witnessUtxo!.value);
    const sighash = transaction.hashForWitnessV1(
      index,
      scripts,
      values,
      bitcoin.Transaction.SIGHASH_DEFAULT,
    );
    psbt.updateInput(index, {
      tapKeySig: Buffer.from(ecc.signSchnorr(
        sighash,
        Buffer.from(key.privateKeyHex, 'hex'),
      )),
    });
  }
  return psbt.toBase64();
}

async function fundingStatus(page: Page): Promise<BrowserFundingStatus> {
  return page.evaluate(async () => {
    const response = await fetch('/api/vault/funding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`funding status failed (${response.status})`);
    return response.json();
  });
}

async function installBrowserChainFixture(
  browsers: ParticipantBrowser[],
  requests: string[],
  unexpected: string[],
): Promise<void> {
  for (const participant of browsers) {
    await participant.page.route('https://chain.example/api/**', async (route) => {
      const requestUrl = route.request().url();
      requests.push(requestUrl);
      const url = new URL(requestUrl);
      if (url.pathname === '/api/block-height/0') {
        await route.fulfill({ status: 200, contentType: 'text/plain', body: MAINNET_GENESIS_HASH });
        return;
      }
      const txid = url.pathname.match(/^\/api\/tx\/([0-9a-f]{64})$/u)?.[1];
      if (txid) {
        const coin = walletCoins.find((item) => item.txid === txid);
        if (coin) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              txid: coin.txid,
              vout: [{ scriptpubkey: coin.scriptPubKeyHex, value: coin.valueSats }],
              status: { confirmed: true, block_height: 850000 },
            }),
          });
          return;
        }
      }
      const outspend = url.pathname.match(/^\/api\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/u);
      if (outspend && walletCoins.some((item) =>
        item.txid === outspend[1] && item.vout === Number(outspend[2]))) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"spent":false}' });
        return;
      }
      if (url.pathname === '/api/blocks/tip/height') {
        await route.fulfill({ status: 200, contentType: 'text/plain', body: '850005' });
        return;
      }
      unexpected.push(requestUrl);
      await route.fulfill({ status: 404, body: 'unexpected funding chain fixture request' });
    });
  }
}

function forbiddenMutationRecorder(target: string[]): (requestUrl: string) => void {
  return (requestUrl) => {
    const url = new URL(requestUrl);
    if (url.hostname.endsWith('sigbash.com') ||
        /^\/api\/sigbash\/(?:runtime|provision|readiness)(?:\/|$)/u.test(url.pathname) ||
        /(?:^|\/)broadcast(?:\/|$)/u.test(url.pathname)) {
      target.push(requestUrl);
    }
  };
}

async function startMainnetCoreFixture(
  port: number,
  methods: string[],
  unexpected: string[],
): Promise<{ close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleCoreRequest(request, response, methods, unexpected).catch((error) => {
      unexpected.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: null, error: { code: -1, message: 'fixture failure' } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleCoreRequest(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string[],
  unexpected: string[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    id?: unknown;
    method?: unknown;
    params?: unknown[];
  };
  const method = typeof body.method === 'string' ? body.method : '';
  methods.push(method);
  let result: unknown;
  if (request.method !== 'POST' || request.url !== '/') {
    unexpected.push(`${request.method || ''} ${request.url || ''}`);
    result = null;
  } else if (method === 'getblockchaininfo') {
    result = {
      chain: 'main',
      blocks: 850005,
      headers: 850005,
      pruned: false,
      initialblockdownload: false,
    };
  } else if (method === 'getindexinfo') {
    result = { txindex: { synced: true, best_block_height: 850005 } };
  } else if (method === 'gettxout') {
    const txid = String(body.params?.[0] || '');
    const vout = Number(body.params?.[1]);
    const coin = walletCoins.find((item) => item.txid === txid && item.vout === vout);
    if (!coin) {
      unexpected.push(`gettxout ${txid}:${String(vout)}`);
      result = null;
    } else {
      result = {
        bestblock: 'ab'.repeat(32),
        confirmations: 6,
        value: coin.valueSats / 100_000_000,
        scriptPubKey: { hex: coin.scriptPubKeyHex },
        coinbase: false,
      };
    }
  } else {
    unexpected.push(method || 'missing method');
    result = null;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ result, error: null, id: body.id ?? null }));
}
