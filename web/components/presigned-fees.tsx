'use client';
import { useEffect, useState } from 'react';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { buildPresignedFeeDraft, validatePresignedFeePackage, type PresignedFeeDraft,
  type PresignedFeePackage } from '../../src/presigned/fee-package';
import { signPresignedFeePayout, type FeeCoinObservation, type PresignedFeeApproval } from '../../src/presigned/fees';
import { authorizePresignedFundingFeeWalletPsbt, type PresignedFundingFeeSignature } from '../../src/presigned/funding-fees';
import { signPresignedSpendFeePayout } from '../../src/presigned/spend-fees';
import { PRESIGNED_PROTOCOL, type PresignedParticipant } from '../../src/presigned/types';
import { assert, canonicalJson, commitmentDigest, safeInteger, sameCanonical } from '../../src/presigned/validation';
import { presignedPost } from '../lib/client/presigned-ceremony';
import { withUnlockedPresignedParticipant } from '../lib/client/presigned-custody';
import { approvePresignedFeePackage, observePresignedFeeCoin, presignedFeeParentConfirmationHint, verifyPresignedFeeView } from '../lib/client/presigned-fees';
import { assertPresignedLocalGraphApproved, presignedLocalBinding, readPresignedLocalCeremony,
  withPresignedLocalCeremonyLock } from '../lib/client/presigned-local-ceremony';
import { verifyPresignedRuntimeView, type PresignedBrowserRuntimeStatus } from '../lib/client/presigned-runtime';
import type { PresignedFeeStatus } from '../lib/server/presigned-fee-store';

type OwnIdentity = Pick<PresignedParticipant, 'id' | 'personalPublicKeyHex' | 'payoutXonlyPublicKeyHex'>;
type Parent = PresignedFeeStatus['parents'][number];
const BASE = { version: 2 as const, protocol: PRESIGNED_PROTOCOL };

export function PresignedFees({ vaultId, ownIdentity, passkeys, chainConfig, requiredConfirmations }: {
  vaultId: string; ownIdentity: OwnIdentity; passkeys: Array<{ id: string; name: string }>;
  chainConfig: { apiUrl: string; allowedOrigins: string[] }; requiredConfirmations: number;
}) {
  const binding = presignedLocalBinding(vaultId, ownIdentity);
  const [status, setStatus] = useState<PresignedFeeStatus | null>(null);
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id ?? '');
  const [apiUrl, setApiUrl] = useState(chainConfig.apiUrl);
  const [parentKey, setParentKey] = useState('');
  const [sponsorTxid, setSponsorTxid] = useState('');
  const [sponsorVout, setSponsorVout] = useState('0');
  const [childFee, setChildFee] = useState('3000');
  const [targetRate, setTargetRate] = useState('5000');
  const [relayRate, setRelayRate] = useState('1000');
  const [incrementalRate, setIncrementalRate] = useState('1000');
  const [noChangeApproved, setNoChangeApproved] = useState(false);
  const [previousChild, setPreviousChild] = useState('');
  const [draft, setDraft] = useState<PresignedFeeDraft | null>(null);
  const [reviewedDigest, setReviewedDigest] = useState<string | null>(null);
  const [sponsorPsbt, setSponsorPsbt] = useState('');
  const [changePsbt, setChangePsbt] = useState('');
  const [combinedWallet, setCombinedWallet] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('Fee rescue spends only your payout or wallet refund, preserves its entire value, and charges a separate confirmed sponsor coin.');
  const draftDigest = draft ? commitmentDigest('vault/presigned-graph-v2/browser-fee-draft', draft) : null;
  const preview = draft ? buildPresignedFeeDraft(draft) : null;

  async function refresh() {
    const [feesResponse, runtimeResponse] = await Promise.all([
      fetch('/api/vault/presigned/fees/status', { cache: 'no-store', credentials: 'same-origin' }),
      fetch('/api/vault/presigned/runtime/status', { cache: 'no-store', credentials: 'same-origin' }),
    ]);
    assert(feesResponse.ok && runtimeResponse.ok, 'Fee coordination is unavailable');
    const runtime = verifyPresignedRuntimeView(await runtimeResponse.json(), { vaultId, participantId: ownIdentity.id });
    const fees = verifyPresignedFeeView(await feesResponse.json(), runtime);
    setStatus(fees);
    return { fees, runtime };
  }
  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : 'Fee status failed')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function work(action: () => Promise<void>) {
    setWorking(true);
    try { await withPresignedLocalCeremonyLock(binding, action); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Fee action failed'); }
    finally { setWorking(false); }
  }
  function approvedGraph(runtime: PresignedBrowserRuntimeStatus, digest: string) {
    const graph = runtime.kits.find(item => item.publicKit.graph.digest === digest)?.publicKit.graph;
    assert(graph, 'Fee parent lost its exact retained graph');
    assertPresignedLocalGraphApproved(graph, readPresignedLocalCeremony(binding));
    return graph;
  }
  async function observe(coin: { txid: string; vout: number }, allowPendingSpend: boolean, expectedPendingSpendTxid?: string) {
    return observePresignedFeeCoin({ ...coin, apiUrl, allowedOrigins: chainConfig.allowedOrigins,
      requiredConfirmations, allowPendingSpend, expectedPendingSpendTxid });
  }
  async function build() {
    await work(async () => {
      const { fees, runtime } = await refresh();
      const parent = fees.parents.find(item => keyFor(item) === parentKey);
      assert(parent, 'Choose an exact fully approved parent transaction');
      const graph = approvedGraph(runtime, parent.graphDigest);
      const replacement = previousChild.trim() ? { previousChildTransactionHex: previousChild.trim(),
        incrementalRelayRateMillisatsPerVbyte: integer(incrementalRate, 'incremental relay rate') } : null;
      const sponsorInput = await observe({ txid: sponsorTxid.trim(), vout: integer(sponsorVout, 'sponsor output index', true) },
        Boolean(replacement), replacement ? bitcoin.Transaction.fromHex(replacement.previousChildTransactionHex).getId() : undefined);
      const fee = integer(childFee, 'child fee');
      const approval: PresignedFeeApproval = { childFeeSats: fee, maxChildFeeSats: fee,
        targetPackageRateMillisatsPerVbyte: integer(targetRate, 'target package rate'),
        minRelayRateMillisatsPerVbyte: integer(relayRate, 'minimum relay rate'),
        sponsorChangeScriptPubKeyHex: fee === sponsorInput.valueSats ? null : sponsorInput.scriptPubKeyHex,
        approveExactNoChangeFee: fee === sponsorInput.valueSats && noChangeApproved, replacement };
      const common = { ...BASE, epochId: parent.epochId, proposalId: parent.proposalId,
        ownerParticipantId: ownIdentity.id, parentAuthorityDigest: parent.authorityDigest };
      let next: PresignedFeeDraft;
      if (parent.kind === 'funding') {
        const fundingInputObservations: FeeCoinObservation[] = [];
        for (const coin of graph.funding.inputs) {
          const observed = await observe(coin, true, parent.txid);
          assert(observed.confirmations >= coin.confirmations, 'Funding fee source lost its committed confirmation depth');
          fundingInputObservations.push(observed);
        }
        next = { ...common, mode: 'funding', request: { graph, fundingTransactionHex: parent.transactionHex,
          changeParticipantId: ownIdentity.id, fundingInputObservations, sponsorInput, approval } };
      } else {
        const state = runtime.proposals.find(item => item.proposal.proposalId === parent.proposalId)!;
        const source = await observe(state.proposal.source, true, parent.txid);
        assert(source.confirmationBlockHash === state.proposal.confirmationBlockHash, 'Parent source reanchored; renew its execution approvals first');
        next = parent.kind === 'solo' ? { ...common, mode: 'solo', request: { graph, exitId: state.proposal.exitId!,
          parentTransactionHex: parent.transactionHex, roundInputObservation: source, sponsorInput, approval } }
          : { ...common, mode: 'spend', request: { graph, parentSpendProposal: state.proposal.spend!,
            parentTransactionHex: parent.transactionHex, payoutParticipantId: ownIdentity.id,
            sourceObservation: source, sponsorInput, approval } };
      }
      buildPresignedFeeDraft(next);
      setDraft(next); setReviewedDigest(null); setSponsorPsbt(''); setChangePsbt(''); setCombinedWallet(false); setImportedPackage(null);
      download(`presigned-v2-fee-draft-${parent.txid}.json`, canonicalJson(next), 'application/json');
      setMessage('Public fee draft downloaded for interruption recovery. Review the exact summary before wallet export or signing.');
    });
  }
  async function freshDraft(chosen: PresignedFeeDraft) {
    const { fees, runtime } = await refresh();
    const graph = approvedGraph(runtime, chosen.request.graph.digest);
    sameCanonical(graph, chosen.request.graph, 'locally reviewed fee graph');
    const parent = fees.parents.find(item => item.epochId === chosen.epochId && item.proposalId === chosen.proposalId);
    assert(parent && parent.authorityDigest === chosen.parentAuthorityDigest && chosen.ownerParticipantId === ownIdentity.id,
      'Fee parent authority changed or belongs to another participant');
    const committed = chosen.mode === 'funding' ? chosen.request.fundingInputObservations
      : [chosen.mode === 'solo' ? chosen.request.roundInputObservation : chosen.request.sourceObservation];
    const replacement = chosen.request.approval.replacement;
    const previousId = replacement ? bitcoin.Transaction.fromHex(replacement.previousChildTransactionHex).getId() : undefined;
    if (await presignedFeeParentConfirmationHint({ apiUrl, allowedOrigins: chainConfig.allowedOrigins, txid: parent.txid })) {
      const built = buildPresignedFeeDraft(chosen); const child = bitcoin.Psbt.fromBase64(built.psbtBase64);
      const tx = bitcoin.Transaction.fromBuffer(child.data.globalMap.unsignedTx.toBuffer());
      const source = tx.ins[0]!; const expected = child.data.inputs[0]!.witnessUtxo!;
      assert(Buffer.from(source.hash).reverse().toString('hex') === parent.txid, 'fee child changed its parent');
      const current = await observe({ txid: parent.txid, vout: source.index }, Boolean(replacement), previousId);
      assert(current.valueSats === Number(expected.value) && current.scriptPubKeyHex === Buffer.from(expected.script).toString('hex'),
        'confirmed fee payout or wallet refund changed');
    } else for (const coin of committed) compareCoin(coin, await observe(coin, true, parent.txid));
    compareCoin(chosen.request.sponsorInput, await observe(chosen.request.sponsorInput, Boolean(replacement),
      previousId));
    return graph;
  }
  async function finalize() {
    await work(async () => {
      assert(draft && draftDigest === reviewedDigest, 'Review this exact fee draft before signing');
      const graph = await freshDraft(draft);
      const built = buildPresignedFeeDraft(draft);
      let approved: PresignedFeePackage;
      if (draft.mode === 'funding') {
        let signatures: PresignedFundingFeeSignature[];
        if (combinedWallet) signatures = authorizePresignedFundingFeeWalletPsbt({ request: draft.request,
          roles: ['change', 'sponsor'], signedPsbtBase64: changePsbt.trim(), approvalDigest: built.approvalDigest });
        else signatures = [
          ...authorizePresignedFundingFeeWalletPsbt({ request: draft.request, roles: ['change'],
            signedPsbtBase64: changePsbt.trim(), approvalDigest: built.approvalDigest }),
          ...authorizePresignedFundingFeeWalletPsbt({ request: draft.request, roles: ['sponsor'],
            signedPsbtBase64: sponsorPsbt.trim(), approvalDigest: built.approvalDigest }),
        ];
        approved = { ...draft, signatures };
      } else {
        assert(sponsorPsbt.trim(), 'Import the sponsor wallet signature before authorizing your payout');
        const owner = graph.roster.participants.find(item => item.id === ownIdentity.id)!;
        const payout = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: vaultId, expectedParticipant: owner,
          action: unlocked => draft.mode === 'solo'
            ? signPresignedFeePayout({ request: draft.request, psbtBase64: built.psbtBase64,
              approvalDigest: built.approvalDigest, keys: unlocked.keys })
            : signPresignedSpendFeePayout({ request: draft.request, psbtBase64: built.psbtBase64,
              approvalDigest: built.approvalDigest, keys: unlocked.keys }) });
        approved = { ...draft, signatures: { payoutSignatureHex: payout.payoutSignatureHex, sponsorSignedPsbtBase64: sponsorPsbt.trim() } };
      }
      const checked = validatePresignedFeePackage(approved);
      // Public executable transaction, no secret, saved before the first send
      // to the coordinator so an interrupted approval cannot strand a child.
      download(`presigned-v2-fee-package-${checked.completed.txid}.json`, canonicalJson(approved), 'application/json');
      const result = await approvePresignedFeePackage(credentialId, approved);
      setMessage(`Exact fee package ${result.packageId} is durably approved. Broadcasting remains a separate action and network gate.`);
    });
  }
  async function importPublicFile(file: File | undefined) {
    if (!file) return;
    await work(async () => {
      assert(file.size <= 96 * 1024, 'Public fee file exceeds the request bound');
      const value = JSON.parse(await file.text()) as PresignedFeeDraft | PresignedFeePackage;
      if ('signatures' in value) {
        const checked = validatePresignedFeePackage(value);
        await freshDraft(checked.package);
        const { signatures: _signatures, ...unsigned } = checked.package;
        setDraft(unsigned); setReviewedDigest(null);
        setMessage('Signed public package verified. Review its restored summary, then use the import-approval button; no Bitcoin signature needs to be recreated.');
        setImportedPackage(checked.package);
      } else {
        buildPresignedFeeDraft(value); await freshDraft(value);
        setDraft(value); setReviewedDigest(null); setImportedPackage(null);
        setMessage('Public draft restored. Reimport the external wallet signatures after reviewing its exact summary.');
      }
    });
  }
  const [importedPackage, setImportedPackage] = useState<PresignedFeePackage | null>(null);
  async function approveImported() {
    await work(async () => {
      assert(importedPackage && draft && reviewedDigest === draftDigest, 'Review the restored fee package first');
      const { signatures: _signatures, ...unsigned } = importedPackage;
      sameCanonical(unsigned, draft, 'restored fee draft');
      await freshDraft(importedPackage);
      const result = await approvePresignedFeePackage(credentialId, importedPackage);
      setMessage(`Restored exact package ${result.packageId} is durably approved.`);
    });
  }

  return <section className="panel" aria-label="Presigned fee rescue">
    <p className="eyebrow">Exact-payout fee rescue</p><h2>Adapt fees without changing the game</h2>
    <p role="status">{message}</p>
    <p>Use a confirmed native P2WPKH or P2TR coin from a wallet you control. Fee rescue cannot use vault funds or an unconfirmed sponsor.
      The fixed parent is never replaced; the child pays the additional fee. Relay and confirmation remain subject to current Bitcoin Core policy.</p>
    <button disabled={working} onClick={() => void work(async () => { await refresh(); setMessage('Approved parents and retained fee packages refreshed.'); })}>Refresh fee rescue</button>
    <label>Fee-approval passkey<select disabled={working} value={credentialId} onChange={event => setCredentialId(event.target.value)}>
      {passkeys.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
    <label>Independent fee chain API<input disabled={working} value={apiUrl} onChange={event => setApiUrl(event.target.value)} /></label>
    <label>Approved parent needing fee rescue<select disabled={working} value={parentKey} onChange={event => setParentKey(event.target.value)}>
      <option value="">Choose an unconfirmed parent</option>{status?.parents.map(parent => <option key={keyFor(parent)} value={keyFor(parent)}>
        {parent.kind} · {parent.txid}</option>)}</select></label>
    <label>Confirmed sponsor transaction ID<input disabled={working} value={sponsorTxid} onChange={event => setSponsorTxid(event.target.value)} /></label>
    <label>Sponsor output index<input disabled={working} inputMode="numeric" value={sponsorVout} onChange={event => setSponsorVout(event.target.value)} /></label>
    <label>Exact additional child fee (sats)<input disabled={working} inputMode="numeric" value={childFee} onChange={event => setChildFee(event.target.value)} /></label>
    <label>Target package rate (millisats/vB; 1000 = 1 sat/vB)<input disabled={working} inputMode="numeric" value={targetRate} onChange={event => setTargetRate(event.target.value)} /></label>
    <label>Minimum relay rate (millisats/vB)<input disabled={working} inputMode="numeric" value={relayRate} onChange={event => setRelayRate(event.target.value)} /></label>
    <label><input type="checkbox" disabled={working} checked={noChangeApproved} onChange={event => setNoChangeApproved(event.target.checked)} />I explicitly approve no sponsor change only if this fee equals the entire sponsor coin.</label>
    <details><summary>Replace a previous child using the same sponsor coin</summary>
      <label>Previous signed child transaction hex<textarea disabled={working} value={previousChild} onChange={event => setPreviousChild(event.target.value)} /></label>
      <label>Incremental relay rate (millisats/vB)<input disabled={working} inputMode="numeric" value={incrementalRate} onChange={event => setIncrementalRate(event.target.value)} /></label>
    </details>
    <button disabled={working || !parentKey} onClick={() => void build()}>Build exact fee rescue</button>
    <label>Restore a public fee draft or signed package<input type="file" accept="application/json,.json" disabled={working}
      onChange={event => void importPublicFile(event.target.files?.[0])} /></label>
    {draft && preview && <article className="ceremony-step">
      <h3>Review this exact child</h3><p>Parent: <code>{preview.parentTxid}</code><br />Child: <code>{preview.unsignedTxid}</code></p>
      <p>Additional fee: {preview.childFeeSats.toLocaleString()} sats · sponsor change: {preview.sponsorChangeSats.toLocaleString()} sats.
        Preserved {draft.mode === 'funding' ? 'wallet refund' : 'payout'}: {('changeSats' in preview ? preview.changeSats : preview.payoutSats).toLocaleString()} sats.</p>
      <p>Maximum child size: {preview.maximumChildVsize} vB. Package preview rate: {((preview.parentFeeSats + preview.childFeeSats) /
        (preview.parentVsize + preview.maximumChildVsize)).toFixed(3)} sat/vB. Finalization checks the actual signed size and your exact fee cap.</p>
      <label><input type="checkbox" disabled={working} checked={reviewedDigest === draftDigest}
        onChange={event => setReviewedDigest(event.target.checked ? draftDigest : null)} />I approve this parent, sponsor coin, exact fee and unchanged payout/refund.</label>
      <button disabled={working || reviewedDigest !== draftDigest} onClick={() => {
        const wallet = bitcoin.Psbt.fromBase64(preview.psbtBase64);
        // The funding refund's parent may not exist in the wallet mempool yet.
        // Supply its fully verified raw transaction as optional wallet metadata.
        const parentHex = draft.mode === 'funding' ? draft.request.fundingTransactionHex : draft.request.parentTransactionHex;
        wallet.updateInput(0, { nonWitnessUtxo: bitcoin.Transaction.fromHex(parentHex).toBuffer() });
        download(`presigned-v2-fee-${preview.unsignedTxid}.psbt`, wallet.toBase64(), 'text/plain');
      }}>Download unsigned fee PSBT</button>
      {draft.mode === 'funding' && <><label><input type="checkbox" disabled={working} checked={combinedWallet}
        onChange={event => setCombinedWallet(event.target.checked)} />The same external wallet owns both the refund and sponsor inputs; I approve signing both roles.</label>
        <label>{combinedWallet ? 'Both-role signed wallet PSBT (base64)' : 'Refund-owner signed PSBT (base64)'}<textarea disabled={working} value={changePsbt} onChange={event => setChangePsbt(event.target.value)} /></label></>}
      {(!combinedWallet || draft.mode !== 'funding') && <label>Sponsor-only signed PSBT (base64)<textarea disabled={working}
        value={sponsorPsbt} onChange={event => setSponsorPsbt(event.target.value)} /></label>}
      <p>Submitting a signed package releases its Bitcoin signatures before passkey approval finishes; cancellation cannot revoke them.
        The honest service waits for the separate broadcast action before adding the package to its send/retry queue.</p>
      <button disabled={working || reviewedDigest !== draftDigest} onClick={() => void finalize()}>Verify wallet signatures and approve exact fee package</button>
      {importedPackage && <button disabled={working || reviewedDigest !== draftDigest} onClick={() => void approveImported()}>Approve restored signed package</button>}
    </article>}
    {status?.packages.map(row => {
      const checked = validatePresignedFeePackage(row.package);
      return <article className="ceremony-step" key={row.id}><h3>Retained fee package · {row.status}</h3>
        <p><code>{checked.completed.txid}</code> · {checked.completed.childFeeSats.toLocaleString()} additional sats</p>
        <button disabled={working || !status.broadcastAvailable} onClick={() => void work(async () => {
          const result = await presignedPost<{ status: string; reason: string | null }>('/api/vault/presigned/fees/broadcast', { packageId: row.id });
          setMessage(`Fee package ${result.status}. ${result.reason ?? 'Mempool acceptance is not confirmation.'}`);
        })}>Broadcast exact approved package</button>
        <button disabled={working} onClick={() => {
          setParentKey(`${row.package.epochId}:${row.package.proposalId ?? 'funding'}`);
          setSponsorTxid(row.package.request.sponsorInput.txid); setSponsorVout(String(row.package.request.sponsorInput.vout));
          setChildFee(String(checked.completed.childFeeSats + 1000)); setPreviousChild(checked.completed.transactionHex);
          setMessage('Previous child selected. Choose and review an increased fee before creating a separate replacement approval.');
        }}>Prepare child-only fee replacement</button>
        <button onClick={() => download(`presigned-v2-fee-package-${checked.completed.txid}.json`, canonicalJson(row.package), 'application/json')}>Download public package</button>
      </article>;
    })}
  </section>;
}
function keyFor(parent: Parent) { return `${parent.epochId}:${parent.proposalId ?? 'funding'}`; }
function integer(value: string, label: string, zero = false) {
  assert(/^(0|[1-9][0-9]*)$/u.test(value), `${label} must be a whole number`);
  const parsed = Number(value); safeInteger(parsed, zero ? 0 : 1, Number.MAX_SAFE_INTEGER, label); return parsed;
}
function compareCoin(committed: FeeCoinObservation, current: FeeCoinObservation) {
  assert(current.confirmations >= committed.confirmations, 'Fee coin lost confirmation depth');
  sameCanonical({ ...current, confirmations: committed.confirmations }, committed, 'independently observed fee coin');
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
