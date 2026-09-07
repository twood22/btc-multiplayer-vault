'use client';
import { useEffect, useState } from 'react';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { buildPresignedRuntimeProposal, buildPresignedRuntimeReanchor,
  type PresignedRuntimeAction, type PresignedRuntimeProposal, type PresignedRuntimeState } from '../../src/presigned/runtime';
import { completePresignedExit } from '../../src/presigned/signing';
import { createPresignedCooperativeNonce, createPresignedRecoveryContribution, signPresignedCooperativePartial,
  signPresignedFinalSweep, verifyPresignedCooperativePartial, type PresignedCooperativePartial,
  type PresignedCooperativePublicNonce } from '../../src/presigned/spends';
import { PRESIGNED_PROTOCOL, type PresignedParticipant, type PresignedPublicKit } from '../../src/presigned/types';
import { assert, networkParameters } from '../../src/presigned/validation';
import { observePresignedConfirmedSource } from '../lib/client/presigned-chain';
import { presignedPost } from '../lib/client/presigned-ceremony';
import { withUnlockedPresignedParticipant } from '../lib/client/presigned-custody';
import { assertPresignedLocalGraphApproved, presignedLocalBinding, readPresignedLocalCeremony,
  withPresignedLocalCeremonyLock } from '../lib/client/presigned-local-ceremony';
import { approvePresignedRuntimeAction, verifyPresignedRuntimeView,
  type PresignedBrowserRuntimeStatus } from '../lib/client/presigned-runtime';
import { consumeCooperativeSecnonce, hasCooperativeSecnonce, storeCooperativeSecnonce,
  storedCooperativePubnonce } from '../lib/client/musig2-nonce-vault';

const BASE = { version: 2 as const, protocol: PRESIGNED_PROTOCOL };
type OwnIdentity = Pick<PresignedParticipant, 'id' | 'personalPublicKeyHex' | 'payoutXonlyPublicKeyHex'>;

export function PresignedRuntime({ vaultId, ownIdentity, passkeys, chainConfig, requiredConfirmations }: {
  vaultId: string; ownIdentity: OwnIdentity; passkeys: Array<{ id: string; name: string }>;
  chainConfig: { apiUrl: string; allowedOrigins: string[] }; requiredConfirmations: number;
}) {
  const binding = presignedLocalBinding(vaultId, ownIdentity);
  const [status, setStatus] = useState<PresignedBrowserRuntimeStatus | null>(null);
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id ?? '');
  const [apiUrl, setApiUrl] = useState(chainConfig.apiUrl);
  const [message, setMessage] = useState('The private watcher coordinates state. Your browser independently verifies each coin before signing.');
  const [working, setWorking] = useState(false);
  const [reviewedProposal, setReviewedProposal] = useState<string | null>(null);
  const [abandonReason, setAbandonReason] = useState('A required signing nonce is unavailable; start a fresh cooperative ceremony.');
  async function refresh() {
    const response = await fetch('/api/vault/presigned/runtime/status', { credentials: 'same-origin', cache: 'no-store' });
    const value = await response.json();
    assert(response.ok, value.error || 'Runtime status is unavailable');
    const checked = verifyPresignedRuntimeView(value, { vaultId, participantId: ownIdentity.id });
    setStatus(checked);
    return checked;
  }
  useEffect(() => {
    if (working) return;
    void refresh().catch(error => setMessage(error instanceof Error ? error.message : 'Runtime verification failed'));
    const timer = setInterval(() => { void refresh().catch(error =>
      setMessage(error instanceof Error ? error.message : 'Runtime verification failed')); }, 15_000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);

  async function work(action: () => Promise<void>) {
    setWorking(true);
    try {
      await withPresignedLocalCeremonyLock(binding, action);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Runtime action failed'); }
    finally { setWorking(false); }
  }
  function approvedKit(current: PresignedBrowserRuntimeStatus, graphDigest: string): PresignedPublicKit {
    const kit = current.kits.find(item => item.publicKit.graph.digest === graphDigest)?.publicKit;
    assert(kit, 'The proposal lost its exact retained recovery kit');
    assertPresignedLocalGraphApproved(kit.graph, readPresignedLocalCeremony(binding));
    return kit;
  }
  async function freshProposal(chosen: PresignedRuntimeState) {
    const current = await refresh();
    const state = current.proposals.find(item => item.proposal.proposalId === chosen.proposal.proposalId);
    assert(state && state.proposal.digest === chosen.proposal.digest, 'The proposal changed after your review');
    return { current, state, kit: approvedKit(current, state.proposal.graphDigest) };
  }
  async function sourceObservation(proposal: PresignedRuntimeProposal, kit: PresignedPublicKit, allowReanchor = false) {
    const observed = await observePresignedConfirmedSource({ apiUrl, txid: proposal.source.txid,
      vout: proposal.source.vout, allowedOrigins: chainConfig.allowedOrigins });
    assert(observed.valueSats === proposal.source.valueSats && observed.scriptPubKeyHex === proposal.source.scriptPubKeyHex &&
      (allowReanchor || observed.confirmationBlockHash === proposal.confirmationBlockHash), 'The independently observed source changed or reanchored');
    const minimum = proposal.kind === 'recovery'
      ? Math.max(requiredConfirmations, kit.graph.roster.economics.recoveryDelayBlocks) : requiredConfirmations;
    assert(observed.confirmations >= minimum, `Source needs at least ${minimum} confirmations for this path`);
    if (observed.pendingSpendTxid) setMessage(`A competing transaction is pending (${observed.pendingSpendTxid}). Your exact signing authority is unchanged; relay and replacement are not guaranteed.`);
    return observed;
  }
  async function create(epochId: string, kind: 'solo' | 'cooperative' | 'recovery' | 'final-sweep') {
    await work(async () => {
      const current = await refresh();
      const retained = current.kits.find(item => item.epochId === epochId);
      assert(retained, 'Funding epoch is unavailable');
      const kit = approvedKit(current, retained.publicKit.graph.digest);
      const snapshot = current.chain.epochs.find(item => item.epochId === epochId)?.snapshot;
      assert(snapshot?.output && snapshot.output.availability !== 'chain-spent', 'Refresh the private watcher to resolve a confirmed source');
      const output = snapshot.output;
      const sourceExitId = kit.graph.exits.find(exit => exit.txid === output.txid)?.id ?? null;
      const exit = kind === 'solo' ? kit.graph.exits.find(item => item.parentExitId === sourceExitId && item.leaver === ownIdentity.id) : null;
      assert(kind !== 'solo' || exit, 'You are not a leaver in the current round');
      const action: Extract<PresignedRuntimeAction, { kind: 'create-proposal' }> = { ...BASE, kind: 'create-proposal',
        epochId, graphDigest: kit.graph.digest, proposalId: crypto.randomUUID(), spendKind: kind,
        sourceExitId, exitId: exit?.id ?? null, confirmationBlockHash: output.confirmationBlockHash };
      const proposal = buildPresignedRuntimeProposal({ graph: kit.graph, action, participantId: ownIdentity.id });
      await sourceObservation(proposal, kit);
      await approvePresignedRuntimeAction(credentialId, action, proposal);
      setReviewedProposal(null);
      setMessage('Proposal created. Review every payout below before releasing a Bitcoin signature.');
    });
  }
  async function sign(chosen: PresignedRuntimeState) {
    await work(async () => {
      const { state, kit } = await freshProposal(chosen);
      const proposal = state.proposal;
      assert(reviewedProposal === proposal.digest, 'Review this exact proposal before signing');
      assert(state.status === 'collecting', 'This proposal is already completed or abandoned');
      await sourceObservation(proposal, kit);
      const participant = kit.graph.roster.participants.find(item => item.id === ownIdentity.id)!;
      let action: PresignedRuntimeAction;
      if (proposal.kind === 'solo' || proposal.kind === 'final-sweep') {
        const completed = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: vaultId,
          expectedParticipant: participant, action: unlocked => proposal.kind === 'solo'
            ? completePresignedExit({ graph: kit.graph, preauthorizations: kit.preauthorizations, exitId: proposal.exitId!,
              participantId: ownIdentity.id, privateKey: unlocked.keys.soloPrivateKeys[proposal.source.roundId!]!, approvedGraphDigest: kit.graph.digest })
            : signPresignedFinalSweep({ graph: kit.graph, proposal: proposal.spend!, participantId: ownIdentity.id,
              payoutPrivateKey: unlocked.keys.payoutPrivateKey, approvedProposalDigest: proposal.spend!.digest }) });
        action = { ...BASE, kind: 'finalize-transaction', proposalId: proposal.proposalId,
          proposalDigest: proposal.digest, transactionHex: completed.transactionHex };
      } else if (proposal.kind === 'recovery') {
        const contribution = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: vaultId,
          expectedParticipant: participant, action: unlocked => createPresignedRecoveryContribution({ graph: kit.graph,
            proposal: proposal.spend!, participantId: ownIdentity.id, personalPrivateKey: unlocked.keys.personalPrivateKey,
            approvedProposalDigest: proposal.spend!.digest }) });
        action = { ...BASE, kind: 'contribute-recovery', proposalId: proposal.proposalId, proposalDigest: proposal.digest, contribution };
      } else if (!state.publicNonces.some(item => item.participantId === ownIdentity.id)) {
        const publicNonce = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: vaultId,
          expectedParticipant: participant, action: async unlocked => {
            if (hasCooperativeSecnonce(proposal.proposalId, ownIdentity.id)) {
              const pubnonce = storedCooperativePubnonce(proposal.proposalId, ownIdentity.id);
              assert(pubnonce, 'Stored nonce is malformed; abandon this proposal and start another');
              return { ...BASE, graphDigest: kit.graph.digest, proposalId: proposal.proposalId,
                proposalDigest: proposal.spend!.digest, participantId: ownIdentity.id, pubnonce } satisfies PresignedCooperativePublicNonce;
            }
            const nonce = createPresignedCooperativeNonce({ graph: kit.graph, proposal: proposal.spend!, participantId: ownIdentity.id,
              personalPrivateKey: unlocked.keys.personalPrivateKey, approvedProposalDigest: proposal.spend!.digest });
            try { await storeCooperativeSecnonce(nonce.binding, Buffer.from(nonce.secretNonce).toString('hex'), unlocked.participantSecret); }
            finally { nonce.secretNonce.fill(0); }
            return nonce.publicNonce;
          } });
        action = { ...BASE, kind: 'contribute-nonce', proposalId: proposal.proposalId, proposalDigest: proposal.digest, publicNonce };
      } else {
        assert(state.nonceSetDigest, 'Wait for every participant public nonce before signing a partial');
        const publicKey = `presigned-v2-public-partial:${vaultId}:${proposal.proposalId}:${ownIdentity.id}`;
        const retained = localStorage.getItem(publicKey);
        let partial: PresignedCooperativePartial;
        if (retained) {
          assert(retained.length <= 4096, 'Retained public partial is oversized');
          partial = verifyPresignedCooperativePartial({ graph: kit.graph, proposal: proposal.spend!, publicNonces: state.publicNonces,
            partial: JSON.parse(retained) as PresignedCooperativePartial });
        } else {
          partial = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: vaultId,
            expectedParticipant: participant, action: async unlocked => {
              const own = state.publicNonces.find(item => item.participantId === ownIdentity.id)!;
              const nonceBinding = { proposalId: proposal.proposalId, proposalDigest: proposal.spend!.digest,
                participantId: ownIdentity.id, round: proposal.source.roundId!, message: proposal.spend!.signatureHash, pubnonce: own.pubnonce };
              const consumed = await consumeCooperativeSecnonce(nonceBinding, unlocked.participantSecret);
              return signPresignedCooperativePartial({ graph: kit.graph, proposal: proposal.spend!, participantId: ownIdentity.id,
                personalPrivateKey: unlocked.keys.personalPrivateKey, approvedProposalDigest: proposal.spend!.digest,
                publicNonces: state.publicNonces, nonceBinding, consumedSecretNonce: consumed });
            } });
          // This is a PUBLIC signature, retained for a dropped HTTP response.
          // The secret nonce has already been irreversibly consumed locally.
          localStorage.setItem(publicKey, JSON.stringify(partial));
        }
        action = { ...BASE, kind: 'contribute-partial', proposalId: proposal.proposalId, proposalDigest: proposal.digest, partial };
      }
      await approvePresignedRuntimeAction(credentialId, action, proposal);
      setMessage('Exact public contribution accepted. Participant keys and secret nonces were not sent to the service.');
    });
  }
  async function approveBroadcast(chosen: PresignedRuntimeState) {
    await work(async () => {
      const { state, kit } = await freshProposal(chosen);
      assert(reviewedProposal === state.proposal.digest && state.finalized, 'Review the completed transaction before broadcast approval');
      await sourceObservation(state.proposal, kit);
      await approvePresignedRuntimeAction(credentialId, { ...BASE, kind: 'approve-broadcast',
        proposalId: state.proposal.proposalId, proposalDigest: state.proposal.digest, transactionDigest: state.finalized.transactionDigest }, state.proposal);
      setMessage('Broadcast approval recorded for these exact signed bytes. A released Bitcoin signature cannot be revoked.');
    });
  }
  async function reanchor(chosen: PresignedRuntimeState) {
    await work(async () => {
      const { state, kit } = await freshProposal(chosen);
      assert(state.finalized && reviewedProposal === state.proposal.digest, 'Review the exact retained transaction first');
      const source = await sourceObservation(state.proposal, kit, true);
      const action: Extract<PresignedRuntimeAction, { kind: 'reanchor-transaction' }> = { ...BASE, kind: 'reanchor-transaction',
        proposalId: crypto.randomUUID(), predecessorProposalId: state.proposal.proposalId,
        predecessorProposalDigest: state.proposal.digest, transactionDigest: state.finalized.transactionDigest,
        confirmationBlockHash: source.confirmationBlockHash };
      const proposal = buildPresignedRuntimeReanchor({ graph: kit.graph, predecessor: state, action, participantId: ownIdentity.id });
      await approvePresignedRuntimeAction(credentialId, action, proposal);
      setReviewedProposal(null);
      setMessage('New execution approval context created for identical signed bytes. Every required signer must approve broadcasting again; no MuSig nonce was reused.');
    });
  }
  async function broadcast(epochId: string, proposalId: string | null) {
    await work(async () => {
      const result = await presignedPost<{ status: string; reason: string | null }>('/api/vault/presigned/broadcast', { epochId, proposalId });
      setMessage(`Broadcast ${result.status}. ${result.reason ?? 'Wait for independent chain confirmation; mempool acceptance is not confirmation.'}`);
    });
  }

  return <section className="panel" aria-label="Presigned transaction coordination">
    <p className="eyebrow">Live vault · Presigned v2</p><h2>Exit and recovery transactions</h2>
    <p role="status">{message}</p>
    <label>Signing passkey<select value={credentialId} onChange={event => setCredentialId(event.target.value)} disabled={working}>
      {passkeys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}</select></label>
    <label>Independent chain API<input value={apiUrl} onChange={event => setApiUrl(event.target.value)} disabled={working} placeholder="https://independent.example/api" /></label>
    <button type="button" disabled={working} onClick={() => void work(async () => {
      await presignedPost('/api/vault/presigned/chain/refresh', {}); setMessage('Private watcher refreshed. Each signing action still makes an independent browser observation.');
    })}>Refresh confirmed chain state</button>
    {!status?.kits.length && <p>Complete the graph and backups above before coordinating transactions.</p>}
    {status?.kits.map(retained => {
      const graph = retained.publicKit.graph;
      const watched = status.chain.epochs.find(item => item.epochId === retained.epochId);
      const output = watched?.snapshot?.output;
      const currentParticipants = output?.roundId ? graph.rounds.find(round => round.id === output.roundId)!.participantIds : output?.owner ? [output.owner] : [];
      return <article key={retained.epochId} className="ceremony-step">
        <h3>Epoch {retained.epochId}</h3><p>Funding transaction: <code>{graph.fundingTxid}</code></p>
        <p>{output ? `${output.valueSats.toLocaleString()} sats · ${output.confirmations} confirmations · ${output.availability}` : 'Funding is not yet confirmed by the watcher.'}</p>
        {watched?.deferredReason && <p>Watcher deferred: {watched.deferredReason}. Last successful snapshot is historical.</p>}
        {retained.epochStatus === 'approved' && !output && <button disabled={working || !status.broadcastAvailable}
          onClick={() => void broadcast(retained.epochId, null)}>Broadcast unanimously approved funding</button>}
        {output && output.availability !== 'chain-spent' && currentParticipants.includes(ownIdentity.id) && <div className="button-row">
          {output.kind === 'vault' ? <><button disabled={working} onClick={() => void create(retained.epochId, 'solo')}>Prepare my solo exit</button>
            <button disabled={working} onClick={() => void create(retained.epochId, 'cooperative')}>Propose cooperative exit</button>
            <button disabled={working} onClick={() => void create(retained.epochId, 'recovery')}>Propose timelocked recovery</button></>
            : <button disabled={working} onClick={() => void create(retained.epochId, 'final-sweep')}>Prepare final-owner sweep</button>}
        </div>}
      </article>;
    })}
    {status?.proposals.map(state => {
      const proposal = state.proposal;
      const graph = status.kits.find(item => item.publicKit.graph.digest === proposal.graphDigest)!.publicKit.graph;
      const outputs = bitcoin.Transaction.fromHex(proposal.unsignedTxHex).outs;
      const eligible = proposal.participantIds.includes(ownIdentity.id);
      const ownNonce = state.publicNonces.some(item => item.participantId === ownIdentity.id);
      const contributed = proposal.kind === 'cooperative' ? state.partials.some(item => item.participantId === ownIdentity.id)
        : proposal.kind === 'recovery' ? state.recoveryContributions.some(item => item.participantId === ownIdentity.id) : false;
      const needsNonceWait = proposal.kind === 'cooperative' && ownNonce && !state.nonceSetDigest;
      return <article key={proposal.proposalId} className="ceremony-step">
        <h3>{proposal.kind} · {state.status}</h3><p><code>{proposal.txid}</code></p>
        <p>Fixed base fee: {proposal.feeSats.toLocaleString()} sats. Required signers: {proposal.threshold} of {proposal.participantIds.length}.</p>
        <table><thead><tr><th>Output</th><th>Sats</th><th>Exact destination</th></tr></thead><tbody>{outputs.map((output, index) =>
          <tr key={index}><td>{index}</td><td>{output.value.toString()}</td><td><code>{bitcoin.address.fromOutputScript(output.script, networkParameters(graph.roster.network))}</code></td></tr>)}</tbody></table>
        {proposal.reanchoredFrom && <p>Reauthorization after reorg; prior proposal {proposal.reanchoredFrom.proposalId} remains retained.</p>}
        {eligible && state.status !== 'abandoned' && <label><input type="checkbox" checked={reviewedProposal === proposal.digest}
          onChange={event => setReviewedProposal(event.target.checked ? proposal.digest : null)} disabled={working} /> I reviewed this exact input, payout destinations, amounts, fee and spending path.</label>}
        <div className="button-row">
          {eligible && state.status === 'collecting' && !contributed && <button disabled={working || reviewedProposal !== proposal.digest || needsNonceWait}
            onClick={() => void sign(state)}>{proposal.kind === 'cooperative' ? ownNonce ? 'Sign cooperative partial' : 'Commit fresh cooperative nonce' : 'Sign exact transaction'}</button>}
          {state.finalized?.approverParticipantIds.includes(ownIdentity.id) && !state.broadcastApprovals.includes(ownIdentity.id) &&
            <button disabled={working || reviewedProposal !== proposal.digest} onClick={() => void approveBroadcast(state)}>Approve exact signed bytes for broadcast</button>}
          {state.broadcastReady && <button disabled={working || !status.broadcastAvailable} onClick={() => void broadcast(proposal.epochId, proposal.proposalId)}>Broadcast approved transaction</button>}
          {eligible && state.finalized && <button disabled={working || reviewedProposal !== proposal.digest} onClick={() => void reanchor(state)}>Reauthorize after a changed block anchor</button>}
        </div>
        {eligible && state.status === 'collecting' && <details><summary>Interrupted signing</summary>
          <p>If a cooperative secret nonce was lost or consumed, abandon this ceremony and create a fresh proposal. Never restore a nonce snapshot.</p>
          <label>Reason<input value={abandonReason} onChange={event => setAbandonReason(event.target.value)} disabled={working} /></label>
          <button disabled={working} onClick={() => void work(async () => {
            const { state: current } = await freshProposal(state);
            await approvePresignedRuntimeAction(credentialId, { ...BASE, kind: 'abandon-proposal', proposalId: proposal.proposalId,
              proposalDigest: proposal.digest, reason: abandonReason.trim().replace(/\s+/gu, ' ') }, current.proposal);
            setMessage('Coordination abandoned and history retained. Any previously published Bitcoin signatures remain potentially usable.');
          })}>Abandon incomplete proposal</button>
        </details>}
      </article>;
    })}
    {status && !status.broadcastAvailable && <p>Broadcasting is disabled for this deployment. Separate mainnet authorization remains required.</p>}
  </section>;
}
