'use client';

import { useState } from 'react';
import { decryptParticipantSecretEnvelope, type KeyEnvelope } from '../lib/client/key-envelope';
import {
  deriveParticipantIdentity,
  deriveParticipantSigbashPrivateKey,
} from '../lib/client/participant-identity';
import {
  createSigbashBrowserClient,
  loadSigbashBrowserRuntime,
} from '../lib/client/sigbash-browser';
import {
  createEmptySigbashCustodyBundle,
  encryptSigbashCustodyBundle,
  generateSigbashCredentials,
  recoverLatestSigbashCustodyBundle,
  type SigbashCustodyBundle,
  type SigbashCustodyEnvelope,
  type SigbashCustodyKey,
} from '../lib/client/sigbash-custody';
import { assertPasskeyWithPrf } from '../lib/client/webauthn';

interface PasskeyChoice {
  id: string;
  name: string;
}

export function SigbashCustodySetup({
  passkeys,
  started,
  keyCount,
}: {
  passkeys: PasskeyChoice[];
  started: boolean;
  keyCount: number;
}) {
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [status, setStatus] = useState(
    started ? `${keyCount} of 3 personal round keys registered` : 'Not created yet',
  );
  const [apikeyHash, setApikeyHash] = useState('');
  const [working, setWorking] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);

  async function authorizeCustody(): Promise<{
    authorization: Record<string, any>;
    authorized: Record<string, any>;
    participantSecret: string;
    recovered: { bundle: SigbashCustodyBundle; revision: number } | null;
  }> {
    let prfOutput: Uint8Array | undefined;
    try {
      if (!credentialId) throw new Error('Choose a passkey first');
      setStatus('Unlocking your protected participant identity…');
      const authorization = await postJson('/api/sigbash/custody/authorize/options', { credentialId });
      const assertion = await assertPasskeyWithPrf(authorization.options);
      prfOutput = assertion.prfOutput;
      const authorized = await postJson('/api/sigbash/custody/authorize/finish', {
        challengeId: authorization.challengeId,
        response: assertion.response,
      });
      const participantSecret = await decryptParticipantSecretEnvelope(
        authorized.participantEnvelope as KeyEnvelope,
        prfOutput,
      );
      prfOutput.fill(0);
      prfOutput = undefined;
      const identity = await deriveParticipantIdentity(participantSecret, authorization.participantId);
      if (
        identity.personalPublicKeyHex !== authorization.expectedIdentity.personalPublicKeyHex
        || identity.payoutXonlyPublicKeyHex !== authorization.expectedIdentity.payoutXonlyPublicKeyHex
      ) {
        throw new Error('passkey decrypted a participant identity that does not match this vault seat');
      }

      const recovered = await recoverLatestSigbashCustodyBundle(
        authorized.custodyEnvelopes as SigbashCustodyEnvelope[],
        participantSecret,
      );
      if ((authorized.custodyEnvelopes as unknown[]).length > 0 && !recovered) {
        throw new Error('stored Sigbash custody exists but no encrypted revision could be authenticated');
      }
      if (recovered && recovered.bundle.participantId !== authorization.participantId) {
        throw new Error('encrypted Sigbash custody belongs to a different participant');
      }
      return { authorization, authorized, participantSecret, recovered };
    } finally {
      prfOutput?.fill(0);
    }
  }

  async function openCustody() {
    setWorking(true);
    let participantSecret = '';
    try {
      const unlocked = await authorizeCustody();
      participantSecret = unlocked.participantSecret;
      if (unlocked.recovered) {
        setApikeyHash(unlocked.recovered.bundle.credentials.apikeyHash);
        setStatus(`${unlocked.recovered.bundle.keys.length} of 3 personal round keys protected`);
        return;
      }

      setStatus('Creating your independent Sigbash organization identity in this browser…');
      const credentials = await generateSigbashCredentials();
      const bundle = createEmptySigbashCustodyBundle(unlocked.authorization.participantId, credentials);
      const envelope = await encryptSigbashCustodyBundle(
        bundle,
        participantSecret,
        unlocked.authorized.nextRevision,
        unlocked.authorized.nextAad,
      );
      await postJson('/api/sigbash/custody/save', {
        leaseToken: unlocked.authorized.leaseToken,
        envelope,
      });
      setApikeyHash(credentials.apikeyHash);
      setStatus('Protected Sigbash identity created; mainnet access must be enabled before keys can be registered');
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sigbash custody setup failed');
    } finally {
      participantSecret = '';
      setWorking(false);
    }
  }

  async function registerNextRoundKey() {
    setWorking(true);
    let participantSecret = '';
    let privateKey: Uint8Array | undefined;
    let client: ReturnType<typeof createSigbashBrowserClient> | undefined;
    try {
      const unlocked = await authorizeCustody();
      participantSecret = unlocked.participantSecret;
      const recovered = unlocked.recovered;
      if (!recovered) throw new Error('create the protected Sigbash identity first');
      setApikeyHash(recovered.bundle.credentials.apikeyHash);
      const manifest = await postJson('/api/sigbash/provision/manifest', {});
      if (!manifest.next) {
        const waiting = Array.isArray(manifest.waitingFor) ? manifest.waitingFor.join('; ') : '';
        setStatus(waiting || 'All three personal Sigbash round keys are registered');
        return;
      }
      const next = manifest.next as {
        round: string;
        keyIndex: number;
        policyId: string;
        poetPolicy: Record<string, unknown>;
        conditionConfig: unknown;
      };
      const existingBundleKey = recovered.bundle.keys.find((key) => key.round === next.round);
      if (existingBundleKey) {
        setStatus(`Publishing already-protected ${next.round} registration…`);
        await publishRegistration(unlocked.authorized.leaseToken, existingBundleKey, next.poetPolicy);
        setStatus(`${next.round} registration published`);
        window.setTimeout(() => window.location.reload(), 900);
        return;
      }
      if (recovered.bundle.pendingKey && (
        recovered.bundle.pendingKey.round !== next.round
        || recovered.bundle.pendingKey.keyIndex !== next.keyIndex
        || recovered.bundle.pendingKey.policyId !== next.policyId
      )) {
        throw new Error('encrypted pending key does not match the canonical provisioning manifest');
      }

      let revision = unlocked.authorized.nextRevision as number;
      let aad = unlocked.authorized.nextAad as string;
      let workingBundle = recovered.bundle;
      if (!workingBundle.pendingKey) {
        workingBundle = {
          ...workingBundle,
          pendingKey: { round: next.round, keyIndex: next.keyIndex, policyId: next.policyId },
        };
        const pendingEnvelope = await encryptSigbashCustodyBundle(
          workingBundle,
          participantSecret,
          revision,
          aad,
        );
        const saved = await postJson('/api/sigbash/custody/save', {
          leaseToken: unlocked.authorized.leaseToken,
          envelope: pendingEnvelope,
        });
        revision = saved.nextRevision;
        aad = saved.nextAad;
      }

      setStatus('Loading and verifying the pinned Sigbash signing runtime…');
      const runtime = await loadSigbashBrowserRuntime((progress, stage) => {
        setStatus(`Signing runtime ${progress}% · ${stage}`);
      });
      setRuntimeReady(true);
      const rebuiltPolicy = runtime.sdk.conditionConfigToPoetPolicy(next.conditionConfig as never);
      if (canonicalJson(rebuiltPolicy) !== canonicalJson(next.poetPolicy)) {
        throw new Error('browser rebuilt a different Sigbash policy than the server manifest');
      }
      privateKey = await deriveParticipantSigbashPrivateKey(
        participantSecret,
        unlocked.authorization.participantId,
        next.round,
      );
      client = createSigbashBrowserClient(runtime, workingBundle.credentials, privateKey);
      privateKey.fill(0);
      privateKey = undefined;

      setStatus(`Checking Sigbash for resumable key index ${next.keyIndex}…`);
      const listed = await client.listKeys();
      let summary = listed.find((key) => key.keyId === String(next.keyIndex));
      if (summary && summary.network !== 'mainnet') {
        throw new Error(`Sigbash key index ${next.keyIndex} already exists on a non-mainnet network`);
      }
      if (!summary) {
        setStatus(`Creating immutable mainnet key for ${next.round}…`);
        const created = await client.createKey({
          policy: rebuiltPolicy,
          network: 'mainnet',
          require2FA: false,
          keyIndex: next.keyIndex,
          verbose: false,
          updateable: false,
        });
        if (created.keyIndex !== next.keyIndex) throw new Error('Sigbash returned a different key index');
        summary = {
          keyId: created.keyId,
          network: 'mainnet',
          policyRoot: created.policyRoot,
          require2FA: false,
          createdAt: null,
          bip328Xpub: created.bip328Xpub,
          poetJSON: created.poetJSON,
        };
      }
      if (!summary.bip328Xpub || !summary.policyRoot) throw new Error('Sigbash key response is incomplete');
      if (canonicalJson(summary.poetJSON) !== canonicalJson(rebuiltPolicy)) {
        throw new Error('Sigbash stored a compiled policy different from the canonical round policy');
      }
      setStatus(`Exporting the required recovery kit for ${next.round}…`);
      const recoveryKit = await client.exportRecoveryKit(summary.keyId, { keyIndex: next.keyIndex });
      if (recoveryKit.network !== 'mainnet') throw new Error('Sigbash recovery kit is not mainnet');
      const protectedKey: SigbashCustodyKey = {
        round: next.round,
        keyId: summary.keyId,
        keyIndex: next.keyIndex,
        policyId: next.policyId,
        policyRoot: summary.policyRoot,
        bip328Xpub: summary.bip328Xpub,
        poetJSON: summary.poetJSON,
        recoveryKit: { ...recoveryKit, network: 'mainnet' },
      };
      const completeBundle: SigbashCustodyBundle = {
        ...workingBundle,
        keys: [...workingBundle.keys, protectedKey],
      };
      delete completeBundle.pendingKey;
      setStatus(`Encrypting credentials and recovery kit for ${next.round}…`);
      const completeEnvelope = await encryptSigbashCustodyBundle(
        completeBundle,
        participantSecret,
        revision,
        aad,
      );
      await postJson('/api/sigbash/custody/save', {
        leaseToken: unlocked.authorized.leaseToken,
        envelope: completeEnvelope,
      });
      setStatus(`Publishing verified public registration for ${next.round}…`);
      await publishRegistration(unlocked.authorized.leaseToken, protectedKey, next.poetPolicy);
      setStatus(`${next.round} key created, recovery kit protected, and registration published`);
      window.setTimeout(() => window.location.reload(), 1100);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sigbash key registration failed');
    } finally {
      client?.disconnect();
      privateKey?.fill(0);
      participantSecret = '';
      setWorking(false);
    }
  }

  async function copyActivationCode() {
    await navigator.clipboard.writeText(apikeyHash);
    setStatus('Mainnet activation identifier copied');
  }

  async function verifyRuntime() {
    setWorking(true);
    setRuntimeReady(false);
    try {
      await loadSigbashBrowserRuntime((progress, stage) => {
        setStatus(`Verifying signing runtime ${progress}% · ${stage}`);
      });
      setRuntimeReady(true);
      setStatus('Pinned Sigbash browser runtime verified and ready');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sigbash browser runtime verification failed');
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className={started ? 'sigbash-card started' : 'sigbash-card'}>
      <div>
        <p className="eyebrow">Policy signing custody</p>
        <h2>{started ? 'Sigbash identity protected' : 'Create your Sigbash identity'}</h2>
        <p>
          Your browser creates a separate Sigbash organization identity. The service stores only an
          encrypted bundle recoverable by either of your passkeys—not the API key, user secret, or recovery kits.
        </p>
      </div>
      <div className="sigbash-controls">
        <label>
          Passkey
          <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
            {passkeys.map((passkey) => <option key={passkey.id} value={passkey.id}>{passkey.name}</option>)}
          </select>
        </label>
        <button disabled={working || !credentialId} onClick={openCustody} type="button">
          {working ? 'Working…' : started ? 'Unlock Sigbash custody' : 'Create protected identity'}
        </button>
        {started && keyCount < 3 && (
          <button disabled={working || !credentialId} onClick={registerNextRoundKey} type="button">
            Register next real mainnet round key
          </button>
        )}
        <p className="form-message" role="status">{status}</p>
        {apikeyHash && (
          <div className="activation-code">
            <span>Mainnet activation identifier (not a secret)</span>
            <code>{apikeyHash}</code>
            <button onClick={copyActivationCode} type="button">Copy identifier</button>
            <button disabled={working || runtimeReady} onClick={verifyRuntime} type="button">
              {runtimeReady ? 'Signing runtime ready' : 'Verify signing runtime'}
            </button>
            <p>Sigbash must enable mainnet for this identifier before the app can create real round keys.</p>
          </div>
        )}
      </div>
    </section>
  );
}

async function publishRegistration(
  leaseToken: string,
  key: {
    round: string;
    keyId: string;
    keyIndex: number;
    policyId: string;
    policyRoot: string;
    bip328Xpub: string;
    poetJSON?: unknown;
  },
  requestedPoetPolicy: unknown,
): Promise<void> {
  await postJson('/api/sigbash/provision/register', {
    leaseToken,
    round: key.round,
    keyId: key.keyId,
    keyIndex: key.keyIndex,
    policyId: key.policyId,
    policyRoot: key.policyRoot,
    bip328Xpub: key.bip328Xpub,
    requestedPoetPolicy,
    compiledPoetPolicy: key.poetJSON ?? requestedPoetPolicy,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const result = (await response.json()) as { error?: string } & Record<string, any>;
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
