'use client';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_NAME } from '../../../src/network';
import { newPresignedCeremony, presignedActionDigest, validatePresignedRestorationReceipt,
  type PresignedAction } from '../../../src/presigned/ceremony';
import { validatePresignedGraph } from '../../../src/presigned/graph';
import { finalizePresignedFunding, verifyPresignedFundingSignature } from '../../../src/presigned/funding';
import { validatePresignedRoster } from '../../../src/presigned/roster';
import { verifyPreauthorizations } from '../../../src/presigned/signing';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type PresignedPublicKit } from '../../../src/presigned/types';
import { assert, commitmentDigest, sameCanonical } from '../../../src/presigned/validation';
import type { PresignedCeremonyStatus } from '../server/presigned-store';
import { assertPasskey, stripPrfSecrets } from './webauthn';
import { assertPresignedLocalStatus, presignedLocalChecks, type PresignedLocalCeremony } from './presigned-local-ceremony';

export async function presignedPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `Presigned request failed (${response.status})`);
  return result;
}

/** Reconstruct commitments and signatures locally; phase strings grant no signing authority. */
export function verifyPresignedCeremonyView(status: PresignedCeremonyStatus, expected: {
  vaultId: string; participantId: string; settingsDigest: string; localState: PresignedLocalCeremony;
}): { publicKit: PresignedPublicKit | null; walletSigningReady: boolean } {
  assert(status.version === 2 && status.protocol === PRESIGNED_PROTOCOL && status.vaultId === expected.vaultId &&
    status.participantId === expected.participantId, 'coordinator changed protocol or membership');
  assert(status.settings.network === BITCOIN_NETWORK_NAME && status.settings.genesisHash === BITCOIN_GENESIS_HASH,
    'coordinator changed deployment network');
  const initial = newPresignedCeremony(status.vaultId, status.settings);
  assert(initial.settingsDigest === status.settingsDigest && status.settingsDigest === expected.settingsDigest,
    'coordinator changed the locally approved settings');
  assertPresignedLocalStatus(status, expected.localState);
  assert(status.rosterApprovals.length <= 3 && new Set(status.rosterApprovals).size === status.rosterApprovals.length &&
    status.rosterApprovals.every(id => PARTICIPANT_IDS.includes(id)), 'invalid roster approval participants');
  if (status.roster) {
    const roster = validatePresignedRoster(status.roster);
    sameCanonical(roster.participants, status.identities, 'registered roster identities');
    sameCanonical({ network: roster.network, genesisHash: roster.genesisHash, economics: roster.economics,
      feePolicy: roster.feePolicy, fundingFeeSats: status.settings.fundingFeeSats }, status.settings, 'roster settings');
    assert(status.rosterDigest === commitmentDigest('vault/presigned-graph-v2/roster', roster), 'coordinator changed roster digest');
  } else assert(status.rosterDigest === null && !status.epoch, 'epoch exists without a complete roster');
  const epoch = status.epoch;
  if (!epoch?.graph) {
    assert(!status.walletSigningReady && status.fundingPsbtBase64 === null, 'wallet signing appeared before complete graph');
    return { publicKit: null, walletSigningReady: false };
  }
  const graph = validatePresignedGraph(epoch.graph);
  assert(Array.isArray(epoch.walletSigningStarted) && epoch.walletSigningStarted.length <= 3 &&
    new Set(epoch.walletSigningStarted).size === epoch.walletSigningStarted.length &&
    epoch.walletSigningStarted.every(id => PARTICIPANT_IDS.includes(id)), 'invalid wallet signing intent set');
  assert(!epoch.walletSigningStarted.length || status.restartStateDigest === null, 'restart was offered after wallet signing started');
  sameCanonical(graph.roster, status.roster, 'graph roster');
  sameCanonical(graph.funding.inputs, epoch.inputs, 'frozen funding inputs');
  assert(graph.funding.epochId === epoch.epochId && graph.funding.feeSats === status.settings.fundingFeeSats,
    'graph changed funding epoch or fee');
  const entries = verifyPreauthorizations(graph, epoch.preauthorizations, false);
  const publicKit: PresignedPublicKit | null = entries.length === 12
    ? { version: 2, protocol: PRESIGNED_PROTOCOL, graph, preauthorizations: entries } : null;
  epoch.backups.forEach(receipt => validatePresignedRestorationReceipt({ graph, preauthorizations: entries,
    participantId: receipt.participantId, proof: receipt.proof }));
  const backupsComplete = PARTICIPANT_IDS.every(id => {
    const receipts = epoch.backups.filter(item => item.participantId === id);
    return receipts.some(item => item.backupKind === 'offline' && item.backupFileDigest !== null) &&
      new Set(receipts.filter(item => item.backupKind === 'passkey' && item.restoreCredentialId !== null &&
        item.restoreCredentialId === item.approvedCredentialId).map(item => item.restoreCredentialId)).size >= 2;
  });
  // These are coordinator attestations about the other clients, NOT proof of this browser's actual restores.
  const coordinatorReady = publicKit !== null && backupsComplete && status.rosterApprovals.length === 3;
  assert(!status.walletSigningReady || coordinatorReady, 'wallet release skipped verified graph or coordinator backup gates');
  assert(epoch.signatures.length <= 3 && new Set(epoch.signatures.map(item => item.participantId)).size === epoch.signatures.length,
    'duplicate or extra wallet signature');
  epoch.signatures.forEach(signature => verifyPresignedFundingSignature(graph, signature));
  assert(epoch.signatures.every(signature => epoch.walletSigningStarted.includes(signature.participantId)),
    'wallet signature appeared before its participant signing intent');
  if (epoch.signatures.length) assert(coordinatorReady, 'wallet signatures appeared before complete backup attestations');
  if (epoch.finalization) sameCanonical(finalizePresignedFunding({ graph, signatures: epoch.signatures }), epoch.finalization, 'final funding bytes');
  const ownIntent = epoch.walletSigningStarted.includes(status.participantId);
  assert(status.participantWalletSigningStarted === ownIntent && status.fundingPsbtReleased === (ownIntent && status.walletSigningReady),
    'coordinator changed wallet release intent state');
  assert(status.fundingPsbtBase64 === null || (status.walletSigningReady && ownIntent && status.fundingPsbtBase64 === graph.fundingPsbtBase64),
    'coordinator exported a different or premature funding PSBT');
  return { publicKit, walletSigningReady: coordinatorReady && status.walletSigningReady &&
    presignedLocalChecks(status, expected.localState).walletSigningReady };
}

export async function approvePresignedCeremonyAction(credentialId: string, action: PresignedAction): Promise<PresignedCeremonyStatus> {
  const digest = presignedActionDigest(action);
  const approval = await presignedPost<{ challengeId: string; protocol: string; action: PresignedAction;
    actionDigest: string; options: Record<string, unknown> }>('/api/vault/presigned/action/options', { credentialId, action });
  assert(approval.protocol === PRESIGNED_PROTOCOL && approval.actionDigest === digest &&
    presignedActionDigest(approval.action) === digest, 'coordinator changed the action before passkey approval');
  const credentials = approval.options.allowCredentials as Array<{ id: string; type: string }>;
  assert(approval.options.userVerification === 'required' && credentials?.length === 1 &&
    credentials[0]?.id === credentialId && credentials[0]?.type === 'public-key', 'ceremony challenge changed the exact passkey');
  const response = await assertPasskey(approval.options);
  assert(response.id === credentialId, 'ceremony approval used another credential');
  stripPrfSecrets(response);
  return presignedPost('/api/vault/presigned/action/finish', { challengeId: approval.challengeId, actionDigest: digest, response });
}
