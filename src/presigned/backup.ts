import { Buffer } from 'buffer';
import * as ecc from 'tiny-secp256k1';
import { validatePresignedGraph } from './graph.js';
import { verifyRecoveryAuthorizations } from './fixed-recovery.js';
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys } from './roster.js';
import { completePresignedExit, verifyPreauthorizations } from './signing.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, isPresignedProtocol, type ParticipantId,
  type PresignedProtocol, type PresignedVersion, type PresignedGraph, type Preauthorization,
  type RecoveryAuthorization, type PresignedPublicKit } from './types.js';
import { assert, canonicalJson, commitmentDigest, exactKeys, genesisHash, hexBytes, identifier,
  participantId, sameCanonical, validatePresignedProtocol } from './validation.js';
import type { BitcoinNetworkName } from '../types.js';

export const MAX_PRESIGNED_BACKUP_PLAINTEXT_BYTES = 512 * 1024;
export const MAX_PRESIGNED_BACKUP_FILE_BYTES = 720 * 1024;
const FORMAT = 'btc-vault-offline-recovery-v1' as const;
const DOMAIN = 'btc-multiplayer-vault/presigned-offline-recovery/v1';
const encoder = new TextEncoder();

export function presignedBackupDomain(protocol: PresignedProtocol): string {
  assert(isPresignedProtocol(protocol), 'unknown backup protocol');
  return protocol === PRESIGNED_PROTOCOL ? DOMAIN : 'btc-multiplayer-vault/presigned-offline-recovery/v3';
}

/** Bind imports to separately reviewed public commitments, not just the file's own claims. */
export interface PresignedBackupBinding {
  protocol: PresignedProtocol;
  network: BitcoinNetworkName;
  genesisHash: string;
  vaultId: string;
  participantId: ParticipantId;
  epochId: string;
  rosterDigest: string;
  graphDigest: string;
  fundingTxid: string;
}

export interface PresignedOfflineBackup {
  version: 1 | 3;
  protocol: PresignedProtocol;
  format: typeof FORMAT | 'btc-vault-offline-recovery-v3';
  cipher: 'AES-256-GCM';
  kdf: 'HKDF-SHA256';
  binding: PresignedBackupBinding;
  salt: string;
  iv: string;
  ciphertext: string;
}

/** Client-only decrypted material: never send to a coordinator, log, or UI error. */
export interface RestoredPresignedBackup {
  version: PresignedVersion;
  protocol: PresignedProtocol;
  participantId: ParticipantId;
  participantSecret: string;
  publicKit: PresignedPublicKit;
}

/** Local verification receipt, not proof of durable file storage; bind it to a fresh passkey challenge. */
export interface PresignedRestorationProof {
  version: PresignedVersion;
  protocol: PresignedProtocol;
  binding: PresignedBackupBinding;
  publicKitDigest: string;
  participantIdentityDigest: string;
  exitProofs: Array<{ exitId: string; txid: string; transactionDigest: string }>;
  /** V3 key-possession signatures on non-transaction challenges; never trigger signatures. */
  recoveryProofs?: Array<{ recoveryId: string; signatureHex: string }>;
  proofDigest: string;
}

/** An independently random offline wrapping key; keep it separately from the encrypted file. */
export function generatePresignedOfflineSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function presignedBackupBinding(kit: PresignedPublicKit, id: ParticipantId): PresignedBackupBinding {
  participantId(id);
  const graph = kit.graph;
  validatePresignedProtocol(kit.version, kit.protocol);
  assert(kit.protocol === graph.protocol && kit.version === graph.version, 'kit and graph protocols differ');
  return validateBinding({ protocol: graph.protocol, network: graph.roster.network,
    genesisHash: graph.roster.genesisHash, vaultId: graph.roster.vaultId, participantId: id,
    epochId: graph.funding.epochId, rosterDigest: graph.rosterDigest, graphDigest: graph.digest,
    fundingTxid: graph.fundingTxid });
}

export function validatePresignedPublicKit(input: PresignedPublicKit): PresignedPublicKit {
  boundedJson(input);
  validatePresignedProtocol(input.version, input.protocol);
  exactKeys(input, ['version', 'protocol', 'graph', 'preauthorizations',
    ...(input.protocol === PRESIGNED_PROTOCOL_V3 ? ['recoveryAuthorizations'] : [])], 'public recovery kit');
  const graph = validatePresignedGraph(input.graph);
  assert(input.protocol === graph.protocol && input.version === graph.version, 'kit and graph protocols differ');
  const preauthorizations = verifyPreauthorizations(graph, input.preauthorizations, true);
  const recoveryAuthorizations = graph.protocol === PRESIGNED_PROTOCOL_V3
    ? verifyRecoveryAuthorizations(graph, input.recoveryAuthorizations!, true) : undefined;
  return { version: graph.version, protocol: graph.protocol, graph, preauthorizations,
    ...(recoveryAuthorizations ? { recoveryAuthorizations } : {}) };
}

/** Build a complete version-bound public kit without adding fields to legacy artifacts. */
export function createPresignedPublicKit(input: {
  graph: PresignedGraph; preauthorizations: Preauthorization[]; recoveryAuthorizations?: RecoveryAuthorization[];
}): PresignedPublicKit {
  assert(input.graph.protocol === PRESIGNED_PROTOCOL_V3 || input.recoveryAuthorizations === undefined,
    'legacy kit cannot contain recovery authorizations');
  return validatePresignedPublicKit({ version: input.graph.version, protocol: input.graph.protocol,
    graph: input.graph, preauthorizations: input.preauthorizations,
    ...(input.graph.protocol === PRESIGNED_PROTOCOL_V3 ? { recoveryAuthorizations: input.recoveryAuthorizations } : {}) });
}

export async function encryptPresignedOfflineBackup(input: {
  publicKit: PresignedPublicKit;
  participantId: ParticipantId;
  participantSecret: string;
  offlineSecret: Uint8Array;
}): Promise<PresignedOfflineBackup> {
  requireOfflineSecret(input.offlineSecret);
  const publicKit = validatePresignedPublicKit(input.publicKit);
  assertParticipantIdentity(publicKit, input.participantId, input.participantSecret);
  assert(encode(input.offlineSecret) !== input.participantSecret, 'offline wrapping secret must be independent of the participant secret');
  const payload: RestoredPresignedBackup = { version: publicKit.version, protocol: publicKit.protocol,
    participantId: input.participantId, participantSecret: input.participantSecret, publicKit };
  const plaintext = encoder.encode(canonicalJson(payload));
  try {
    assert(plaintext.length <= MAX_PRESIGNED_BACKUP_PLAINTEXT_BYTES, 'recovery payload is too large');
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = { version: publicKit.protocol === PRESIGNED_PROTOCOL ? 1 as const : 3 as const,
      protocol: publicKit.protocol,
      format: publicKit.protocol === PRESIGNED_PROTOCOL ? FORMAT : 'btc-vault-offline-recovery-v3' as const,
      cipher: 'AES-256-GCM' as const, kdf: 'HKDF-SHA256' as const,
      binding: presignedBackupBinding(publicKit, input.participantId), salt: encode(salt), iv: encode(iv) };
    const aad = encoder.encode(canonicalJson(header));
    const key = await offlineKey(input.offlineSecret, salt, publicKit.protocol);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext,
    ));
    return { ...header, ciphertext: encode(ciphertext) };
  } finally {
    plaintext.fill(0);
    payload.participantSecret = '';
  }
}

export function serializePresignedOfflineBackup(envelope: PresignedOfflineBackup): string {
  const validated = validateEnvelope(envelope);
  const serialized = canonicalJson(validated);
  assert(encoder.encode(serialized).length <= MAX_PRESIGNED_BACKUP_FILE_BYTES, 'encrypted recovery file is too large');
  return serialized;
}

export function parsePresignedOfflineBackup(serialized: string): PresignedOfflineBackup {
  assert(typeof serialized === 'string' && serialized.length <= MAX_PRESIGNED_BACKUP_FILE_BYTES &&
    encoder.encode(serialized).length <= MAX_PRESIGNED_BACKUP_FILE_BYTES, 'encrypted recovery file is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error('presigned-v2: recovery file is not JSON'); }
  return validateEnvelope(parsed);
}

/** The action runs locally. Do not return or retain participantSecret from the callback. */
export async function withRestoredPresignedOfflineBackup<T>(input: {
  envelope: PresignedOfflineBackup;
  offlineSecret: Uint8Array;
  expectedBinding: PresignedBackupBinding;
  action: (restored: RestoredPresignedBackup) => T | Promise<T>;
}): Promise<T> {
  const restored = await decryptBackup(input);
  try { return await input.action(restored); }
  finally { restored.participantSecret = ''; }
}

export async function verifyPresignedOfflineBackupRestoration(input: {
  envelope: PresignedOfflineBackup;
  offlineSecret: Uint8Array;
  expectedBinding: PresignedBackupBinding;
}): Promise<PresignedRestorationProof> {
  return withRestoredPresignedOfflineBackup({ ...input, action: restored =>
    verifyPresignedKitRestoration({ ...restored, expectedBinding: input.expectedBinding }) });
}

/** Prove that this local secret can complete every owner exit; never return executable witnesses. */
export function verifyPresignedKitRestoration(input: {
  publicKit: PresignedPublicKit;
  participantId: ParticipantId;
  participantSecret: string;
  expectedBinding: PresignedBackupBinding;
}): PresignedRestorationProof {
  const publicKit = validatePresignedPublicKit(input.publicKit);
  const binding = presignedBackupBinding(publicKit, input.participantId);
  sameCanonical(binding, validateBinding(input.expectedBinding), 'recovery import binding');
  const derived = assertParticipantIdentity(publicKit, input.participantId, input.participantSecret, false);
  const domain = presignedBackupDomain(publicKit.protocol);
  try {
    const exits = publicKit.graph.exits.filter(exit => exit.leaver === input.participantId)
      .sort((left, right) => left.id.localeCompare(right.id));
    assert(exits.length === 3, 'recovery must verify all three owner exits');
    const exitProofs = exits.map(exit => {
      const privateKey = derived.keys.soloPrivateKeys[exit.roundId];
      assert(privateKey, 'recovery is missing a required round key');
      const completed = completePresignedExit({ graph: publicKit.graph,
        preauthorizations: publicKit.preauthorizations, exitId: exit.id,
        participantId: input.participantId, privateKey, approvedGraphDigest: binding.graphDigest });
      try {
        assert(completed.txid === exit.txid, 'restored exit changed its committed transaction');
        return { exitId: exit.id, txid: completed.txid,
          transactionDigest: commitmentDigest(`${domain}/verified-exit`, { transactionHex: completed.transactionHex }) };
      } finally {
        // Strings cannot be reliably zeroized; drop the executable witness reference immediately.
        completed.transactionHex = '';
      }
    });
    const recoveryProofs = publicKit.protocol === PRESIGNED_PROTOCOL_V3
      ? publicKit.graph.recoveries!.filter(recovery => recovery.recipientIds.includes(input.participantId))
        .sort((a, b) => a.id.localeCompare(b.id)).map(recovery => {
          const key = derived.keys.recoveryTriggerPrivateKeys?.[recovery.roundId];
          assert(key, 'restored participant lacks recovery trigger key');
          const challenge = recoveryPossessionChallenge(binding, recovery.id);
          return { recoveryId: recovery.id, signatureHex: Buffer.from(ecc.signSchnorr(challenge, key)).toString('hex') };
        }) : undefined;
    verifyPresignedRecoveryRestorationProof(publicKit, input.participantId, recoveryProofs);
    const proof = { version: publicKit.version, protocol: publicKit.protocol, binding,
      publicKitDigest: commitmentDigest(`${domain}/public-kit`, publicKit),
      participantIdentityDigest: commitmentDigest(`${domain}/participant`, derived.publicIdentity), exitProofs,
      ...(recoveryProofs ? { recoveryProofs } : {}) };
    return { ...proof, proofDigest: commitmentDigest(`${domain}/restoration-proof`, proof) };
  } finally { clearPresignedParticipantKeys(derived.keys); }
}

/** Public proof of custody on a non-transaction challenge, never a spend capability. */
export function verifyPresignedRecoveryRestorationProof(kit: PresignedPublicKit, id: ParticipantId,
  proofs: PresignedRestorationProof['recoveryProofs']): void {
  if (kit.protocol === PRESIGNED_PROTOCOL) {
    assert(proofs === undefined, 'legacy restoration cannot claim V3 recovery proofs');
    return;
  }
  const binding = presignedBackupBinding(kit, id);
  const identity = kit.graph.roster.participants.find(member => member.id === id);
  assert(identity, 'restoration owner is absent from roster');
  const recoveries = kit.graph.recoveries!.filter(recovery => recovery.recipientIds.includes(id))
    .sort((a, b) => a.id.localeCompare(b.id));
  assert(Array.isArray(proofs) && proofs.length === 3 && recoveries.length === 3,
    'restoration must prove all three owner trigger keys');
  proofs.forEach((proof, index) => {
    exactKeys(proof, ['recoveryId', 'signatureHex'], 'recovery key-possession proof');
    const recovery = recoveries[index]!;
    assert(proof.recoveryId === recovery.id, 'restoration recovery order or membership changed');
    const signature = hexBytes(proof.signatureHex, 64, 'trigger key-possession signature');
    const publicKey = hexBytes(identity.recoveryTriggerPublicKeys?.[recovery.roundId]!, 32, 'trigger public key');
    assert(ecc.verifySchnorr(recoveryPossessionChallenge(binding, recovery.id), publicKey, signature),
      'restoration trigger key-possession proof is invalid');
  });
}

function recoveryPossessionChallenge(binding: PresignedBackupBinding, recoveryId: string): Buffer {
  return Buffer.from(commitmentDigest(`${presignedBackupDomain(binding.protocol)}/trigger-key-possession`,
    { binding, recoveryId }), 'hex');
}

async function decryptBackup(input: {
  envelope: PresignedOfflineBackup; offlineSecret: Uint8Array; expectedBinding: PresignedBackupBinding;
}): Promise<RestoredPresignedBackup> {
  requireOfflineSecret(input.offlineSecret);
  const envelope = validateEnvelope(input.envelope);
  sameCanonical(envelope.binding, validateBinding(input.expectedBinding), 'recovery import binding');
  const { ciphertext, ...header } = envelope;
  const key = await offlineKey(input.offlineSecret, decode(envelope.salt, 32, 'recovery salt'), envelope.protocol);
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM',
      iv: decode(envelope.iv, 12, 'recovery IV'), additionalData: encoder.encode(canonicalJson(header)), tagLength: 128,
    }, key, decode(ciphertext, undefined, 'recovery ciphertext')));
  } catch { throw new Error('presigned-v2: recovery file authentication failed'); }
  let restored: RestoredPresignedBackup | undefined;
  try {
    assert(plaintext.length <= MAX_PRESIGNED_BACKUP_PLAINTEXT_BYTES, 'recovery payload is too large');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); }
    catch { throw new Error('presigned-v2: recovered payload is not valid JSON'); }
    boundedJson(parsed);
    exactKeys(parsed, ['version', 'protocol', 'participantId', 'participantSecret', 'publicKit'], 'recovery payload');
    restored = parsed as RestoredPresignedBackup;
    validatePresignedProtocol(restored.version, restored.protocol);
    assert(restored.protocol === envelope.protocol, 'recovered envelope protocol differs');
    restored.publicKit = validatePresignedPublicKit(restored.publicKit);
    assert(restored.protocol === restored.publicKit.protocol && restored.version === restored.publicKit.version,
      'recovered payload and kit protocols differ');
    sameCanonical(presignedBackupBinding(restored.publicKit, restored.participantId), envelope.binding, 'recovered kit binding');
    assertParticipantIdentity(restored.publicKit, restored.participantId, restored.participantSecret);
    return restored;
  } catch (error) {
    if (restored) restored.participantSecret = '';
    throw error;
  } finally { plaintext.fill(0); }
}

function assertParticipantIdentity(kit: PresignedPublicKit, id: ParticipantId, secret: string, clear = true) {
  const derived = derivePresignedParticipantKeys(secret, id, kit.graph.roster.vaultId, kit.protocol);
  try {
    const expected = kit.graph.roster.participants.find(entry => entry.id === id);
    assert(expected, 'recovery participant is absent from the roster');
    sameCanonical(derived.publicIdentity, expected, 'recovered participant identity');
    return derived;
  } catch (error) { clearPresignedParticipantKeys(derived.keys); throw error; }
  finally { if (clear) clearPresignedParticipantKeys(derived.keys); }
}

function validateBinding(input: PresignedBackupBinding): PresignedBackupBinding {
  exactKeys(input, ['protocol', 'network', 'genesisHash', 'vaultId', 'participantId', 'epochId', 'rosterDigest', 'graphDigest', 'fundingTxid'], 'recovery binding');
  assert(isPresignedProtocol(input.protocol), 'wrong recovery binding protocol');
  assert(input.genesisHash === genesisHash(input.network), 'wrong recovery genesis hash');
  identifier(input.vaultId, 'recovery vault id');
  identifier(input.epochId, 'recovery funding epoch');
  participantId(input.participantId);
  for (const name of ['rosterDigest', 'graphDigest', 'fundingTxid'] as const) hexBytes(input[name], 32, `recovery ${name}`);
  return { ...input };
}

function validateEnvelope(input: unknown): PresignedOfflineBackup {
  exactKeys(input, ['version', 'protocol', 'format', 'cipher', 'kdf', 'binding', 'salt', 'iv', 'ciphertext'], 'encrypted recovery envelope');
  const envelope = input as PresignedOfflineBackup;
  assert(((envelope.version === 1 && envelope.protocol === PRESIGNED_PROTOCOL && envelope.format === FORMAT) ||
    (envelope.version === 3 && envelope.protocol === PRESIGNED_PROTOCOL_V3 && envelope.format === 'btc-vault-offline-recovery-v3')) &&
    envelope.cipher === 'AES-256-GCM' && envelope.kdf === 'HKDF-SHA256', 'unsupported encrypted recovery format');
  const binding = validateBinding(envelope.binding);
  assert(binding.protocol === envelope.protocol, 'encrypted recovery binding protocol differs');
  decode(envelope.salt, 32, 'recovery salt');
  decode(envelope.iv, 12, 'recovery IV');
  assert(typeof envelope.ciphertext === 'string' && envelope.ciphertext.length <= Math.ceil((MAX_PRESIGNED_BACKUP_PLAINTEXT_BYTES + 16) * 4 / 3), 'recovery ciphertext is too large');
  const ciphertext = decode(envelope.ciphertext, undefined, 'recovery ciphertext');
  assert(ciphertext.length >= 128 && ciphertext.length <= MAX_PRESIGNED_BACKUP_PLAINTEXT_BYTES + 16, 'recovery ciphertext size is invalid');
  return { ...envelope, binding };
}

function requireOfflineSecret(secret: Uint8Array): void {
  assert(secret instanceof Uint8Array && secret.length === 32, 'offline recovery secret must be 32 random bytes');
}

async function offlineKey(secret: Uint8Array, salt: Uint8Array, protocol: PresignedProtocol) {
  const copy = Uint8Array.from(secret);
  try {
    const material = await crypto.subtle.importKey('raw', copy, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: Uint8Array.from(salt),
      info: encoder.encode(presignedBackupDomain(protocol)) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { copy.fill(0); }
}

// The browser Buffer polyfill supports base64, but not Node's base64url
// encoding alias. Keep the exact canonical bytes identical in both runtimes.
function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decode(value: string, size: number | undefined, label: string): Uint8Array<ArrayBuffer> {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value), `invalid ${label}`);
  if (size !== undefined) assert(value.length === Math.ceil(size * 4 / 3), `invalid ${label} size`);
  const bytes = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='), 'base64');
  assert(encode(bytes) === value && (size === undefined || bytes.length === size), `invalid ${label} encoding`);
  return Uint8Array.from(bytes);
}

/** Bound untrusted JSON before recursive canonicalization or graph validation. */
function boundedJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  let stringUnits = 0;
  while (pending.length) {
    const item = pending.pop()!;
    assert(++nodes <= 20_000 && item.depth <= 32, 'recovery JSON is too complex');
    if (typeof item.value === 'string') {
      stringUnits += item.value.length;
      assert(stringUnits <= MAX_PRESIGNED_BACKUP_PLAINTEXT_BYTES, 'recovery JSON is too large');
    } else if (item.value && typeof item.value === 'object') {
      assert(Array.isArray(item.value) || Object.getPrototypeOf(item.value) === Object.prototype, 'recovery JSON contains a non-JSON object');
      const values = Object.values(item.value);
      assert(values.length <= 20_000, 'recovery JSON collection is too large');
      for (const child of values) pending.push({ value: child, depth: item.depth + 1 });
    } else assert(item.value === null || typeof item.value === 'boolean' ||
      (typeof item.value === 'number' && Number.isSafeInteger(item.value)), 'recovery JSON contains an unsupported value');
  }
}
