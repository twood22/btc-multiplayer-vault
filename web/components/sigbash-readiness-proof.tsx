'use client';

import { useState } from 'react';
import { buildSigbashReadinessFixture } from '../../src/sigbash-readiness.js';
import type { VaultCoinSnapshot } from '../../src/vault-runtime.js';
import { deriveParticipantSigbashPrivateKey } from '../lib/client/participant-identity';
import {
  createSigbashBrowserClient,
  loadSigbashBrowserRuntime,
} from '../lib/client/sigbash-browser';
import { withUnlockedVaultCustody } from '../lib/client/unlocked-vault-custody';
import { signAuthorizedSoloWithdrawal } from '../lib/client/vault-signing';

interface PasskeyChoice { id: string; name: string }
interface ReadinessStatus {
  participantId: string;
  participantProofRounds: string[];
  participantRequiredRounds: string[];
  totalProofCount: number;
  requiredProofCount: 9;
  nextRound: string | null;
  ready: boolean;
}

interface ReadinessChallenge {
  id: string;
  rosterDigest: string;
  participantId: string;
  round: string;
  currentIds: string[];
  coin: VaultCoinSnapshot;
  key: { keyId: string; keyIndex: number; policyId: string; policyRoot: string };
  validPsbtBase64: string;
  tamperedPsbts: Record<'wrongAmount' | 'wrongAddress' | 'extraOutput', string>;
}

export function SigbashReadinessProof({
  passkeys,
  initialStatus,
}: {
  passkeys: PasskeyChoice[];
  initialStatus: ReadinessStatus;
}) {
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [status, setStatus] = useState(initialStatus);
  const [message, setMessage] = useState(initialStatus.nextRound
    ? `${initialStatus.participantProofRounds.length} of 3 live signing proofs complete`
    : 'All of your live Sigbash round keys are proven');
  const [working, setWorking] = useState(false);

  async function proveNextRound() {
    if (!credentialId || !status.nextRound) return;
    setWorking(true);
    let privateKey: Uint8Array | undefined;
    let client: ReturnType<typeof createSigbashBrowserClient> | undefined;
    try {
      const completed = await withUnlockedVaultCustody({
        credentialId,
        action: async ({ unlocked, participantSecret, custody, leaseToken }) => {
          const challenge = await postJson('/api/sigbash/readiness/challenge', {
            leaseToken,
          }) as unknown as ReadinessChallenge;
          if (challenge.rosterDigest !== unlocked.digest ||
              challenge.participantId !== unlocked.signer.participantId ||
              challenge.round !== status.nextRound) {
            throw new Error('readiness challenge differs from this participant’s confirmed roster');
          }
          const vault = unlocked.artifact.vaults.find((item) => item.round === challenge.round);
          const expectedValueSats = challenge.currentIds.length === 3
            ? unlocked.artifact.funding.valueSats
            : unlocked.artifact.funding.valueSats - unlocked.artifact.economics.firstWithdrawalSats -
              unlocked.artifact.economics.soloWithdrawalFeeSats;
          if (!vault || JSON.stringify(vault.participantIds) !== JSON.stringify(challenge.currentIds) ||
              vault.outputScriptHex !== challenge.coin.scriptPubKeyHex ||
              challenge.coin.rosterDigest !== unlocked.digest ||
              challenge.coin.vaultId !== unlocked.artifact.vaultId ||
              challenge.coin.kind !== 'vault' || challenge.coin.roundId !== challenge.round ||
              challenge.coin.ownerParticipantId !== null || challenge.coin.vout !== 0 ||
              challenge.coin.valueSats !== expectedValueSats ||
              !/^[0-9a-f]{64}$/u.test(challenge.coin.txid)) {
            throw new Error('readiness challenge coin is not the confirmed vault round');
          }
          const rebuilt = buildSigbashReadinessFixture({
            artifact: unlocked.artifact,
            rosterDigest: unlocked.digest,
            participantId: unlocked.signer.participantId,
            round: challenge.round,
            inputTxid: challenge.coin.txid,
          });
          if (rebuilt.validPsbtBase64 !== challenge.validPsbtBase64 ||
              rebuilt.tamperedPsbts.wrongAmount !== challenge.tamperedPsbts.wrongAmount ||
              rebuilt.tamperedPsbts.wrongAddress !== challenge.tamperedPsbts.wrongAddress ||
              rebuilt.tamperedPsbts.extraOutput !== challenge.tamperedPsbts.extraOutput) {
            throw new Error('server readiness PSBT set does not reproduce in this browser');
          }
          const custodyKey = custody.keys.find((item) => item.round === challenge.round);
          if (!custodyKey || custodyKey.keyId !== challenge.key.keyId ||
              custodyKey.keyIndex !== challenge.key.keyIndex ||
              custodyKey.policyId !== challenge.key.policyId ||
              custodyKey.policyRoot !== challenge.key.policyRoot) {
            throw new Error('encrypted Sigbash key differs from the readiness challenge');
          }
          setMessage('Loading and verifying the pinned Sigbash runtime…');
          const runtime = await loadSigbashBrowserRuntime((progress, stage) => {
            setMessage(`Sigbash ${progress}% · ${stage}`);
          });
          privateKey = await deriveParticipantSigbashPrivateKey(
            participantSecret,
            unlocked.signer.participantId,
            challenge.round,
          );
          client = createSigbashBrowserClient(runtime, custody.credentials, privateKey);
          privateKey.fill(0);
          privateKey = undefined;
          const key = await client.getKey(custodyKey.keyId, {
            verbose: true,
            keyIndex: custodyKey.keyIndex,
          });
          if (key.network !== 'mainnet' || key.keyId !== custodyKey.keyId ||
              key.keyIndex !== custodyKey.keyIndex || key.policyRoot !== custodyKey.policyRoot ||
              key.require2FA) {
            throw new Error('Sigbash returned a key different from the confirmed mainnet registration');
          }
          for (const [name, psbtBase64] of Object.entries(challenge.tamperedPsbts)) {
            setMessage(`Proving Sigbash rejects hostile ${name} transaction…`);
            const rejected = await client.verifyPSBT({
              psbtBase64,
              kmcJSON: key.kmcJSON,
              network: 'mainnet',
            });
            if (rejected.passed !== false) {
              throw new Error(`Sigbash did not explicitly reject the hostile ${name} transaction`);
            }
          }
          setMessage(`Proving live mainnet signing for ${challenge.round}…`);
          const signed = await signAuthorizedSoloWithdrawal({
            unlocked,
            currentIds: challenge.currentIds,
            trustedInput: challenge.coin,
            custodyKey,
            client,
            onProgress: (stage, detail) => setMessage(`${stage} · ${detail}`),
          });
          if (!signed.signed.transactionHex) {
            throw new Error('Sigbash readiness proof returned no finalized transaction');
          }
          return postJson('/api/sigbash/readiness/finish', {
            leaseToken,
            challengeId: challenge.id,
            transactionHex: signed.signed.transactionHex,
            ...(signed.signed.signedPsbtBase64
              ? { signedPsbtBase64: signed.signed.signedPsbtBase64 }
              : {}),
          }) as Promise<Record<string, unknown>>;
        },
      });
      const next = completed as unknown as ReadinessStatus;
      setStatus(next);
      setMessage(next.ready
        ? 'All nine live mainnet Sigbash keys are proven. Funding remains closed until the separate operational release checks and explicit approval pass.'
        : next.nextRound
          ? `${next.participantProofRounds.length} of 3 personal proofs complete; ${next.nextRound} is next`
          : `Your three proofs are complete; waiting for friends (${next.totalProofCount}/9 total)`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Live Sigbash readiness proof failed');
    } finally {
      client?.disconnect();
      privateKey?.fill(0);
      setWorking(false);
    }
  }

  return (
    <section className={status.participantProofRounds.length === 3 ? 'sigbash-card started' : 'sigbash-card'}>
      <div>
        <p className="eyebrow">Live signing proof</p>
        <h2>{status.ready ? 'Sigbash signing gate passed' : 'Prove every Sigbash round key'}</h2>
        <p>
          Each proof uses a server-random unfunded outpoint. Sigbash must reject three hostile
          transactions and return one real mainnet signature that this service verifies independently.
          Completing this signer gate does not authorize funding.
        </p>
      </div>
      <div className="sigbash-controls">
        <label>
          Passkey
          <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
            {passkeys.map((passkey) => <option key={passkey.id} value={passkey.id}>{passkey.name}</option>)}
          </select>
        </label>
        {status.nextRound && (
          <button disabled={working || !credentialId} onClick={proveNextRound} type="button">
            {working ? 'Proving live signing…' : `Prove ${status.nextRound} key`}
          </button>
        )}
        <p>
          Your proofs: {status.participantProofRounds.length}/3
          {' · '}Whole vault: {status.totalProofCount}/{status.requiredProofCount}
        </p>
        <p className="form-message" role="status">{message}</p>
      </div>
    </section>
  );
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
