'use client';

import type { SigbashClient } from '@sigbash/sdk';
import {
  authorizeCooperativeContext,
  ceremonyNonce,
  ceremonyPartial,
  type CeremonyContext,
} from '../../../src/ceremony.js';
import {
  authorizeFinalSweep,
  createRecoveryShare,
  localSignerFromSecret,
  type LocalSigner,
  type RecoveryShare,
} from '../../../src/custody.js';
import { verifyVaultTransaction } from '../../../src/consensus.js';
import {
  authorizeSoloSigningArtifacts,
  buildFinalSweepPsbt,
  buildSoloWithdrawalPsbt,
  inspectPsbt,
  psbtInspectionToPolicyTx,
  signFinalSweepPsbt,
} from '../../../src/psbt.js';
import {
  canonicalRosterJson,
  createPublishedRosterArtifact,
  publishedRosterDigest,
  type PublishedRosterArtifact,
} from '../../../src/roster-ceremony.js';
import { evaluatePolicy } from '../../../src/sigbash.js';
import type { TrustedVaultInput } from '../../../src/types.js';
import { policyId, roundId, type SigbashRosterRegistration } from '../../../src/vault.js';
import type { SigbashCustodyKey } from './sigbash-custody';

export interface UnlockedPublishedVault {
  artifact: PublishedRosterArtifact;
  digest: string;
  signer: LocalSigner;
}

/**
 * Rebuild and verify the complete immutable artifact before putting one local
 * participant secret into the state. No server-supplied vault, policy, amount,
 * fee, or delay is trusted independently of the confirmed digest.
 */
export function unlockPublishedVault({
  artifact,
  expectedDigest,
  participantSecret,
}: {
  artifact: PublishedRosterArtifact;
  expectedDigest: string;
  participantSecret: string;
}): UnlockedPublishedVault {
  if (!/^[0-9a-f]{64}$/u.test(expectedDigest)) throw new Error('confirmed roster digest is invalid');
  const rebuilt = createPublishedRosterArtifact(
    artifact.vaultId,
    artifact.participants,
    artifact.economics,
  );
  if (canonicalRosterJson(rebuilt) !== canonicalRosterJson(artifact)) {
    throw new Error('published roster artifact contains data that does not reproduce from its commitments');
  }
  const digest = publishedRosterDigest(rebuilt);
  if (digest !== expectedDigest) throw new Error('published roster does not match the confirmed digest');
  const signer = localSignerFromSecret(
    rebuilt.participants,
    participantSecret,
    rebuilt.economics,
  );
  return { artifact: rebuilt, digest, signer };
}

export function createAuthorizedCooperativeNonce(input: {
  unlocked: UnlockedPublishedVault;
  context: CeremonyContext;
  trustedInput: TrustedVaultInput;
}) {
  return ceremonyNonce({
    state: input.unlocked.signer.state,
    participantId: input.unlocked.signer.participantId,
    context: input.context,
    trustedInput: input.trustedInput,
  });
}

export function createAuthorizedCooperativePartial(input: {
  unlocked: UnlockedPublishedVault;
  context: CeremonyContext;
  trustedInput: TrustedVaultInput;
  pubnonces: Record<string, string>;
  secnonce: string;
}) {
  return ceremonyPartial({
    state: input.unlocked.signer.state,
    participantId: input.unlocked.signer.participantId,
    context: input.context,
    trustedInput: input.trustedInput,
    pubnonces: input.pubnonces,
    secnonce: input.secnonce,
  });
}

export function createAuthorizedRecoverySignature(input: {
  unlocked: UnlockedPublishedVault;
  currentIds: string[];
  vanishedId: string;
  psbtBase64: string;
  trustedInput: TrustedVaultInput;
}): { share: RecoveryShare; authorization: ReturnType<typeof createRecoveryShare>['authorization'] } {
  return createRecoveryShare({
    signer: input.unlocked.signer,
    currentIds: input.currentIds,
    vanishedId: input.vanishedId,
    psbtBase64: input.psbtBase64,
    trustedInput: input.trustedInput,
  });
}

export function signAuthorizedFinalSweep(input: {
  unlocked: UnlockedPublishedVault;
  psbtBase64: string;
  trustedInput: TrustedVaultInput;
  destinationAddress?: string;
  feeSats?: number;
}) {
  const participantId = input.unlocked.signer.participantId;
  const feeSats = input.feeSats ?? input.unlocked.signer.state.economics.finalSweepFeeSats;
  const authorization = authorizeFinalSweep({
    state: input.unlocked.signer.state,
    participantId,
    psbtBase64: input.psbtBase64,
    trustedInput: input.trustedInput,
    ...(input.destinationAddress ? { destinationAddress: input.destinationAddress } : {}),
    feeSats,
  });
  const signed = signFinalSweepPsbt({
    state: input.unlocked.signer.state,
    participantId,
    psbtBase64: input.psbtBase64,
  });
  if (signed.txid !== authorization.unsignedTxid) {
    throw new Error('final sweep signature changed the transaction the participant authorized');
  }
  const consensus = verifyVaultTransaction({
    txHex: signed.transactionHex,
    prevouts: [{
      scriptPubKeyHex: input.trustedInput.scriptPubKeyHex,
      valueSats: input.trustedInput.valueSats,
    }],
  });
  return { authorization, signed, consensus };
}

export function buildAuthorizedSoloWithdrawal(input: {
  unlocked: UnlockedPublishedVault;
  currentIds: string[];
  trustedInput: TrustedVaultInput;
}) {
  const { signer } = input.unlocked;
  const round = roundId(input.currentIds);
  const vault = signer.state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  if (!input.currentIds.includes(signer.participantId)) {
    throw new Error(`${signer.participantId} is not in round ${round}`);
  }
  if (input.trustedInput.scriptPubKeyHex !== vault.outputScriptHex) {
    throw new Error('trusted solo input is not the committed current-round vault');
  }
  const built = buildSoloWithdrawalPsbt({
    state: signer.state,
    currentIds: input.currentIds,
    leaverId: signer.participantId,
    txid: input.trustedInput.txid,
    vout: input.trustedInput.vout,
    valueSats: input.trustedInput.valueSats,
  });
  const policy = signer.state.policies.get(policyId(input.currentIds, signer.participantId));
  if (!policy) throw new Error(`committed solo policy ${round}:${signer.participantId} is missing`);
  const failures = evaluatePolicy(
    psbtInspectionToPolicyTx({ state: signer.state, inspection: inspectPsbt(built.psbtBase64) }),
    policy,
  );
  if (failures.length) throw new Error(`locally built solo withdrawal violates policy: ${failures.join('; ')}`);
  return built;
}

/**
 * Live solo-signing boundary. The SDK's decrypted KMC stays inside this call;
 * only a transaction re-authorized against the original PSBT can leave it.
 */
export async function signAuthorizedSoloWithdrawal(input: {
  unlocked: UnlockedPublishedVault;
  currentIds: string[];
  trustedInput: TrustedVaultInput;
  custodyKey: SigbashCustodyKey;
  client: SigbashClient;
  onProgress?: (stage: string, message: string) => void;
}) {
  const { signer } = input.unlocked;
  const round = roundId(input.currentIds);
  if (input.custodyKey.round !== round) throw new Error('encrypted Sigbash key belongs to a different round');
  if (input.custodyKey.policyId !== `${round}:${signer.participantId}`) {
    throw new Error('encrypted Sigbash key belongs to a different participant policy');
  }
  const rosterEntry = signer.roster.find((entry) => entry.id === signer.participantId);
  const registration = rosterEntry?.sigbashRegistrationByRound?.[round];
  if (!registration) throw new Error('confirmed roster has no live Sigbash registration for this round');
  assertSameRegistration(input.custodyKey, registration);

  const built = buildAuthorizedSoloWithdrawal({
    unlocked: input.unlocked,
    currentIds: input.currentIds,
    trustedInput: input.trustedInput,
  });
  const key = await input.client.getKey(input.custodyKey.keyId, {
    verbose: true,
    keyIndex: input.custodyKey.keyIndex,
  });
  if (key.network !== 'mainnet') throw new Error('Sigbash returned a non-mainnet key');
  if (key.keyIndex !== input.custodyKey.keyIndex || key.keyId !== input.custodyKey.keyId) {
    throw new Error('Sigbash returned a different key identity');
  }
  if (key.policyRoot !== input.custodyKey.policyRoot) {
    throw new Error('Sigbash key policy root differs from the confirmed roster');
  }
  if (key.require2FA) throw new Error('unexpected TOTP requirement on the confirmed Sigbash key');

  const verification = await input.client.verifyPSBT({
    psbtBase64: built.psbtBase64,
    kmcJSON: key.kmcJSON,
    network: 'mainnet',
    progressCallback: input.onProgress,
  });
  if (verification.passed !== true || verification.error) {
    throw new Error(`Sigbash rejected the committed solo withdrawal: ${verification.error || 'policy did not pass'}`);
  }
  const signed = await input.client.signPSBT({
    keyId: input.custodyKey.keyId,
    psbtBase64: built.psbtBase64,
    kmcJSON: key.kmcJSON,
    network: 'mainnet',
    require2FA: false,
    finalizePsbt: true,
    progressCallback: input.onProgress,
  });
  if (signed.success !== true || signed.error) {
    throw new Error(`Sigbash solo signing failed: ${signed.error || 'signer returned no success'}`);
  }
  if (signed.policyRootHex !== input.custodyKey.policyRoot) {
    throw new Error('Sigbash signed under a policy root different from the confirmed roster');
  }
  const authorization = authorizeSoloSigningArtifacts(
    signer.state,
    input.currentIds,
    signer.participantId,
    built.psbtBase64,
    {
      txHex: signed.txHex || null,
      signedPsbtBase64: signed.signedPSBT || null,
    },
  );
  if (!authorization.finalTxid || !authorization.consensus) {
    throw new Error('Sigbash did not return a finalized, consensus-valid solo transaction');
  }
  return {
    built,
    verification: {
      passed: true as const,
      pathId: verification.pathId,
      satisfiedClause: verification.satisfiedClause,
    },
    signed: {
      transactionHex: signed.txHex || null,
      signedPsbtBase64: signed.signedPSBT || null,
      pathId: signed.pathId,
      satisfiedClause: signed.satisfiedClause,
      policyRootHex: signed.policyRootHex,
    },
    authorization,
  };
}

export function assertCooperativeProposal(input: {
  unlocked: UnlockedPublishedVault;
  context: CeremonyContext;
  trustedInput: TrustedVaultInput;
}) {
  return authorizeCooperativeContext({
    state: input.unlocked.signer.state,
    context: input.context,
    trustedInput: input.trustedInput,
  });
}

function assertSameRegistration(
  custodyKey: SigbashCustodyKey,
  registration: SigbashRosterRegistration,
): void {
  if (
    custodyKey.keyId !== registration.keyId ||
    custodyKey.keyIndex !== registration.keyIndex ||
    custodyKey.bip328Xpub !== registration.bip328Xpub ||
    custodyKey.policyRoot !== registration.policyRoot ||
    custodyKey.policyId !== registration.policyId
  ) {
    throw new Error('encrypted Sigbash key does not match the confirmed public registration');
  }
}
