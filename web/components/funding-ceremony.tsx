'use client';

import { useEffect, useState } from 'react';
import {
  buildFundingProposal,
  fundingInputCommitmentDigest,
  type FundingInputCommitment,
  type FundingProposal,
} from '../../src/funding-ceremony.js';
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
}

export function FundingCeremony({ passkeys }: { passkeys: PasskeyChoice[] }) {
  const [status, setStatus] = useState<FundingStatus | null>(null);
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [txid, setTxid] = useState('');
  const [vout, setVout] = useState('0');
  const [changeAddress, setChangeAddress] = useState('');
  const [message, setMessage] = useState('Loading the three-wallet funding ceremony…');
  const [working, setWorking] = useState(false);

  async function refresh(): Promise<FundingStatus> {
    const next = await postJson('/api/vault/funding', {}) as unknown as FundingStatus;
    if (next.proposal) await verifyProposalInBrowser(next);
    setStatus(next);
    setMessage(next.proposal
      ? 'All three inputs are approved and the exact unsigned Bitcoin transaction reproduces in this browser.'
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
      if (completed.proposal) await verifyProposalInBrowser(completed);
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
    setMessage('Exact unsigned PSBT copied. It still needs one real wallet signature from each friend.');
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
          <p className="muted">
            This does not fund or broadcast anything. The next release gate is collecting and
            independently validating all three external-wallet signatures.
          </p>
        </div>
      )}
      <p className="form-message" role="status">{message}</p>
    </section>
  );
}

async function verifyProposalInBrowser(status: FundingStatus): Promise<void> {
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
