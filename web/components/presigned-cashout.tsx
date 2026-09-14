'use client';
import { useEffect, useState } from 'react';
import { buildPresignedCashout, signPresignedCashout, type PresignedCashout, type PresignedCashoutRequest } from '../../src/presigned/cashout';
import type { PresignedProtocol, PresignedPublicKit } from '../../src/presigned/types';
import { assert, canonicalJson, sameCanonical } from '../../src/presigned/validation';
import { assertCashoutOwner, discoverCashoutCoins, observeCashoutSource, verifyCashoutStatus, verifySignedCashout,
  type CashoutCoin, type CashoutIdentity } from '../lib/client/presigned-cashout';
import { presignedPost } from '../lib/client/presigned-ceremony';
import { withUnlockedPresignedParticipant } from '../lib/client/presigned-custody';
import { presignedLocalBinding, withPresignedLocalCeremonyLock } from '../lib/client/presigned-local-ceremony';
import { verifyPresignedRuntimeView } from '../lib/client/presigned-runtime';
import type { PresignedCashoutStatus, PresignedSignedCashout } from '../lib/server/presigned-cashout-store';

export function PresignedCashoutPanel({ vaultId, protocol, ownIdentity, passkeys, chainConfig, requiredConfirmations }: {
  vaultId: string; protocol: PresignedProtocol; ownIdentity: CashoutIdentity; passkeys: Array<{ id: string; name: string }>;
  chainConfig: { apiUrl: string; allowedOrigins: string[] }; requiredConfirmations: number;
}) {
  const expected = { vaultId, protocol, ownIdentity };
  const binding = presignedLocalBinding(vaultId, ownIdentity, protocol);
  const [status, setStatus] = useState<PresignedCashoutStatus | null>(null);
  const [kits, setKits] = useState<PresignedPublicKit[]>([]);
  const [graphDigest, setGraphDigest] = useState('');
  const [coins, setCoins] = useState<CashoutCoin[]>([]);
  const [txid, setTxid] = useState(''); const [vout, setVout] = useState('0');
  const [destination, setDestination] = useState(''); const [fee, setFee] = useState('300');
  const [apiUrl, setApiUrl] = useState(chainConfig.apiUrl);
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id ?? '');
  const [draft, setDraft] = useState<{ request: PresignedCashoutRequest; cashout: PresignedCashout } | null>(null);
  const [signed, setSigned] = useState<PresignedSignedCashout | null>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('After your payout or refund confirms, send it to your own regular wallet. Only you can sign this withdrawal.');

  async function refresh() {
    const response = await fetch('/api/vault/presigned/cashout/status', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(90_000) });
    const raw = await response.json(); assert(response.ok, raw.error || 'Cash-out status unavailable');
    const checked = verifyCashoutStatus(raw, expected); setStatus(checked); return checked;
  }
  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : 'Cash-out status failed')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function work(action: () => Promise<void>) {
    setWorking(true);
    try { await withPresignedLocalCeremonyLock(binding, action); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Cash-out failed'); }
    finally { setWorking(false); }
  }
  function invalidate() { setDraft(null); setSigned(null); setReviewed(null); }
  async function loadKits() {
    const response = await fetch('/api/vault/presigned/runtime/status', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(90_000) });
    const raw = await response.json(); assert(response.ok, raw.error || 'Retained payout kits unavailable');
    const runtime = verifyPresignedRuntimeView(raw, { vaultId, participantId: ownIdentity.id, protocol });
    const next = runtime.kits.map(item => { assertCashoutOwner(item.publicKit, expected); return item.publicKit; });
    setKits(next); return next;
  }
  async function findCoins() {
    await work(async () => {
      const current = await loadKits(); const kit = current.find(item => item.graph.digest === graphDigest) ?? current[0];
      assert(kit, 'Finish setup and retain your public recovery kit before looking for payouts');
      setGraphDigest(kit.graph.digest);
      const found = await discoverCashoutCoins({ apiUrl, allowedOrigins: chainConfig.allowedOrigins, publicKit: kit, participantId: ownIdentity.id });
      setCoins(found); invalidate(); if (found[0]) { setTxid(found[0].txid); setVout(String(found[0].vout)); }
      setMessage(found.length ? `${found.length} confirmed payout coin(s) found. Choose one and your destination.` : 'No confirmed payout coins found. You can also enter a known payout transaction below.');
    });
  }
  async function preview() {
    await work(async () => {
      const current = await loadKits(); const publicKit = current.find(item => item.graph.digest === graphDigest) ?? current[0];
      assert(publicKit, 'No retained payout kit'); assertCashoutOwner(publicKit, expected);
      assert(/^(0|[1-9]\d*)$/u.test(vout) && /^[1-9]\d*$/u.test(fee), 'Output and fee must be whole numbers');
      const source = await observeCashoutSource({ apiUrl, allowedOrigins: chainConfig.allowedOrigins,
        txid: txid.trim(), vout: Number(vout), requiredConfirmations });
      const request: PresignedCashoutRequest = { publicKit, participantId: ownIdentity.id, ...source,
        destinationAddress: destination.trim(), feeSats: Number(fee), maxFeeSats: Number(fee) };
      const cashout = buildPresignedCashout(request);
      setDraft({ request, cashout }); setSigned(null); setReviewed(null);
      setMessage('Compare the complete destination with your receiving wallet. Review the extra fee and exact amount before signing.');
    });
  }
  async function freshSource(request: PresignedCashoutRequest) {
    const fresh = await observeCashoutSource({ apiUrl, allowedOrigins: chainConfig.allowedOrigins,
      txid: request.sourceObservation.txid, vout: request.sourceObservation.vout, requiredConfirmations });
    sameCanonical(fresh.parentTransactionHex, request.parentTransactionHex, 'cash-out source transaction');
    const original = request.sourceObservation; const now = fresh.sourceObservation;
    assert(original.txid === now.txid && original.vout === now.vout && original.valueSats === now.valueSats &&
      original.scriptPubKeyHex === now.scriptPubKeyHex && original.confirmationBlockHash === now.confirmationBlockHash,
    'Payout reanchored or changed after review; rebuild the preview before signing');
  }
  async function sign() {
    await work(async () => {
      assert(draft && reviewed === draft.cashout.digest, 'Review this exact destination, amount and fee first');
      const participant = assertCashoutOwner(draft.request.publicKit, expected); await freshSource(draft.request);
      const completed = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: vaultId, expectedProtocol: protocol,
        expectedParticipant: participant, action: unlocked => signPresignedCashout({ ...draft, keys: unlocked.keys, approvedCashoutDigest: reviewed }) });
      const artifact = { ...draft, transactionHex: completed.transactionHex }; setSigned(artifact);
      download(artifact);
      setMessage('Signed withdrawal downloaded. Nothing has been broadcast. Save it with the coordinator, then explicitly send when ready.');
    });
  }
  async function save() {
    await work(async () => {
      assert(signed && reviewed === signed.cashout.digest, 'Review the signed withdrawal first');
      verifySignedCashout(signed, expected);
      const result = await presignedPost<{ cashoutId: string; txid: string }>('/api/vault/presigned/cashout/prepare', signed);
      assert(result.txid === signed.cashout.txid, 'Coordinator saved another withdrawal');
      await refresh(); setMessage('Exact signed withdrawal saved. It will not be sent until you press Broadcast this withdrawal.');
    });
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    await work(async () => {
      assert(file.size <= 1024 * 1024, 'Signed cash-out file is too large');
      const artifact = verifySignedCashout(JSON.parse(await file.text()), expected);
      setDraft({ request: artifact.request, cashout: artifact.cashout }); setSigned(artifact); setReviewed(null);
      setMessage('Owner signature verified. Review the restored destination and fee before saving or sending. No new signature is needed.');
    });
  }
  async function broadcast(intent: PresignedCashoutStatus['intents'][number]) {
    await work(async () => {
      assert(signed && reviewed === signed.cashout.digest, 'Review this exact saved withdrawal before broadcasting');
      sameCanonical(intent.artifact, signed, 'saved owner-approved cash-out');
      const result = await presignedPost<{ txid: string; status: string }>('/api/vault/presigned/cashout/broadcast', { cashoutId: intent.cashoutId });
      assert(result.txid === signed.cashout.txid, 'Coordinator returned another withdrawal');
      await refresh(); setMessage(`Withdrawal ${result.status}. Confirmation is not guaranteed; refresh to see the last watcher observation.`);
    });
  }

  return <section className="panel" data-testid="presigned-cashout" aria-label="Withdraw your own payout">
    <p className="eyebrow">Your money after the vault</p><h2>Send your payout to your wallet</h2>
    <p role="status">{message}</p>
    <p>This separate withdrawal spends only your individually owned payout or refund. It cannot change the fixed vault refunds or spend anyone else’s money.
      Its additional network fee is deducted from your payout and is separate from the game’s committed fees.</p>
    <p>Finding payouts shares your public payout address with your selected independent chain source. No private keys leave this browser.</p>
    <button disabled={working} onClick={() => void findCoins()}>Find my confirmed payouts</button>
    <button disabled={working} onClick={() => void work(async () => { await refresh(); setMessage('Last observed withdrawal status refreshed.'); })}>Refresh withdrawals</button>
    <label>Withdrawal passkey<select disabled={working} value={credentialId} onChange={event => setCredentialId(event.target.value)}>
      {passkeys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}</select></label>
    <label>Independent withdrawal chain source<input disabled={working} value={apiUrl} onChange={event => { setApiUrl(event.target.value); invalidate(); }} /></label>
    {kits.length > 1 && <label>Retained payout kit<select disabled={working} value={graphDigest} onChange={event => { setGraphDigest(event.target.value); invalidate(); }}>
      {kits.map(kit => <option key={kit.graph.digest} value={kit.graph.digest}>{kit.graph.funding.epochId}</option>)}</select></label>}
    {!!coins.length && <label>Confirmed payout coin<select disabled={working} value={`${txid}:${vout}`} onChange={event => {
      const [id, index] = event.target.value.split(':'); setTxid(id!); setVout(index!); invalidate();
    }}>{coins.map(coin => <option key={`${coin.txid}:${coin.vout}`} value={`${coin.txid}:${coin.vout}`}>
      {coin.valueSats.toLocaleString('en-US')} sats · {coin.txid}:{coin.vout}</option>)}</select></label>}
    <details><summary>Enter a payout coin manually</summary>
      <label>Payout transaction ID<input disabled={working} value={txid} onChange={event => { setTxid(event.target.value); invalidate(); }} /></label>
      <label>Payout output number<input disabled={working} value={vout} onChange={event => { setVout(event.target.value); invalidate(); }} /></label>
    </details>
    <label>Your receiving Bitcoin address<input disabled={working} value={destination} onChange={event => { setDestination(event.target.value); invalidate(); }} /></label>
    <label>Additional withdrawal fee in sats<input disabled={working} value={fee} onChange={event => { setFee(event.target.value); invalidate(); }} /></label>
    <button disabled={working} onClick={() => void preview()}>Preview exact withdrawal</button>
    <label>Restore signed withdrawal file<input type="file" accept="application/json,.json" disabled={working} onChange={event => void importFile(event.target.files?.[0])} /></label>
    {draft && <div data-testid="cashout-preview">
      <p>Network: {draft.request.publicKit.graph.roster.network}. Payout owner: {draft.cashout.participantId}.</p>
      <p>Source: <code>{draft.cashout.source.txid}:{draft.cashout.source.vout}</code> · {draft.cashout.source.valueSats.toLocaleString('en-US')} sats</p>
      <p>Send exactly {draft.cashout.payoutSats.toLocaleString('en-US')} sats to <code data-testid="cashout-destination">{draft.cashout.destinationAddress}</code>.</p>
      <p>Additional fee: {draft.cashout.feeSats.toLocaleString('en-US')} sats. Fee limit: {draft.cashout.maxFeeSats.toLocaleString('en-US')} sats.</p>
      <p>Transaction: <code>{draft.cashout.txid}</code></p>
      <label><input type="checkbox" disabled={working} checked={reviewed === draft.cashout.digest} onChange={event => setReviewed(event.target.checked ? draft.cashout.digest : null)} />
        I checked this exact receiving address in my wallet, the amount and the additional fee.</label>
      {!signed && <button disabled={working || reviewed !== draft.cashout.digest} onClick={() => void sign()}>Sign and download my withdrawal</button>}
      {signed && <><button disabled={working} onClick={() => download(signed)}>Download signed withdrawal again</button>
        <button disabled={working || reviewed !== draft.cashout.digest} onClick={() => void save()}>Save signed withdrawal</button></>}
    </div>}
    {status?.intents.map(intent => <div key={intent.cashoutId} data-testid="cashout-intent">
      <p><code>{intent.txid}</code> · Last observed: {intent.status}{intent.reason ? ` · ${intent.reason}` : ''}</p>
      <p>{intent.artifact.cashout.payoutSats.toLocaleString('en-US')} sats to <code>{intent.artifact.cashout.destinationAddress}</code></p>
      <button disabled={working} onClick={() => { setDraft({ request: intent.artifact.request, cashout: intent.artifact.cashout });
        setSigned(intent.artifact); setReviewed(null); setMessage('Review the exact saved withdrawal above before sending.'); }}>Review saved withdrawal</button>
      <button disabled={working || !status.broadcastAvailable || reviewed !== intent.artifact.cashout.digest ||
        ['confirmed','spent','submitting'].includes(intent.status)} onClick={() => void broadcast(intent)}>Broadcast this withdrawal</button>
    </div>)}
    {status && !status.broadcastAvailable && <p>Broadcasting is disabled for this protocol and network. Your signed file remains exportable for your own Bitcoin node.</p>}
  </section>;
}
function download(artifact: PresignedSignedCashout) {
  const url = URL.createObjectURL(new Blob([canonicalJson(artifact)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `owned-payout-${artifact.cashout.txid}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
