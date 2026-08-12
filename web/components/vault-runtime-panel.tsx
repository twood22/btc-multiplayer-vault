'use client';

import { useEffect, useState } from 'react';
import { buildVaultProposal, type VaultCoinSnapshot } from '../../src/vault-runtime.js';
import type { PublishedRosterArtifact } from '../../src/roster-ceremony.js';
import { inspectPsbt } from '../../src/psbt.js';
import { ceremonyStart } from '../../src/ceremony.js';
import { observeVaultCoin } from '../lib/client/chain-observation';
import {
  createSigbashBrowserClient,
  loadSigbashBrowserRuntime,
} from '../lib/client/sigbash-browser';
import { deriveParticipantSigbashPrivateKey } from '../lib/client/participant-identity';
import { withUnlockedVaultCustody } from '../lib/client/unlocked-vault-custody';
import {
  createAuthorizedCooperativeNonce,
  createAuthorizedCooperativePartial,
  signAuthorizedSoloWithdrawal,
} from '../lib/client/vault-signing';
import {
  consumeCooperativeSecnonce,
  hasCooperativeSecnonce,
  storeCooperativeSecnonce,
  storedCooperativePubnonce,
} from '../lib/client/musig2-nonce-vault';
import { assertPasskey } from '../lib/client/webauthn';

interface PasskeyChoice { id: string; name: string }
interface RuntimeStatus {
  participantId: string;
  participantPersonalPublicKeyHex: string;
  chainObservationOrigins: string[];
  coin: (VaultCoinSnapshot & {
    id: string;
    snapshotDigest: string;
    observedParticipantIds: string[];
  }) | null;
  proposal: {
    id: string;
    kind: 'solo' | 'cooperative' | 'recovery' | 'final_sweep';
    actorParticipantId: string | null;
    digest: string;
    unsignedTxid: string;
    psbtBase64: string;
    requiredSignerIds: string[];
    status: string;
    expiresAt: string;
    cooperativeContributions: {
      pubnonces: Record<string, string>;
      partialSigs: Record<string, string>;
    } | null;
  } | null;
}

export function VaultRuntimePanel({ passkeys }: { passkeys: PasskeyChoice[] }) {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [message, setMessage] = useState('Loading current vault state…');
  const [working, setWorking] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);

  async function refresh() {
    const next = await postJson('/api/vault/runtime', {}) as unknown as RuntimeStatus;
    setRuntime(next);
    setMessage(next.coin ? 'Current mainnet coin loaded' : 'No confirmed vault coin yet');
  }

  useEffect(() => {
    setBrowserReady(true);
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load vault state'));
  }, []);

  async function verifyCurrentCoin() {
    if (!runtime?.coin || !credentialId) return;
    setWorking(true);
    try {
      const source = runtime.chainObservationOrigins[0];
      if (!source) throw new Error('no independent chain observation source is configured');
      setMessage('Checking the exact coin directly against Bitcoin mainnet…');
      const observed = await observeVaultCoin(source, runtime.coin);
      const options = await postJson('/api/vault/observe/options', {
        credentialId,
        ...observed,
      });
      const response = await assertPasskey(options.options as Record<string, unknown>);
      await postJson('/api/vault/observe/finish', {
        challengeId: options.challengeId,
        snapshotDigest: observed.snapshotDigest,
        response,
      });
      await refresh();
      setMessage(`Mainnet coin verified with your passkey (${observed.confirmations} confirmation(s))`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Coin verification failed');
    } finally {
      setWorking(false);
    }
  }

  async function createSoloProposal() {
    if (!runtime) return;
    setWorking(true);
    try {
      await postJson('/api/vault/proposals', {
        kind: 'solo',
        actorParticipantId: runtime.participantId,
      });
      await refresh();
      setMessage('Exact policy-limited solo withdrawal created; nothing has been signed or broadcast');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create solo withdrawal');
    } finally {
      setWorking(false);
    }
  }

  async function createCooperativeProposal() {
    setWorking(true);
    try {
      await postJson('/api/vault/proposals', { kind: 'cooperative' });
      await refresh();
      setMessage('Equal cooperative refund proposed; every current participant signs on their own device');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create cooperative exit');
    } finally {
      setWorking(false);
    }
  }

  async function publishCooperativeNonce() {
    if (!runtime?.coin || !runtime.proposal || !credentialId) return;
    const proposal = runtime.proposal;
    setWorking(true);
    try {
      const pendingPubnonce = storedCooperativePubnonce(proposal.id, runtime.participantId);
      if (pendingPubnonce) {
        await postJson('/api/vault/proposals/cooperative-contribution', {
          proposalId: proposal.id,
          proposalDigest: proposal.digest,
          kind: 'musig_pubnonce',
          value: pendingPubnonce,
        });
        await refresh();
        setMessage('Your previously protected public nonce is published');
        return;
      }
      await withUnlockedVaultCustody({
        credentialId,
        action: async ({ unlocked, participantSecret }) => {
          const context = rebuildCooperativeContext(
            unlocked.artifact,
            unlocked.signer.state,
            runtime.coin!,
            proposal,
          );
          const generated = createAuthorizedCooperativeNonce({
            unlocked,
            context,
            trustedInput: runtime.coin!,
          });
          await storeCooperativeSecnonce({
            proposalId: proposal.id,
            proposalDigest: proposal.digest,
            participantId: generated.participantId,
            round: context.round,
            message: context.message,
            pubnonce: generated.pubnonce,
          }, generated.secnonce, participantSecret);
          await postJson('/api/vault/proposals/cooperative-contribution', {
            proposalId: proposal.id,
            proposalDigest: proposal.digest,
            kind: 'musig_pubnonce',
            value: generated.pubnonce,
          });
        },
      });
      await refresh();
      setMessage('Your public nonce is published; its encrypted secret remains only in this browser session');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'MuSig2 nonce creation failed');
    } finally {
      setWorking(false);
    }
  }

  async function publishCooperativePartial() {
    if (!runtime?.coin || !runtime.proposal || !credentialId) return;
    const proposal = runtime.proposal;
    const pendingKey = `btc-vault:musig2-partial:${proposal.id}:${runtime.participantId}`;
    setWorking(true);
    try {
      let partialSig = sessionStorage.getItem(pendingKey);
      if (!partialSig) {
        partialSig = await withUnlockedVaultCustody({
          credentialId,
          action: async ({ unlocked, participantSecret }) => {
            const context = rebuildCooperativeContext(
              unlocked.artifact,
              unlocked.signer.state,
              runtime.coin!,
              proposal,
            );
            const pubnonces = proposal.cooperativeContributions?.pubnonces || {};
            const ownPubnonce = pubnonces[runtime.participantPersonalPublicKeyHex];
            if (!ownPubnonce) throw new Error('your published nonce is absent from the complete nonce set');
            const secnonce = await consumeCooperativeSecnonce({
              proposalId: proposal.id,
              proposalDigest: proposal.digest,
              participantId: unlocked.signer.participantId,
              round: context.round,
              message: context.message,
              pubnonce: ownPubnonce,
            }, participantSecret);
            return createAuthorizedCooperativePartial({
              unlocked,
              context,
              trustedInput: runtime.coin!,
              pubnonces,
              secnonce,
            }).partialSig;
          },
        });
        sessionStorage.setItem(pendingKey, partialSig);
      }
      const saved = await postJson('/api/vault/proposals/cooperative-contribution', {
        proposalId: proposal.id,
        proposalDigest: proposal.digest,
        kind: 'musig_partial',
        value: partialSig,
      });
      sessionStorage.removeItem(pendingKey);
      await refresh();
      setMessage(saved.finalizedTxid
        ? `All partials verified; cooperative exit finalized as ${String(saved.finalizedTxid)} and not broadcast`
        : 'Your partial signature is verified; waiting for the other current participants');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'MuSig2 partial signing failed');
    } finally {
      setWorking(false);
    }
  }

  async function signSoloProposal() {
    if (!runtime?.coin || !runtime.proposal || !credentialId) return;
    const proposal = runtime.proposal;
    setWorking(true);
    try {
      const result = await withUnlockedVaultCustody({
        credentialId,
        action: async ({ unlocked, participantSecret, custody }) => {
          const artifact = unlocked.artifact as PublishedRosterArtifact;
          const rebuilt = buildVaultProposal({
            artifact,
            coin: runtime.coin!,
            kind: proposal.kind,
            ...(proposal.actorParticipantId
              ? { actorParticipantId: proposal.actorParticipantId }
              : {}),
            expiresAt: proposal.expiresAt,
          });
          if (
            rebuilt.digest !== proposal.digest ||
            rebuilt.psbtBase64 !== proposal.psbtBase64 ||
            rebuilt.unsignedTxid !== proposal.unsignedTxid
          ) {
            throw new Error('coordinator proposal does not reproduce in this browser');
          }
          if (proposal.kind !== 'solo' || proposal.actorParticipantId !== unlocked.signer.participantId) {
            throw new Error('this is not your solo withdrawal proposal');
          }
          const round = runtime.coin!.roundId;
          if (!round) throw new Error('solo proposal has no current vault round');
          const currentIds = artifact.vaults.find((vault) => vault.round === round)?.participantIds;
          if (!currentIds) throw new Error('current round is absent from the confirmed artifact');
          const custodyKey = custody.keys.find((key) => key.round === round);
          if (!custodyKey) throw new Error('encrypted custody has no Sigbash key for this round');
          setMessage('Loading the pinned Sigbash runtime…');
          const loaded = await loadSigbashBrowserRuntime((progress, stage) => {
            setMessage(`Sigbash ${progress}% · ${stage}`);
          });
          let privateKey: Uint8Array | undefined;
          let client: ReturnType<typeof createSigbashBrowserClient> | undefined;
          try {
            privateKey = await deriveParticipantSigbashPrivateKey(
              participantSecret,
              unlocked.signer.participantId,
              round,
            );
            client = createSigbashBrowserClient(loaded, custody.credentials, privateKey);
            privateKey.fill(0);
            privateKey = undefined;
            const signed = await signAuthorizedSoloWithdrawal({
              unlocked,
              currentIds,
              trustedInput: runtime.coin!,
              custodyKey,
              client,
              onProgress: (stage, detail) => setMessage(`${stage} · ${detail}`),
            });
            const transactionHex = signed.signed.transactionHex;
            if (!transactionHex) throw new Error('Sigbash returned no finalized transaction');
            return postJson('/api/vault/proposals/finalize-solo', {
              proposalId: proposal.id,
              proposalDigest: proposal.digest,
              transactionHex,
              ...(signed.signed.signedPsbtBase64
                ? { signedPsbtBase64: signed.signed.signedPsbtBase64 }
                : {}),
            });
          } finally {
            client?.disconnect();
            privateKey?.fill(0);
          }
        },
      });
      await refresh();
      setMessage(`Policy signature verified and finalized as ${String(result.txid)}; not broadcast`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Solo signing failed');
    } finally {
      setWorking(false);
    }
  }

  const observed = Boolean(runtime?.coin?.observedParticipantIds.includes(runtime.participantId));
  const currentRoundIds = runtime?.coin?.roundId ? participantIdsForRound(runtime.coin.roundId) : [];
  const canSolo = runtime?.coin?.kind === 'vault'
    && currentRoundIds.includes(runtime.participantId)
    && !runtime.proposal
    && observed;
  const canCooperate = canSolo;
  const canSignSolo = runtime?.proposal?.kind === 'solo'
    && runtime.proposal.actorParticipantId === runtime.participantId
    && runtime.proposal.status === 'collecting'
    && observed;
  const proposalReview = runtime?.coin && runtime.proposal
    ? reviewProposal(runtime.coin, runtime.proposal.psbtBase64)
    : null;
  const coop = runtime?.proposal?.cooperativeContributions;
  const hasOwnPubnonce = Boolean(
    runtime && coop?.pubnonces[runtime.participantPersonalPublicKeyHex],
  );
  const hasOwnPartial = Boolean(
    runtime && coop?.partialSigs[runtime.participantPersonalPublicKeyHex],
  );
  const allPubnonces = Boolean(
    runtime?.proposal && coop &&
    Object.keys(coop.pubnonces).length === runtime.proposal.requiredSignerIds.length,
  );
  const hasPendingPartial = Boolean(browserReady && runtime?.proposal
    && sessionStorage.getItem(`btc-vault:musig2-partial:${runtime.proposal.id}:${runtime.participantId}`));

  return (
    <section className="sigbash-card started">
      <div>
        <p className="eyebrow">Live vault</p>
        <h2>{runtime?.coin ? 'Current Bitcoin coin' : 'Awaiting confirmed funding'}</h2>
        <p>
          Every signing attempt is rebuilt from the confirmed roster and checked against an
          independent mainnet source. Finalization never broadcasts automatically.
        </p>
      </div>
      <div className="sigbash-controls">
        <label>
          Passkey
          <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
            {passkeys.map((passkey) => <option key={passkey.id} value={passkey.id}>{passkey.name}</option>)}
          </select>
        </label>
        {runtime?.coin && !observed && (
          <button disabled={working} onClick={verifyCurrentCoin} type="button">Verify current coin</button>
        )}
        {canSolo && (
          <button disabled={working} onClick={createSoloProposal} type="button">Create my solo withdrawal</button>
        )}
        {canCooperate && (
          <button disabled={working} onClick={createCooperativeProposal} type="button">Propose an equal cooperative refund</button>
        )}
        {canSignSolo && (
          <button disabled={working} onClick={signSoloProposal} type="button">Verify and sign my solo withdrawal</button>
        )}
        {proposalReview && runtime?.proposal?.kind === 'solo' && (
          <div className="activation-code">
            <span>Exact transaction awaiting policy signature</span>
            <p>Your payout: {proposalReview.outputs[0]?.valueSats.toLocaleString()} sats</p>
            <p>Remaining multiplayer vault: {proposalReview.outputs[1]?.valueSats.toLocaleString()} sats</p>
            <p>Miner fee: {proposalReview.feeSats.toLocaleString()} sats</p>
            <code>{runtime.proposal.digest}</code>
          </div>
        )}
        {proposalReview && runtime?.proposal?.kind === 'cooperative' && (
          <div className="activation-code">
            <span>Equal cooperative refund</span>
            {proposalReview.outputs.map((output, index) => (
              <p key={output.index}>Participant {index + 1}: {output.valueSats.toLocaleString()} sats</p>
            ))}
            <p>Miner fee: {proposalReview.feeSats.toLocaleString()} sats</p>
            <code>{runtime.proposal.digest}</code>
          </div>
        )}
        {runtime?.proposal?.kind === 'cooperative' && runtime.proposal.status === 'collecting' && observed && (
          <>
            {!hasOwnPubnonce && (
              <button disabled={working} onClick={publishCooperativeNonce} type="button">
                Join cooperative signing · round 1
              </button>
            )}
            {hasOwnPubnonce && !hasOwnPartial && allPubnonces && (
              <button
                disabled={working || !browserReady || (!hasPendingPartial
                  && !hasCooperativeSecnonce(runtime.proposal.id, runtime.participantId))}
                onClick={publishCooperativePartial}
                type="button"
              >Complete cooperative signing · round 2</button>
            )}
            <p>
              Public nonces: {Object.keys(coop?.pubnonces || {}).length}/{runtime.proposal.requiredSignerIds.length}
              {' · '}Partial signatures: {Object.keys(coop?.partialSigs || {}).length}/{runtime.proposal.requiredSignerIds.length}
            </p>
          </>
        )}
        {runtime?.proposal && !canSignSolo && runtime.proposal.kind !== 'cooperative' && (
          <p>A {runtime.proposal.kind} proposal is currently {runtime.proposal.status}.</p>
        )}
        {runtime?.proposal?.kind === 'cooperative' && runtime.proposal.status === 'finalized' && (
          <p>Cooperative exit finalized and held for explicit broadcast approval.</p>
        )}
        <p className="form-message" role="status">{working ? `Working · ${message}` : message}</p>
      </div>
    </section>
  );
}

function participantIdsForRound(round: string): string[] {
  const rounds: Record<string, string[]> = {
    alicebobcarol: ['alice', 'bob', 'carol'],
    alicebob: ['alice', 'bob'],
    alicecarol: ['alice', 'carol'],
    bobcarol: ['bob', 'carol'],
  };
  return rounds[round] || [];
}

function reviewProposal(coin: VaultCoinSnapshot, psbtBase64: string) {
  try {
    const inspection = inspectPsbt(psbtBase64);
    return {
      outputs: inspection.outputs,
      feeSats: coin.valueSats - inspection.outputs.reduce((sum, output) => sum + output.valueSats, 0),
    };
  } catch {
    return null;
  }
}

function rebuildCooperativeContext(
  artifact: PublishedRosterArtifact,
  state: Parameters<typeof ceremonyStart>[0]['state'],
  coin: VaultCoinSnapshot,
  proposal: NonNullable<RuntimeStatus['proposal']>,
) {
  if (proposal.kind !== 'cooperative' || !coin.roundId) throw new Error('proposal is not cooperative');
  const currentIds = artifact.vaults.find((vault) => vault.round === coin.roundId)?.participantIds;
  if (!currentIds) throw new Error('cooperative round is absent from the confirmed artifact');
  const rebuilt = buildVaultProposal({
    artifact,
    coin,
    kind: 'cooperative',
    expiresAt: proposal.expiresAt,
  });
  if (
    rebuilt.digest !== proposal.digest ||
    rebuilt.psbtBase64 !== proposal.psbtBase64 ||
    rebuilt.unsignedTxid !== proposal.unsignedTxid
  ) {
    throw new Error('coordinator cooperative proposal does not reproduce in this browser');
  }
  return ceremonyStart({ state, currentIds, trustedInput: coin });
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const result = await response.json() as { error?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
