import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sha256Hex } from './crypto.js';
import { assertProtectedRegularFile } from './operator-environment.js';

export interface LiveSigbashProofReceipt {
  version: 1;
  kind: 'live-sigbash-mainnet-signing-proof';
  network: 'mainnet';
  createdAt: string;
  round: string;
  leaverId: string;
  keyId: string;
  placeholderOutpoint: true;
  requestPsbtBase64: string;
  signedArtifacts: LiveSigbashProofArtifacts;
  authorization: Record<string, unknown>;
  requestPsbtDigest: string;
  signedArtifactDigest: string;
  authorizationDigest: string;
  finalTxid: string;
  checkNames: string[];
  proofDigest: string;
}

export interface LiveSigbashProofArtifacts {
  success: true;
  txHex: string | null;
  signedPsbtBase64: string | null;
  pathId: string | null;
  policyRootHex: string | null;
  satisfiedClause: string | null;
  error: null;
}

export function createLiveSigbashProofReceipt<TAuthorization extends { finalTxid?: unknown }>(input: {
  createdAt: string;
  round: string;
  leaverId: string;
  keyId: string;
  placeholderOutpoint: boolean;
  psbtBase64: string;
  signedArtifacts: unknown;
  authorization: TAuthorization;
  checks: Array<{ name: string; ok: boolean }>;
}): LiveSigbashProofReceipt {
  if (!input.placeholderOutpoint) {
    throw new Error('predeployment proof receipt must use the deliberately unfunded placeholder outpoint');
  }
  if (!input.checks.length || input.checks.some((item) => !item.ok)) {
    throw new Error('predeployment proof receipt requires every proof check to pass');
  }
  const signedArtifacts = validateProofArtifacts(input.signedArtifacts);
  const finalTxid = String(input.authorization.finalTxid || '');
  const body = canonicalReceiptBody({
    version: 1,
    kind: 'live-sigbash-mainnet-signing-proof',
    network: 'mainnet',
    createdAt: input.createdAt,
    round: input.round,
    leaverId: input.leaverId,
    keyId: input.keyId,
    placeholderOutpoint: true,
    requestPsbtBase64: input.psbtBase64,
    signedArtifacts,
    authorization: input.authorization as Record<string, unknown>,
    requestPsbtDigest: sha256Hex(input.psbtBase64),
    signedArtifactDigest: sha256Hex(JSON.stringify(signedArtifacts)),
    authorizationDigest: sha256Hex(JSON.stringify(input.authorization)),
    finalTxid,
    checkNames: input.checks.map((item) => item.name),
  });
  return { ...body, proofDigest: sha256Hex(JSON.stringify(body)) };
}

export function validateLiveSigbashProofReceipt(input: unknown): LiveSigbashProofReceipt {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('live Sigbash proof receipt is not an object');
  }
  const row = input as Record<string, unknown>;
  const allowedKeys = [
    'version', 'kind', 'network', 'createdAt', 'round', 'leaverId', 'keyId',
    'placeholderOutpoint', 'requestPsbtBase64', 'signedArtifacts', 'authorization',
    'requestPsbtDigest', 'signedArtifactDigest',
    'authorizationDigest', 'finalTxid', 'checkNames', 'proofDigest',
  ];
  if (Object.keys(row).sort().join(',') !== [...allowedKeys].sort().join(',')) {
    throw new Error('live Sigbash proof receipt has unexpected or missing fields');
  }
  const checkNames = Array.isArray(row.checkNames) && row.checkNames.every((item) =>
    typeof item === 'string' && item.length >= 3 && item.length <= 300)
    ? row.checkNames as string[]
    : null;
  if (row.version !== 1 || row.kind !== 'live-sigbash-mainnet-signing-proof' ||
      row.network !== 'mainnet' || row.placeholderOutpoint !== true || !checkNames?.length ||
      typeof row.createdAt !== 'string' || !validIsoTimestamp(row.createdAt) ||
      typeof row.round !== 'string' || !['alicebob', 'alicecarol', 'bobcarol'].includes(row.round) ||
      typeof row.leaverId !== 'string' || !['alice', 'bob', 'carol'].includes(row.leaverId) ||
      typeof row.keyId !== 'string' || row.keyId.length < 1 || row.keyId.length > 256 ||
      typeof row.requestPsbtBase64 !== 'string' || row.requestPsbtBase64.length < 10 ||
      row.requestPsbtBase64.length > 400_000 || !isPlainObject(row.signedArtifacts) ||
      !isPlainObject(row.authorization)) {
    throw new Error('live Sigbash proof receipt has an invalid identity or timestamp binding');
  }
  const roundParticipants: Record<string, string[]> = {
    alicebob: ['alice', 'bob'],
    alicecarol: ['alice', 'carol'],
    bobcarol: ['bob', 'carol'],
  };
  if (!roundParticipants[row.round]!.includes(row.leaverId) ||
      !isPlainObject(row.signedArtifacts) ||
      !isPlainObject(row.authorization.consensus) ||
      !Array.isArray(row.authorization.consensus.checks) ||
      row.authorization.consensus.checks.length === 0 ||
      row.authorization.consensus.txid !== row.finalTxid) {
    throw new Error('live Sigbash proof receipt lacks a successful signed consensus artifact');
  }
  const signedArtifacts = validateProofArtifacts(row.signedArtifacts);
  for (const name of [
    'requestPsbtDigest', 'signedArtifactDigest', 'authorizationDigest', 'finalTxid', 'proofDigest',
  ]) {
    if (typeof row[name] !== 'string' || !/^[0-9a-f]{64}$/u.test(row[name])) {
      throw new Error(`live Sigbash proof receipt ${name} is invalid`);
    }
  }
  if (sha256Hex(row.requestPsbtBase64) !== row.requestPsbtDigest ||
      sha256Hex(JSON.stringify(signedArtifacts)) !== row.signedArtifactDigest ||
      sha256Hex(JSON.stringify(row.authorization)) !== row.authorizationDigest ||
      row.authorization.finalTxid !== row.finalTxid) {
    throw new Error('live Sigbash proof receipt evidence does not match its committed digests');
  }
  const body = canonicalReceiptBody({
    version: 1,
    kind: 'live-sigbash-mainnet-signing-proof',
    network: 'mainnet',
    createdAt: row.createdAt,
    round: row.round,
    leaverId: row.leaverId,
    keyId: row.keyId,
    placeholderOutpoint: true,
    requestPsbtBase64: row.requestPsbtBase64,
    signedArtifacts,
    authorization: row.authorization,
    requestPsbtDigest: row.requestPsbtDigest as string,
    signedArtifactDigest: row.signedArtifactDigest as string,
    authorizationDigest: row.authorizationDigest as string,
    finalTxid: row.finalTxid as string,
    checkNames,
  });
  if (sha256Hex(JSON.stringify(body)) !== row.proofDigest) {
    throw new Error('live Sigbash proof receipt digest does not match its canonical contents');
  }
  const requiredChecks = [
    'Sigbash verifyPSBT accepts the valid solo PSBT',
    'Sigbash live signPSBT returns a transaction or signed PSBT artifact',
    'live Sigbash artifact is the exact consensus-valid policy-leaf transaction',
  ];
  if (requiredChecks.some((prefix) => !checkNames.some((name) => name.startsWith(prefix))) ||
      checkNames.filter((name) => name.includes('explicitly rejects tampered')).length < 3) {
    throw new Error('live Sigbash proof receipt does not cover the required positive and hostile cases');
  }
  return { ...body, proofDigest: row.proofDigest as string };
}

export function readProtectedLiveSigbashProofReceipt(
  rawPath: string,
  expectedDigest: string,
): LiveSigbashProofReceipt {
  const receiptPath = resolve(rawPath);
  if (!existsSync(receiptPath)) throw new Error(`live Sigbash proof receipt does not exist: ${receiptPath}`);
  assertProtectedRegularFile(receiptPath, 'live Sigbash proof receipt');
  const parent = lstatSync(dirname(receiptPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error('live Sigbash proof receipt parent must be a private real directory');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    throw new Error('live Sigbash proof receipt is not valid JSON');
  }
  const receipt = validateLiveSigbashProofReceipt(parsed);
  if (!/^[0-9a-f]{64}$/u.test(expectedDigest) || receipt.proofDigest !== expectedDigest) {
    throw new Error('live Sigbash proof receipt does not match the reviewed proof digest');
  }
  return receipt;
}

function canonicalReceiptBody(input: Omit<LiveSigbashProofReceipt, 'proofDigest'>): Omit<LiveSigbashProofReceipt, 'proofDigest'> {
  return {
    version: 1,
    kind: 'live-sigbash-mainnet-signing-proof',
    network: 'mainnet',
    createdAt: input.createdAt,
    round: input.round,
    leaverId: input.leaverId,
    keyId: input.keyId,
    placeholderOutpoint: true,
    requestPsbtBase64: input.requestPsbtBase64,
    signedArtifacts: input.signedArtifacts,
    authorization: input.authorization,
    requestPsbtDigest: input.requestPsbtDigest,
    signedArtifactDigest: input.signedArtifactDigest,
    authorizationDigest: input.authorizationDigest,
    finalTxid: input.finalTxid,
    checkNames: [...input.checkNames],
  };
}

function validIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateProofArtifacts(input: unknown): LiveSigbashProofArtifacts {
  if (!isPlainObject(input)) {
    throw new Error('live Sigbash proof receipt signed artifacts are not an object');
  }
  const expectedKeys = [
    'success', 'txHex', 'signedPsbtBase64', 'pathId', 'policyRootHex',
    'satisfiedClause', 'error',
  ];
  if (Object.keys(input).sort().join(',') !== expectedKeys.sort().join(',')) {
    throw new Error('live Sigbash proof receipt signed artifacts have unexpected or missing fields');
  }
  const optionalText = (value: unknown, maxLength: number): value is string | null =>
    value === null || (typeof value === 'string' && value.length > 0 && value.length <= maxLength);
  if (input.success !== true || input.error !== null ||
      !optionalText(input.txHex, 800_000) ||
      !optionalText(input.signedPsbtBase64, 600_000) ||
      !optionalText(input.pathId, 256) ||
      !optionalText(input.policyRootHex, 64) ||
      !optionalText(input.satisfiedClause, 1_000) ||
      (input.txHex === null && input.signedPsbtBase64 === null) ||
      (typeof input.txHex === 'string' && !/^(?:[0-9a-f]{2})+$/u.test(input.txHex)) ||
      (typeof input.signedPsbtBase64 === 'string' &&
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.signedPsbtBase64)) ||
      (typeof input.policyRootHex === 'string' && !/^[0-9a-f]{64}$/u.test(input.policyRootHex))) {
    throw new Error('live Sigbash proof receipt signed artifacts are invalid');
  }
  return {
    success: true,
    txHex: input.txHex,
    signedPsbtBase64: input.signedPsbtBase64,
    pathId: input.pathId,
    policyRootHex: input.policyRootHex,
    satisfiedClause: input.satisfiedClause,
    error: null,
  };
}
