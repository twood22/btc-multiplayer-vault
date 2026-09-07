'use client';
import { presignedBackupBinding, type PresignedRestorationProof } from '../../../src/presigned/backup';
import { validatePresignedRestorationReceipt } from '../../../src/presigned/ceremony';
import { validatePresignedGraph } from '../../../src/presigned/graph';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedFundingInput,
  type PresignedGraph, type PresignedParticipant, type PresignedPublicKit } from '../../../src/presigned/types';
import { assert, canonicalJson, commitmentDigest, exactKeys, hexBytes, identifier, publicKey,
  safeInteger, sameCanonical, supportedWalletScript } from '../../../src/presigned/validation';
import type { PresignedCeremonyStatus } from '../server/presigned-store';

const DOMAIN = 'vault/presigned-graph-v2/local-ceremony';
const MAX_RECORDS = 512;
const MAX_RECORD_BYTES = 4096;
export interface PresignedLocalBinding {
  vaultId: string; participantId: ParticipantId; personalPublicKeyHex: string; payoutXonlyPublicKeyHex: string;
}
interface GraphBinding { epochId: string; rosterDigest: string; graphDigest: string; fundingTxid: string }
export type PresignedLocalRecord =
  | { kind: 'roster-compared'; settingsDigest: string; rosterDigest: string }
  | { kind: 'input-committed'; epochId: string; rosterDigest: string; input: PresignedFundingInput }
  | ({ kind: 'graph-reviewed' | 'wallet-signing-started' } & GraphBinding)
  | ({ kind: 'backup-restored'; backupKind: 'offline' | 'passkey'; credentialId: string | null;
      backupFileDigest: string | null; proofDigest: string } & GraphBinding);
export interface PresignedLocalCeremony { binding: PresignedLocalBinding; records: PresignedLocalRecord[] }
export type PresignedLocalStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;

/** Public, append-only local records. No seed, PRF, secret nonce or decrypted portable kit is persisted.
 * This protects trusted browser code from coordinator DATA equivocation, not malicious served JavaScript,
 * cleared browser storage, compromised extensions, or a user editing their own storage. */
export function presignedLocalBinding(vaultId: string, identity: Pick<PresignedParticipant,
  'id' | 'personalPublicKeyHex' | 'payoutXonlyPublicKeyHex'>): PresignedLocalBinding {
  const binding = { vaultId, participantId: identity.id, personalPublicKeyHex: identity.personalPublicKeyHex,
    payoutXonlyPublicKeyHex: identity.payoutXonlyPublicKeyHex };
  validateBinding(binding);
  return binding;
}

export function emptyPresignedLocalCeremony(binding: PresignedLocalBinding): PresignedLocalCeremony {
  validateBinding(binding);
  return { binding: { ...binding }, records: [] };
}

export function readPresignedLocalCeremony(binding: PresignedLocalBinding,
  storage: PresignedLocalStorage = browserStorage()): PresignedLocalCeremony {
  const prefix = storagePrefix(binding);
  const records: PresignedLocalRecord[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    assert(records.length < MAX_RECORDS, 'local ceremony record limit reached; retain existing recovery material');
    const raw = storage.getItem(key);
    assert(raw !== null && raw.length <= MAX_RECORD_BYTES, 'local ceremony record is missing or oversized');
    const record = validateRecord(JSON.parse(raw) as PresignedLocalRecord, binding);
    assert(key === recordKey(prefix, record) && raw === canonicalJson(record), 'local ceremony record changed');
    records.push(record);
  }
  const state = { binding: { ...binding }, records };
  validateLocalState(state);
  return state;
}

/** The component calls this only inside the per-identity Web Lock. Distinct event keys never overwrite history. */
export function appendPresignedLocalRecord(binding: PresignedLocalBinding, candidate: PresignedLocalRecord,
  storage: PresignedLocalStorage = browserStorage()): PresignedLocalCeremony {
  const record = validateRecord(candidate, binding);
  const before = readPresignedLocalCeremony(binding, storage);
  const encoded = canonicalJson(record);
  const key = recordKey(storagePrefix(binding), record);
  if (!before.records.some(item => canonicalJson(item) === encoded)) {
    assert(before.records.length < MAX_RECORDS, 'local ceremony record limit reached');
    validateLocalState({ ...before, records: [...before.records, record] });
    assert(encoded.length <= MAX_RECORD_BYTES, 'local ceremony record is oversized');
    storage.setItem(key, encoded); // A failed/quota-blocked write throws BEFORE any wallet request or export.
    assert(storage.getItem(key) === encoded, 'local ceremony persistence failed; do not release wallet signatures');
  }
  return readPresignedLocalCeremony(binding, storage);
}

export async function withPresignedLocalCeremonyLock<T>(binding: PresignedLocalBinding,
  action: () => Promise<T>): Promise<T> {
  assert(typeof navigator !== 'undefined' && navigator.locks, 'this browser needs Web Locks for safe cross-tab signing');
  return navigator.locks.request(storagePrefix(binding), { mode: 'exclusive', ifAvailable: true }, async lock => {
    assert(lock, 'another tab is performing a vault action; wait for it to finish');
    return action();
  });
}

export function assertPresignedLocalStatus(status: PresignedCeremonyStatus, local: PresignedLocalCeremony): void {
  validateLocalState(local);
  assert(status.vaultId === local.binding.vaultId && status.participantId === local.binding.participantId,
    'coordinator changed the local identity binding');
  const own = status.identities.find(identity => identity.id === local.binding.participantId);
  if (own) assert(own.personalPublicKeyHex === local.binding.personalPublicKeyHex &&
    own.payoutXonlyPublicKeyHex === local.binding.payoutXonlyPublicKeyHex, 'coordinator changed the locally bound identity');
  for (const record of local.records) {
    if (record.kind === 'roster-compared') {
      assert(status.settingsDigest === record.settingsDigest && status.rosterDigest === record.rosterDigest,
        'coordinator changed the locally compared roster or settings');
      continue;
    }
    if (record.kind === 'wallet-signing-started') {
      // The server may not have received the begin request. The LOCAL intent still forbids restart and
      // every different epoch, while allowing an idempotent retry for the exact same graph.
      assert(status.epoch?.epochId === record.epochId && status.epoch.graph?.digest === record.graphDigest,
        'wallet signing already started locally; coordinator cannot replace or retire this epoch');
    }
    if (status.epoch?.epochId !== record.epochId) continue;
    assert(status.rosterDigest === record.rosterDigest, 'coordinator changed the epoch roster');
    if (record.kind === 'input-committed') {
      const committed = status.epoch.inputs.find(input => input.participantId === local.binding.participantId);
      if (committed) sameCanonical(committed, record.input, 'locally committed wallet input and change');
      assert(!status.epoch.graph || committed, 'frozen graph omitted the locally committed wallet input');
    } else if (record.kind === 'graph-reviewed' || record.kind === 'wallet-signing-started' || record.kind === 'backup-restored') {
      assert(status.epoch.graph?.digest === record.graphDigest && status.epoch.graph.fundingTxid === record.fundingTxid,
        'coordinator changed the locally reviewed graph');
    }
  }
}

export function presignedLocalChecks(status: PresignedCeremonyStatus, local: PresignedLocalCeremony) {
  assertPresignedLocalStatus(status, local);
  const graph = status.epoch?.graph;
  const rosterCompared = local.records.some(record => record.kind === 'roster-compared' && record.rosterDigest === status.rosterDigest);
  const graphReviewed = Boolean(graph && local.records.some(record => record.kind === 'graph-reviewed' &&
    record.epochId === graph.funding.epochId && record.graphDigest === graph.digest));
  const restored = local.records.filter(record => record.kind === 'backup-restored' && graph &&
    record.epochId === graph.funding.epochId && record.graphDigest === graph.digest) as Array<Extract<PresignedLocalRecord, { kind: 'backup-restored' }>>;
  const offlineRestored = restored.some(record => record.backupKind === 'offline');
  const passkeysRestored = [...new Set(restored.flatMap(record => record.backupKind === 'passkey' ? [record.credentialId!] : []))];
  const walletSigningStarted = local.records.some(record => record.kind === 'wallet-signing-started');
  return { rosterCompared, graphReviewed, offlineRestored, passkeysRestored, walletSigningStarted,
    walletSigningReady: rosterCompared && graphReviewed && offlineRestored && passkeysRestored.length >= 2 };
}

export function assertPresignedLocalRestartAllowed(status: PresignedCeremonyStatus, local: PresignedLocalCeremony): void {
  const checked = presignedLocalChecks(status, local);
  assert(checked.rosterCompared && !checked.walletSigningStarted, 'local wallet signing intent is irreversible; restart is forbidden');
}

/** Runtime signing gate: call with the locally rebuilt graph and freshly read ledger under the same Web Lock.
 * This grants NO chain authority: the runtime must separately verify its exact current coin/anchor/CSV age. */
export function assertPresignedLocalGraphApproved(graphInput: PresignedGraph, local: PresignedLocalCeremony): void {
  const graph = validatePresignedGraph(graphInput);
  validateLocalState(local);
  const own = graph.roster.participants.find(identity => identity.id === local.binding.participantId);
  assert(graph.roster.vaultId === local.binding.vaultId && own?.personalPublicKeyHex === local.binding.personalPublicKeyHex &&
    own.payoutXonlyPublicKeyHex === local.binding.payoutXonlyPublicKeyHex, 'runtime graph changed the locally bound identity');
  assert(local.records.some(record => record.kind === 'roster-compared' && record.rosterDigest === graph.rosterDigest),
    'compare the runtime roster locally before signing');
  assert(local.records.some(record => record.kind === 'graph-reviewed' && record.epochId === graph.funding.epochId &&
    record.graphDigest === graph.digest && record.fundingTxid === graph.fundingTxid), 'review the exact runtime graph locally before signing');
  const ownInput = graph.funding.inputs.find(input => input.participantId === local.binding.participantId)!;
  for (const record of local.records) {
    if (record.kind === 'wallet-signing-started') assert(record.epochId === graph.funding.epochId &&
      record.graphDigest === graph.digest, 'runtime graph conflicts with the irreversible local funding epoch');
    if (record.kind === 'input-committed' && record.epochId === graph.funding.epochId) {
      sameCanonical(record.input, ownInput, 'runtime graph own input and change');
    }
  }
}

export function presignedLocalGraphRecord(kind: 'graph-reviewed' | 'wallet-signing-started',
  status: PresignedCeremonyStatus): PresignedLocalRecord {
  assert(status.epoch?.graph && status.rosterDigest, 'complete graph is required for local approval');
  return { kind, epochId: status.epoch.epochId, rosterDigest: status.rosterDigest,
    graphDigest: status.epoch.graph.digest, fundingTxid: status.epoch.graph.fundingTxid };
}

/** Call ONLY with the return value of the actual local restore operation, never a coordinator receipt. */
export function presignedLocallyRestoredRecord(input: { publicKit: PresignedPublicKit; participantId: ParticipantId;
  proof: PresignedRestorationProof; backupKind: 'offline' | 'passkey'; credentialId: string | null;
  backupFileDigest: string | null }): PresignedLocalRecord {
  validatePresignedRestorationReceipt({ graph: input.publicKit.graph, preauthorizations: input.publicKit.preauthorizations,
    participantId: input.participantId, proof: input.proof });
  sameCanonical(presignedBackupBinding(input.publicKit, input.participantId), input.proof.binding, 'local restoration binding');
  const binding = input.proof.binding;
  return { kind: 'backup-restored', epochId: binding.epochId, rosterDigest: binding.rosterDigest,
    graphDigest: binding.graphDigest, fundingTxid: binding.fundingTxid, backupKind: input.backupKind,
    credentialId: input.credentialId, backupFileDigest: input.backupFileDigest, proofDigest: input.proof.proofDigest };
}

function validateBinding(binding: PresignedLocalBinding) {
  exactKeys(binding, ['vaultId', 'participantId', 'personalPublicKeyHex', 'payoutXonlyPublicKeyHex'], 'local ceremony identity');
  identifier(binding.vaultId, 'local vault');
  assert(PARTICIPANT_IDS.includes(binding.participantId), 'invalid local participant');
  publicKey(binding.personalPublicKeyHex, true, 'local personal key');
  publicKey(binding.payoutXonlyPublicKeyHex, false, 'local payout key');
}
function validateRecord(record: PresignedLocalRecord, binding: PresignedLocalBinding): PresignedLocalRecord {
  validateBinding(binding);
  const graphFields = ['epochId', 'rosterDigest', 'graphDigest', 'fundingTxid'];
  assert(record && typeof record === 'object' && !Array.isArray(record), 'invalid local ceremony record');
  if (record.kind === 'roster-compared') {
    exactKeys(record, ['kind', 'settingsDigest', 'rosterDigest'], 'local roster comparison');
    hexBytes(record.settingsDigest, 32, 'local settings');
  } else if (record.kind === 'input-committed') {
    exactKeys(record, ['kind', 'epochId', 'rosterDigest', 'input'], 'local input commitment');
    const coin = record.input;
    exactKeys(coin, ['participantId', 'txid', 'vout', 'valueSats', 'scriptPubKeyHex', 'changeScriptPubKeyHex',
      'confirmationBlockHash', 'confirmations'], 'local wallet input');
    assert(coin.participantId === binding.participantId, 'local funding input belongs to another participant');
    hexBytes(coin.txid, 32, 'local funding txid'); hexBytes(coin.confirmationBlockHash, 32, 'local funding anchor');
    safeInteger(coin.vout, 0, 0xffffffff, 'local funding vout'); safeInteger(coin.valueSats, 1, 700_000_000_000_000, 'local funding value');
    safeInteger(coin.confirmations, 1, 2_000_000, 'local funding confirmations');
    assert(supportedWalletScript(coin.scriptPubKeyHex) && (coin.changeScriptPubKeyHex === null ||
      supportedWalletScript(coin.changeScriptPubKeyHex)), 'local funding input and change must be native SegWit');
  } else if (record.kind === 'graph-reviewed' || record.kind === 'wallet-signing-started') {
    exactKeys(record, ['kind', ...graphFields], 'local graph approval');
  } else {
    assert(record.kind === 'backup-restored', 'unknown local ceremony record');
    exactKeys(record, ['kind', ...graphFields, 'backupKind', 'credentialId', 'backupFileDigest', 'proofDigest'], 'local restoration');
    hexBytes(record.proofDigest, 32, 'local restoration proof');
    if (record.backupKind === 'offline') {
      assert(record.credentialId === null, 'offline local restoration must not claim a passkey');
      hexBytes(record.backupFileDigest!, 32, 'local offline file');
    } else {
      assert(record.backupKind === 'passkey' && record.backupFileDigest === null && typeof record.credentialId === 'string' &&
        /^[A-Za-z0-9_-]{1,2048}$/u.test(record.credentialId), 'local restoration requires an exact distinct passkey');
    }
  }
  hexBytes(record.rosterDigest, 32, 'local roster');
  if ('epochId' in record) identifier(record.epochId, 'local funding epoch');
  if ('graphDigest' in record) { hexBytes(record.graphDigest, 32, 'local graph'); hexBytes(record.fundingTxid, 32, 'local funding transaction'); }
  return structuredClone(record);
}
function validateLocalState(state: PresignedLocalCeremony) {
  exactKeys(state, ['binding', 'records'], 'local ceremony state'); validateBinding(state.binding);
  assert(Array.isArray(state.records) && state.records.length <= MAX_RECORDS, 'invalid local ceremony history');
  const rosters = new Set<string>(); const graphs = new Map<string, string>(); const inputs = new Map<string, string>();
  const intents = new Set<string>();
  for (const raw of state.records) {
    const record = validateRecord(raw, state.binding);
    if (record.kind === 'roster-compared') rosters.add(canonicalJson(record));
    if ('graphDigest' in record) {
      const graph = canonicalJson({ rosterDigest: record.rosterDigest, graphDigest: record.graphDigest, fundingTxid: record.fundingTxid });
      assert(!graphs.has(record.epochId) || graphs.get(record.epochId) === graph, 'conflicting local graph approvals; keep all recovery material');
      graphs.set(record.epochId, graph);
    }
    if (record.kind === 'input-committed') {
      const digest = canonicalJson(record.input);
      assert(!inputs.has(record.epochId) || inputs.get(record.epochId) === digest, 'local wallet input is already committed for this epoch');
      inputs.set(record.epochId, digest);
    }
    if (record.kind === 'wallet-signing-started') intents.add(`${record.epochId}:${record.graphDigest}`);
  }
  assert(rosters.size <= 1, 'conflicting locally compared rosters; retain the original comparison');
  assert(intents.size <= 1, 'another local funding epoch already has an irreversible signing intent');
  const roster = state.records.find(record => record.kind === 'roster-compared');
  for (const record of state.records) {
    if (record.kind === 'roster-compared') continue;
    assert(roster && roster.rosterDigest === record.rosterDigest, 'compare the exact roster before any local epoch approval');
    if (record.kind === 'backup-restored' || record.kind === 'wallet-signing-started') {
      assert(state.records.some(review => review.kind === 'graph-reviewed' && review.epochId === record.epochId &&
        review.graphDigest === record.graphDigest), 'review the exact graph before local restoration or wallet signing');
    }
    if (record.kind === 'wallet-signing-started') {
      const backups = state.records.filter(item => item.kind === 'backup-restored' && item.epochId === record.epochId &&
        item.graphDigest === record.graphDigest) as Array<Extract<PresignedLocalRecord, { kind: 'backup-restored' }>>;
      assert(backups.some(item => item.backupKind === 'offline') &&
        new Set(backups.flatMap(item => item.backupKind === 'passkey' ? [item.credentialId] : [])).size >= 2,
      'restore the saved offline file and two distinct passkeys locally before wallet signing');
    }
  }
}
function storagePrefix(binding: PresignedLocalBinding): string {
  validateBinding(binding);
  return `presigned-local-v2:${commitmentDigest(`${DOMAIN}/identity`, { protocol: PRESIGNED_PROTOCOL, ...binding })}:`;
}
function recordKey(prefix: string, record: PresignedLocalRecord): string { return `${prefix}${commitmentDigest(`${DOMAIN}/record`, record)}`; }
function browserStorage(): PresignedLocalStorage {
  assert(typeof window !== 'undefined' && window.localStorage, 'persistent local browser storage is required for vault safety');
  return window.localStorage;
}
