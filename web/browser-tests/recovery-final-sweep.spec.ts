import { expect, test } from '@playwright/test';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { verifyVaultTransaction } from '../../src/consensus.js';
import { sha256Hex } from '../../src/crypto.js';
import { MAINNET_GENESIS_HASH } from '../../src/network.js';
import type { VaultCoinSnapshot } from '../../src/vault-runtime.js';
import {
  createConfirmedParticipantFixture,
  disposeParticipantFixture,
  type ParticipantBrowser,
} from './participant-fixture';

test('two passkey-held survivors finalize mature recovery without the vanished participant', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error('browser test base URL is required');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for recovery browser acceptance');
  const sql = postgres(databaseUrl, { max: 4 });
  const forbiddenSigbashRequests: string[] = [];
  const fixture = await createConfirmedParticipantFixture({
    browser,
    baseURL,
    sql,
    name: 'Distributed recovery browser acceptance',
    onRequest: forbiddenSigbashRecorder(forbiddenSigbashRequests),
  });
  const chainRequests: string[] = [];
  const unexpectedChainRequests: string[] = [];

  try {
    const coin: VaultCoinSnapshot = {
      vaultId: fixture.vaultId,
      rosterDigest: fixture.rosterDigest,
      kind: 'vault',
      roundId: fixture.artifact.funding.round,
      ownerParticipantId: null,
      txid: sha256Hex(`recovery-browser-coin:${fixture.vaultId}`),
      vout: 0,
      valueSats: fixture.artifact.funding.valueSats,
      scriptPubKeyHex: fixture.artifact.funding.outputScriptHex,
    };
    await seedCurrentCoin(sql, fixture.vaultId, fixture.rosterDigest, coin, 849855);
    await installChainFixture(
      fixture.browsers,
      coin,
      849855,
      850000,
      chainRequests,
      unexpectedChainRequests,
    );

    const alice = fixture.browsers.find((item) => item.id === 'alice')!;
    const bob = fixture.browsers.find((item) => item.id === 'bob')!;
    const carol = fixture.browsers.find((item) => item.id === 'carol')!;
    for (const participant of fixture.browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', { name: 'Current Bitcoin coin' })).toBeVisible();
    }

    for (const survivor of [alice, bob]) {
      await survivor.page.getByRole('button', { name: 'Verify current coin' }).click();
      await expect(survivor.page.getByText(
        'Mainnet coin verified with your passkey (146 confirmation(s))',
      )).toBeVisible();
    }
    await expect(alice.page.getByRole('button', { name: 'Start recovery without carol' })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Start recovery without carol' }).click();
    await expect(alice.page.getByText(
      'Timelocked recovery for absent participant carol proposed; nothing has been signed or broadcast',
    )).toBeVisible();
    await bob.page.reload();
    await carol.page.reload();
    await expect(carol.page.getByRole('button', {
      name: 'Recheck mainnet and sign recovery',
    })).toHaveCount(0);

    await alice.page.getByRole('button', { name: 'Recheck mainnet and sign recovery' }).click();
    await expect(alice.page.getByText(
      'Your recovery share is verified; waiting for 1 more',
    )).toBeVisible();
    await bob.page.getByRole('button', { name: 'Recheck mainnet and sign recovery' }).click();
    await expect(bob.page.getByText(
      /All recovery shares verified; transaction finalized as/u,
    )).toBeVisible();

    for (const survivor of [alice, bob]) {
      await survivor.page.reload();
      await expect(survivor.page.getByText(
        'Recovery finalized and held for explicit broadcast approval.',
      )).toBeVisible();
      await expect(survivor.page.getByText('Ready for explicit mainnet broadcast')).toBeVisible();
      await expect(survivor.page.getByRole('button', {
        name: 'Approve with passkey and broadcast to mainnet',
      })).toBeDisabled();
    }
    await carol.page.reload();
    await expect(carol.page.getByText(
      'Recovery finalized and held for explicit broadcast approval.',
    )).toBeVisible();
    await expect(carol.page.getByText('Ready for explicit mainnet broadcast')).toHaveCount(0);

    const rows = await sql<Array<{
      status: string;
      finalized_tx_hex: string;
      final_txid: Buffer;
      shares: number;
      broadcasts: number;
      current_coins: number;
      payloads: Array<Record<string, unknown>>;
    }>>`
      SELECT p.status, p.finalized_tx_hex, p.final_txid,
        (SELECT count(*)::integer FROM vault_proposal_contributions c
          WHERE c.proposal_id = p.id AND c.kind = 'recovery_share') AS shares,
        (SELECT count(*)::integer FROM vault_broadcast_approvals b
          WHERE b.proposal_id = p.id) AS broadcasts,
        (SELECT count(*)::integer FROM vault_coins vc
          WHERE vc.vault_id = p.vault_id AND vc.status = 'current') AS current_coins,
        (SELECT jsonb_agg(c.payload_json ORDER BY c.participant_id)
          FROM vault_proposal_contributions c
          WHERE c.proposal_id = p.id AND c.kind = 'recovery_share') AS payloads
      FROM vault_transaction_proposals p
      WHERE p.vault_id = ${fixture.vaultId}::uuid AND p.kind = 'recovery'
    `;
    expect(rows).toHaveLength(1);
    const result = rows[0]!;
    expect(result.status).toBe('finalized');
    expect(result.shares).toBe(2);
    expect(result.broadcasts).toBe(0);
    expect(result.current_coins).toBe(1);
    expect(result.payloads.map((payload) => payload.participantId)).toEqual(['alice', 'bob']);
    for (const payload of result.payloads) {
      expect(Object.keys(payload).sort()).toEqual([
        'leafHashHex', 'participantId', 'round', 'signatureHex',
        'unsignedTxid', 'vanishedId', 'xonlyPubkey',
      ]);
    }
    const transaction = bitcoin.Transaction.fromHex(result.finalized_tx_hex);
    expect(transaction.getId()).toBe(result.final_txid.toString('hex'));
    expect(transaction.ins[0]!.sequence).toBe(fixture.artifact.economics.recoveryDelayBlocks);
    const consensus = verifyVaultTransaction({
      txHex: result.finalized_tx_hex,
      prevouts: [{ scriptPubKeyHex: coin.scriptPubKeyHex, valueSats: coin.valueSats }],
    });
    expect(consensus.checks.some((item) => item.includes('multi_a 2-of-3 satisfied'))).toBe(true);
    expect(chainRequests).toHaveLength(20);
    expect(unexpectedChainRequests).toEqual([]);
    expect(forbiddenSigbashRequests).toEqual([]);
  } finally {
    await disposeParticipantFixture(sql, fixture);
  }
});

test('only the final payout owner passkey-signs the exact final sweep', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error('browser test base URL is required');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for final-sweep browser acceptance');
  const sql = postgres(databaseUrl, { max: 4 });
  const forbiddenSigbashRequests: string[] = [];
  const fixture = await createConfirmedParticipantFixture({
    browser,
    baseURL,
    sql,
    name: 'Final payout browser acceptance',
    onRequest: forbiddenSigbashRecorder(forbiddenSigbashRequests),
  });
  const chainRequests: string[] = [];
  const unexpectedChainRequests: string[] = [];

  try {
    const carolEntry = fixture.artifact.participants.find((item) => item.id === 'carol')!;
    const finalValueSats = fixture.artifact.funding.valueSats
      - fixture.artifact.economics.firstWithdrawalSats
      - fixture.artifact.economics.secondWithdrawalSats
      - 2 * fixture.artifact.economics.soloWithdrawalFeeSats;
    const coin: VaultCoinSnapshot = {
      vaultId: fixture.vaultId,
      rosterDigest: fixture.rosterDigest,
      kind: 'final_payout',
      roundId: null,
      ownerParticipantId: 'carol',
      txid: sha256Hex(`final-sweep-browser-coin:${fixture.vaultId}`),
      vout: 0,
      valueSats: finalValueSats,
      scriptPubKeyHex: Buffer.from(bitcoin.address.toOutputScript(
        carolEntry.payoutAddress,
        bitcoin.networks.bitcoin,
      )).toString('hex'),
    };
    await seedCurrentCoin(sql, fixture.vaultId, fixture.rosterDigest, coin, 850000);
    await installChainFixture(
      fixture.browsers,
      coin,
      850000,
      850005,
      chainRequests,
      unexpectedChainRequests,
    );

    const alice = fixture.browsers.find((item) => item.id === 'alice')!;
    const bob = fixture.browsers.find((item) => item.id === 'bob')!;
    const carol = fixture.browsers.find((item) => item.id === 'carol')!;
    for (const participant of fixture.browsers) {
      await participant.page.goto('/vault');
      await expect(participant.page.getByRole('heading', { name: 'Current Bitcoin coin' })).toBeVisible();
    }
    for (const nonOwner of [alice, bob]) {
      await expect(nonOwner.page.getByRole('button', {
        name: 'Create my final payout sweep',
      })).toHaveCount(0);
    }

    await carol.page.getByRole('button', { name: 'Verify current coin' }).click();
    await expect(carol.page.getByText(
      'Mainnet coin verified with your passkey (6 confirmation(s))',
    )).toBeVisible();
    await carol.page.getByRole('button', { name: 'Create my final payout sweep' }).click();
    await expect(carol.page.getByText(
      'Final payout sweep created; nothing has been signed or broadcast',
    )).toBeVisible();
    await carol.page.getByRole('button', { name: 'Verify and sign my final payout sweep' }).click();
    await expect(carol.page.getByText(/Final payout sweep verified as .*; not broadcast/u)).toBeVisible();
    await carol.page.reload();
    await expect(carol.page.getByText('Ready for explicit mainnet broadcast')).toBeVisible();
    await expect(carol.page.getByRole('button', {
      name: 'Approve with passkey and broadcast to mainnet',
    })).toBeDisabled();
    for (const nonOwner of [alice, bob]) {
      await nonOwner.page.reload();
      await expect(nonOwner.page.getByText('Ready for explicit mainnet broadcast')).toHaveCount(0);
    }

    const rows = await sql<Array<{
      status: string;
      finalized_tx_hex: string;
      final_txid: Buffer;
      contributions: number;
      broadcasts: number;
      current_coins: number;
    }>>`
      SELECT p.status, p.finalized_tx_hex, p.final_txid,
        (SELECT count(*)::integer FROM vault_proposal_contributions c
          WHERE c.proposal_id = p.id) AS contributions,
        (SELECT count(*)::integer FROM vault_broadcast_approvals b
          WHERE b.proposal_id = p.id) AS broadcasts,
        (SELECT count(*)::integer FROM vault_coins vc
          WHERE vc.vault_id = p.vault_id AND vc.status = 'current') AS current_coins
      FROM vault_transaction_proposals p
      WHERE p.vault_id = ${fixture.vaultId}::uuid AND p.kind = 'final_sweep'
    `;
    expect(rows).toHaveLength(1);
    const result = rows[0]!;
    expect(result.status).toBe('finalized');
    expect(result.contributions).toBe(0);
    expect(result.broadcasts).toBe(0);
    expect(result.current_coins).toBe(1);
    const transaction = bitcoin.Transaction.fromHex(result.finalized_tx_hex);
    expect(transaction.getId()).toBe(result.final_txid.toString('hex'));
    expect(transaction.outs).toHaveLength(1);
    expect(Number(transaction.outs[0]!.value)).toBe(
      finalValueSats - fixture.artifact.economics.finalSweepFeeSats,
    );
    expect(Buffer.from(transaction.outs[0]!.script).toString('hex')).toBe(coin.scriptPubKeyHex);
    const consensus = verifyVaultTransaction({
      txHex: result.finalized_tx_hex,
      prevouts: [{ scriptPubKeyHex: coin.scriptPubKeyHex, valueSats: coin.valueSats }],
    });
    expect(consensus.checks.some((item) => item.includes('key-path signature valid'))).toBe(true);
    expect(chainRequests).toHaveLength(4);
    expect(unexpectedChainRequests).toEqual([]);
    expect(forbiddenSigbashRequests).toEqual([]);
  } finally {
    await disposeParticipantFixture(sql, fixture);
  }
});

async function seedCurrentCoin(
  sql: ReturnType<typeof postgres>,
  vaultId: string,
  rosterDigest: string,
  coin: VaultCoinSnapshot,
  confirmedHeight: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE vaults SET status = 'active' WHERE id = ${vaultId}::uuid`;
    await tx`
      INSERT INTO vault_coins (
        vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, status, confirmed_height
      ) VALUES (
        ${vaultId}::uuid, ${Buffer.from(rosterDigest, 'hex')}, ${coin.kind},
        ${coin.roundId}, ${coin.ownerParticipantId}, ${Buffer.from(coin.txid, 'hex')},
        ${coin.vout}, ${coin.valueSats}, ${Buffer.from(coin.scriptPubKeyHex, 'hex')},
        'current', ${confirmedHeight}
      )
    `;
  });
}

async function installChainFixture(
  browsers: ParticipantBrowser[],
  coin: VaultCoinSnapshot,
  blockHeight: number,
  tipHeight: number,
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
      if (url.pathname === `/api/tx/${coin.txid}`) {
        const vout = Array.from({ length: coin.vout + 1 }, (_, index) => index === coin.vout
          ? { scriptpubkey: coin.scriptPubKeyHex, value: coin.valueSats }
          : { scriptpubkey: '6a', value: 0 });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            txid: coin.txid,
            vout,
            status: { confirmed: true, block_height: blockHeight },
          }),
        });
        return;
      }
      if (url.pathname === `/api/tx/${coin.txid}/outspend/${coin.vout}`) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"spent":false}' });
        return;
      }
      if (url.pathname === '/api/blocks/tip/height') {
        await route.fulfill({ status: 200, contentType: 'text/plain', body: String(tipHeight) });
        return;
      }
      unexpected.push(requestUrl);
      await route.fulfill({ status: 404, body: 'unexpected chain fixture request' });
    });
  }
}

function forbiddenSigbashRecorder(target: string[]): (requestUrl: string) => void {
  return (requestUrl) => {
    const url = new URL(requestUrl);
    if (url.hostname.endsWith('sigbash.com') ||
        /^\/api\/sigbash\/(?:runtime|provision|readiness)(?:\/|$)/u.test(url.pathname)) {
      target.push(requestUrl);
    }
  };
}
