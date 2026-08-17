'use client';

import { useEffect, useState } from 'react';
import {
  buildFundingProposal,
  fundingInputCommitmentDigest,
  type FundingInputCommitment,
  type FundingProposal,
} from '../../src/funding-ceremony.js';
import {
  authorizeFundingSignedPsbt,
  canonicalFundingRestartReason,
  finalizeFundingSignatures,
  fundingRestartApprovalDigest,
  fundingRestartStateDigest,
  fundingSignatureContributionDigest,
  validateFundingSignatureContribution,
  type FinalizedFundingTransaction,
  type FundingRestartSnapshot,
  type FundingSignatureContribution,
} from '../../src/funding-signing.js';
import type { PublishedRosterArtifact } from '../../src/roster-ceremony.js';
import { observeFundingInput } from '../lib/client/chain-observation';
import { assertPasskey } from '../lib/client/webauthn';

interface PasskeyChoice { id: string; name: string }
interface FundingStatus {
  vaultId: string;
  rosterDigest: string;
  participantId: string;
  available: boolean;
  vaultStatus: string;
  fundingAddress: string;
  depositSatsPerParticipant: number;
  fundingFeeSats: number;
  chainObservationOrigins: string[];
  inputs: Array<FundingInputCommitment & { commitmentDigest: string }>;
  participantApproved: boolean;
  proposal: FundingProposal | null;
  signatureContributions: Array<FundingSignatureContribution & { contributionDigest: string }>;
  participantSigned: boolean;
  finalization: (FinalizedFundingTransaction & {
    status: 'awaiting_approvals' | 'approved' | 'submitting' | 'broadcast' | 'confirmed';
    approvedParticipantIds: string[];
    participantApproved: boolean;
    readyForOperatorBroadcast: boolean;
  }) | null;
  restartStateDigest: string | null;
  restartRequests: Array<{
    stateDigest: string;
    restartDigest: string;
    reason: string;
    approvedParticipantIds: string[];
    participantApproved: boolean;
  }>;
}

export function FundingCeremony({ passkeys }: { passkeys: PasskeyChoice[] }) {
  const [status, setStatus] = useState<FundingStatus | null>(null);
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [txid, setTxid] = useState('');
  const [vout, setVout] = useState('0');
  const [changeAddress, setChangeAddress] = useState('');
  const [signedPsbtBase64, setSignedPsbtBase64] = useState('');
  const [restartReason, setRestartReason] = useState('');
  const [message, setMessage] = useState('Loading the three-wallet funding ceremony…');
  const [working, setWorking] = useState(false);

  async function refresh(): Promise<FundingStatus> {
    const next = await postJson('/api/vault/funding', {}) as unknown as FundingStatus;
    await verifyFundingStateInBrowser(next);
    setStatus(next);
    setMessage(next.finalization?.status === 'confirmed'
      ? 'The exact unanimously approved funding transaction is confirmed and the multiplayer vault is active.'
      : next.finalization?.status === 'broadcast'
        ? 'The exact unanimously approved funding transaction is on mainnet and awaiting the required confirmations.'
        : next.finalization?.status === 'submitting'
          ? 'The private operator is submitting the exact unanimously approved funding transaction.'
      : next.finalization?.readyForOperatorBroadcast
      ? 'All three wallets signed and all three passkeys approved the exact final transaction. Operator release gates still remain closed.'
      : next.finalization
        ? `The exact wallet-signed transaction is finalized; passkey approvals ${next.finalization.approvedParticipantIds.length}/3.`
        : next.proposal
          ? `The exact unsigned transaction reproduces here; wallet signatures ${next.signatureContributions.length}/3.`
      : next.participantApproved
        ? `Your funding coin is locked in; waiting for friends (${next.inputs.length}/3).`
        : 'Choose one confirmed coin from your own wallet. Nothing will be signed or broadcast.');
    return next;
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : 'Funding ceremony unavailable'));
  }, []);

  async function approveFundingInput() {
    if (!status || !credentialId) return;
    setWorking(true);
    try {
      const source = status.chainObservationOrigins[0];
      if (!source) throw new Error('no independent mainnet source is configured');
      const outputNumber = Number(vout);
      setMessage('Checking that coin directly against Bitcoin mainnet…');
      const observed = await observeFundingInput(source, txid.trim().toLowerCase(), outputNumber);
      const participantIndex = ['alice', 'bob', 'carol'].indexOf(status.participantId);
      const baseFeeShare = Math.floor(status.fundingFeeSats / 3);
      const feeShare = baseFeeShare + (participantIndex === 0
        ? status.fundingFeeSats - baseFeeShare * 3
        : 0);
      const expectedChange = observed.valueSats - status.depositSatsPerParticipant - feeShare;
      if (expectedChange < 0) throw new Error('that coin cannot cover your deposit and funding fee share');
      const normalizedChange = expectedChange === 0 ? null : changeAddress.trim();
      if (expectedChange > 0 && !normalizedChange) {
        throw new Error(`enter a wallet change address for the remaining ${expectedChange.toLocaleString()} sats`);
      }
      const expectedCommitment: FundingInputCommitment = {
        version: 1,
        network: 'mainnet',
        vaultId: status.vaultId,
        rosterDigest: status.rosterDigest,
        participantId: status.participantId,
        ...observed,
        changeAddress: normalizedChange,
        fundingFeeSats: status.fundingFeeSats,
      };
      const expectedDigest = fundingInputCommitmentDigest(expectedCommitment);
      const approval = await postJson('/api/vault/funding/input/options', {
        credentialId,
        ...observed,
        changeAddress: normalizedChange,
      });
      const returnedCommitment = approval.commitment as FundingInputCommitment;
      if (approval.commitmentDigest !== expectedDigest ||
          fundingInputCommitmentDigest(returnedCommitment) !== expectedDigest) {
        throw new Error('coordinator changed the funding coin or change destination before passkey approval');
      }
      setMessage(
        `Approve ${observed.valueSats.toLocaleString()} sats from ${shortTxid(observed.txid)}:${observed.vout} with your passkey…`,
      );
      const response = await assertPasskey(approval.options as Record<string, unknown>);
      const completed = await postJson('/api/vault/funding/input/finish', {
        challengeId: approval.challengeId,
        commitmentDigest: expectedDigest,
        response,
      }) as unknown as FundingStatus;
      await verifyFundingStateInBrowser(completed);
      setStatus(completed);
      setMessage(completed.proposal
        ? 'All three real wallet inputs are approved; the exact unsigned PSBT is ready for wallet signing.'
        : `Your real wallet input is approved; waiting for friends (${completed.inputs.length}/3).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Funding input approval failed');
    } finally {
      setWorking(false);
    }
  }

  async function copyPsbt() {
    if (!status?.proposal) return;
    await navigator.clipboard.writeText(status.proposal.psbtBase64);
    setMessage('Exact unsigned PSBT copied. Sign only your own input in your external Bitcoin wallet, then paste its returned PSBT below.');
  }

  async function approveWalletSignature() {
    if (!status?.proposal || !credentialId || !signedPsbtBase64.trim()) return;
    setWorking(true);
    try {
      const local = authorizeFundingSignedPsbt({
        proposal: status.proposal,
        commitments: status.inputs,
        participantId: status.participantId,
        signedPsbtBase64: signedPsbtBase64.trim(),
      });
      setMessage('Wallet signature is valid for only your exact input. Confirm it with your passkey…');
      const approval = await postJson('/api/vault/funding/signature/options', {
        credentialId,
        signedPsbtBase64: signedPsbtBase64.trim(),
      });
      const returned = approval.contribution as FundingSignatureContribution;
      if (approval.contributionDigest !== local.contributionDigest ||
          fundingSignatureContributionDigest(returned) !== local.contributionDigest) {
        throw new Error('coordinator normalized a different wallet signature before passkey approval');
      }
      const response = await assertPasskey(approval.options as Record<string, unknown>);
      const completed = await postJson('/api/vault/funding/signature/finish', {
        challengeId: approval.challengeId,
        contributionDigest: local.contributionDigest,
        response,
      }) as unknown as FundingStatus;
      await verifyFundingStateInBrowser(completed);
      setStatus(completed);
      setSignedPsbtBase64('');
      setMessage(completed.finalization
        ? 'All three wallet signatures verify and the exact final transaction reproduces here. Review it before final passkey approval.'
        : `Your wallet signature is verified; waiting for friends (${completed.signatureContributions.length}/3).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Wallet signature approval failed');
    } finally {
      setWorking(false);
    }
  }

  async function approveFinalTransaction() {
    if (!status?.finalization || !credentialId) return;
    setWorking(true);
    try {
      await verifyFundingStateInBrowser(status);
      const options = await postJson('/api/vault/funding/final-approval/options', { credentialId });
      if (options.finalizationDigest !== status.finalization.finalizationDigest) {
        throw new Error('coordinator requested approval for a different finalized transaction');
      }
      setMessage('Approve the exact wallet-signed funding transaction with your passkey…');
      const response = await assertPasskey(options.options as Record<string, unknown>);
      const completed = await postJson('/api/vault/funding/final-approval/finish', {
        challengeId: options.challengeId,
        finalizationDigest: status.finalization.finalizationDigest,
        response,
      }) as unknown as FundingStatus;
      await verifyFundingStateInBrowser(completed);
      setStatus(completed);
      setMessage(completed.finalization?.readyForOperatorBroadcast
        ? 'Unanimous final approval recorded. Funding is still not broadcast; the separate operator release gate remains closed.'
        : `Your final approval is recorded (${completed.finalization?.approvedParticipantIds.length || 0}/3).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Final transaction approval failed');
    } finally {
      setWorking(false);
    }
  }

  async function approveRestart(reasonInput: string) {
    if (!status || !credentialId) return;
    setWorking(true);
    try {
      await verifyFundingStateInBrowser(status);
      const snapshot = fundingRestartSnapshotFromStatus(status);
      if (!snapshot || snapshot.inputs.length === 0) throw new Error('there is no funding state to restart');
      const reason = canonicalFundingRestartReason(reasonInput);
      const stateDigest = fundingRestartStateDigest(snapshot);
      const restartDigest = fundingRestartApprovalDigest({ snapshot, reason });
      if (stateDigest !== status.restartStateDigest) {
        throw new Error('coordinator reported a different restart state fingerprint');
      }
      const options = await postJson('/api/vault/funding/restart/options', {
        credentialId,
        reason,
      });
      if (options.stateDigest !== stateDigest || options.restartDigest !== restartDigest ||
          options.reason !== reason) {
        throw new Error('coordinator requested approval for a different funding restart');
      }
      setMessage('Approve invalidating the current funding inputs and wallet signatures with your passkey…');
      const response = await assertPasskey(options.options as Record<string, unknown>);
      const completed = await postJson('/api/vault/funding/restart/finish', {
        challengeId: options.challengeId,
        stateDigest,
        restartDigest,
        response,
      }) as unknown as FundingStatus;
      await verifyFundingStateInBrowser(completed);
      setStatus(completed);
      setRestartReason('');
      setMessage(completed.inputs.length === 0
        ? 'All three friends approved. The old funding ceremony was archived and a fresh one can begin.'
        : `Funding restart approval recorded; waiting for unanimous approval.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Funding restart approval failed');
    } finally {
      setWorking(false);
    }
  }

  if (!status) {
    return <section className="setup-card"><p className="form-message" role="status">{message}</p></section>;
  }

  return (
    <section className={status.proposal ? 'setup-card done' : 'setup-card'}>
      <p className="eyebrow">Three-wallet funding</p>
      <h2>{status.proposal ? 'Exact funding transaction assembled' : 'Approve your own funding coin'}</h2>
      <p className="muted">
        This uses exactly one confirmed input from each friend. Your passkey approves the outpoint,
        amount, fee share, and change address; your Bitcoin wallet keeps the spending key and must
        sign the final PSBT separately.
      </p>
      <p>
        Deposit per friend: <strong>{status.depositSatsPerParticipant.toLocaleString()} sats</strong>
        {' · '}Total transaction fee: <strong>{status.fundingFeeSats.toLocaleString()} sats</strong>
        {' · '}Approved: <strong>{status.inputs.length}/3</strong>
      </p>
      {status.inputs.length > 0 && (
        <div className="funding-contributions">
          <h3>Passkey-approved wallet coins</h3>
          {status.inputs.map((input) => (
            <article className="activation-code" key={input.participantId}>
              <strong>{input.participantId}</strong>
              <span>
                {input.valueSats.toLocaleString()} sats · {input.confirmations} confirmation(s)
                {' · '}{fundingFeeShare(status, input.participantId).toLocaleString()} sat fee share
              </span>
              <code>{input.txid}:{input.vout}</code>
              <span>Change destination</span>
              <code>{input.changeAddress || 'No change output'}</code>
              <span>Approval fingerprint</span>
              <code>{input.commitmentDigest}</code>
            </article>
          ))}
        </div>
      )}
      {!status.participantApproved && !status.proposal && (
        <div className="sigbash-controls">
          <label>
            Passkey
            <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
              {passkeys.map((passkey) => <option key={passkey.id} value={passkey.id}>{passkey.name}</option>)}
            </select>
          </label>
          <label>
            Wallet transaction ID
            <input autoCapitalize="none" autoCorrect="off" value={txid}
              onChange={(event) => setTxid(event.target.value)} placeholder="64 hexadecimal characters" />
          </label>
          <label>
            Output number
            <input inputMode="numeric" value={vout} onChange={(event) => setVout(event.target.value)} />
          </label>
          <label>
            Change address (leave blank only for an exact-value coin)
            <input autoCapitalize="none" autoCorrect="off" value={changeAddress}
              onChange={(event) => setChangeAddress(event.target.value)} placeholder="bc1q… or bc1p…" />
          </label>
          <button disabled={working || !credentialId || txid.trim().length !== 64}
            onClick={approveFundingInput} type="button">
            {working ? 'Verifying mainnet coin…' : 'Verify and approve my coin'}
          </button>
        </div>
      )}
      {status.proposal && (
        <div className="sigbash-controls">
          <p>Proposal fingerprint: <code>{status.proposal.digest}</code></p>
          <p>Unsigned transaction ID: <code>{status.proposal.unsignedTxid}</code></p>
          <div className="funding-contributions">
            <h3>Exact outputs every wallet must review</h3>
            {status.proposal.txTemplate.outputs.map((output) => (
              <article className="activation-code" key={output.index}>
                <strong>Output {output.index}: {output.label}</strong>
                <span>{output.valueSats.toLocaleString()} sats</span>
                <code>{output.address}</code>
              </article>
            ))}
          </div>
          <button onClick={copyPsbt} type="button">Copy exact unsigned PSBT</button>
          {!status.participantSigned && (
            <>
              <label>
                PSBT returned by your external wallet
                <textarea autoCapitalize="none" autoCorrect="off" value={signedPsbtBase64}
                  onChange={(event) => setSignedPsbtBase64(event.target.value)}
                  placeholder="Paste the base64 PSBT after your wallet signs only your input" />
              </label>
              <button disabled={working || !signedPsbtBase64.trim()}
                onClick={approveWalletSignature} type="button">
                {working ? 'Verifying wallet signature…' : 'Verify and approve my wallet signature'}
              </button>
            </>
          )}
          <p>Verified wallet signatures: {status.signatureContributions.length}/3</p>
          <p className="muted">
            No wallet private key enters this service. Imported wallet metadata is discarded;
            only your independently verified signature is retained.
          </p>
        </div>
      )}
      {status.finalization && (
        <div className="funding-contributions">
          <h3>Exact finalized transaction</h3>
          <article className="activation-code">
            <span>Transaction ID</span>
            <code>{status.finalization.finalTxid}</code>
            <span>Finalization fingerprint</span>
            <code>{status.finalization.finalizationDigest}</code>
            <span>{status.finalization.feeSats.toLocaleString()} sat fee · {status.finalization.vsize} vbytes</span>
            <span>Final passkey approvals: {status.finalization.approvedParticipantIds.length}/3</span>
          </article>
          {!status.finalization.participantApproved && status.finalization.status === 'awaiting_approvals' && (
            <button disabled={working} onClick={approveFinalTransaction} type="button">
              {working ? 'Confirming final transaction…' : 'Approve exact final transaction'}
            </button>
          )}
          {['awaiting_approvals', 'approved'].includes(status.finalization.status) ? (
            <p className="muted">
              Even unanimous approval does not broadcast. The private operator must still verify the
              external release report and deliberately submit these exact bytes.
            </p>
          ) : (
            <p className="muted">
              Funding state: {status.finalization.status}. Activation still waits for the configured
              mainnet confirmation depth and an exact-byte chain-watcher verification.
            </p>
          )}
        </div>
      )}
      {status.inputs.length > 0 &&
        (!status.finalization || ['awaiting_approvals', 'approved'].includes(status.finalization.status)) && (
        <div className="sigbash-controls">
          <h3>Restart this funding ceremony</h3>
          <p className="muted">
            Use this only if an input was spent, the fee is stale, or a wallet signature must be
            replaced. Restarting invalidates every current input approval and wallet signature;
            all three friends must approve the exact same reason and state with their passkeys.
          </p>
          {status.restartRequests.map((request) => (
            <article className="activation-code" key={request.restartDigest}>
              <strong>{request.reason}</strong>
              <span>Restart approvals: {request.approvedParticipantIds.length}/3</span>
              <code>{request.restartDigest}</code>
              {!request.participantApproved && (
                <button disabled={working} onClick={() => approveRestart(request.reason)} type="button">
                  {working ? 'Confirming restart…' : 'Approve this restart'}
                </button>
              )}
            </article>
          ))}
          <label>
            Exact restart reason
            <textarea value={restartReason} onChange={(event) => setRestartReason(event.target.value)}
              placeholder="For example: Alice's selected input was spent before broadcast." />
          </label>
          <button disabled={working || restartReason.trim().length < 10}
            onClick={() => approveRestart(restartReason)} type="button">
            {working ? 'Confirming restart…' : 'Propose and approve restart'}
          </button>
          <p>Current restart-state fingerprint: <code>{status.restartStateDigest}</code></p>
        </div>
      )}
      <p className="form-message" role="status">{message}</p>
    </section>
  );
}

async function verifyFundingStateInBrowser(status: FundingStatus): Promise<void> {
  const restartSnapshot = fundingRestartSnapshotFromStatus(status);
  if (restartSnapshot && fundingRestartStateDigest(restartSnapshot) !== status.restartStateDigest) {
    throw new Error('funding restart state does not reproduce in this browser');
  }
  if (!status.proposal) return;
  const published = await postJson('/api/vault/artifact', {});
  if (published.digest !== status.rosterDigest) throw new Error('funding proposal uses a different roster digest');
  const rebuilt = buildFundingProposal({
    artifact: published.artifact as PublishedRosterArtifact,
    commitments: status.inputs,
    fundingFeeSats: status.fundingFeeSats,
  });
  if (rebuilt.digest !== status.proposal.digest || rebuilt.unsignedTxid !== status.proposal.unsignedTxid ||
      rebuilt.psbtBase64 !== status.proposal.psbtBase64 ||
      JSON.stringify(rebuilt.txTemplate) !== JSON.stringify(status.proposal.txTemplate)) {
    throw new Error('funding proposal does not reproduce from the three passkey-approved inputs');
  }
  for (const contribution of status.signatureContributions) {
    validateFundingSignatureContribution({
      proposal: rebuilt,
      commitments: status.inputs,
      contribution,
    });
    if (fundingSignatureContributionDigest(contribution) !== contribution.contributionDigest) {
      throw new Error(`wallet signature for ${contribution.participantId} changed after approval`);
    }
  }
  if (status.finalization) {
    const finalized = finalizeFundingSignatures({
      proposal: rebuilt,
      commitments: status.inputs,
      contributions: status.signatureContributions,
    });
    if (finalized.finalizationDigest !== status.finalization.finalizationDigest ||
        finalized.finalTxid !== status.finalization.finalTxid ||
        finalized.transactionHex !== status.finalization.transactionHex ||
        finalized.feeSats !== status.finalization.feeSats || finalized.vsize !== status.finalization.vsize) {
      throw new Error('finalized funding transaction does not reproduce from the three wallet signatures');
    }
  }
}

function fundingRestartSnapshotFromStatus(status: FundingStatus): FundingRestartSnapshot | null {
  if (status.finalization && !['awaiting_approvals', 'approved'].includes(status.finalization.status)) return null;
  if (status.inputs.length === 0) return null;
  return {
    version: 1,
    network: 'mainnet',
    vaultId: status.vaultId,
    rosterDigest: status.rosterDigest,
    inputs: status.inputs.map((item) => ({
      participantId: item.participantId,
      commitmentDigest: item.commitmentDigest,
    })),
    signatures: status.signatureContributions.map((item) => ({
      participantId: item.participantId,
      contributionDigest: item.contributionDigest,
    })),
    finalization: status.finalization ? {
      finalizationDigest: status.finalization.finalizationDigest,
      status: status.finalization.status as 'awaiting_approvals' | 'approved',
    } : null,
  };
}

function shortTxid(txid: string): string {
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}

function fundingFeeShare(status: FundingStatus, participantId: string): number {
  const index = ['alice', 'bob', 'carol'].indexOf(participantId);
  const base = Math.floor(status.fundingFeeSats / 3);
  return base + (index === 0 ? status.fundingFeeSats - base * 3 : 0);
}

async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const result = await response.json() as { error?: string } & Record<string, any>;
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
