import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sha256Hex } from './crypto.js';
import { assertProtectedRegularFile } from './operator-environment.js';

export interface FundingReleaseCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface FundingReleaseReport {
  version: 1;
  kind: 'mainnet-funding-release';
  network: 'mainnet';
  createdAt: string;
  automatedPreflightPassed: true;
  fundingAllowed: false;
  manualReviewAcknowledged: true;
  vaultId: string;
  fundingFinalization: {
    status: 'approved';
    finalizationDigest: string;
    finalTxid: string;
  };
  liveSigbashProofDigest: string;
  checks: FundingReleaseCheck[];
  manualGates: string[];
  reportDigest: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

export function createFundingReleaseReport(input: {
  createdAt: string;
  vaultId: string;
  finalizationDigest: string;
  finalTxid: string;
  liveSigbashProofDigest: string;
  checks: FundingReleaseCheck[];
  manualGates: string[];
  manualReviewAcknowledged: boolean;
}): FundingReleaseReport {
  if (!input.manualReviewAcknowledged) {
    throw new Error('funding release report requires explicit acknowledgement of every manual gate');
  }
  if (!input.checks.length || input.checks.some((item) => !item.ok)) {
    throw new Error('funding release report requires every automated preflight check to pass');
  }
  const body = canonicalBody({
    version: 1,
    kind: 'mainnet-funding-release',
    network: 'mainnet',
    createdAt: input.createdAt,
    automatedPreflightPassed: true,
    fundingAllowed: false,
    manualReviewAcknowledged: true,
    vaultId: input.vaultId,
    fundingFinalization: {
      status: 'approved',
      finalizationDigest: input.finalizationDigest,
      finalTxid: input.finalTxid,
    },
    liveSigbashProofDigest: input.liveSigbashProofDigest,
    checks: input.checks,
    manualGates: input.manualGates,
  });
  return validateFundingReleaseReport({
    ...body,
    reportDigest: sha256Hex(JSON.stringify(body)),
  });
}

export function validateFundingReleaseReport(input: unknown): FundingReleaseReport {
  if (!isPlainObject(input)) throw new Error('funding release report is not an object');
  const allowedKeys = [
    'version', 'kind', 'network', 'createdAt', 'automatedPreflightPassed',
    'fundingAllowed', 'manualReviewAcknowledged', 'vaultId', 'fundingFinalization',
    'liveSigbashProofDigest', 'checks', 'manualGates', 'reportDigest',
  ];
  if (Object.keys(input).sort().join(',') !== [...allowedKeys].sort().join(',')) {
    throw new Error('funding release report has unexpected or missing fields');
  }
  if (input.version !== 1 || input.kind !== 'mainnet-funding-release' ||
      input.network !== 'mainnet' || input.automatedPreflightPassed !== true ||
      input.fundingAllowed !== false || input.manualReviewAcknowledged !== true ||
      typeof input.createdAt !== 'string' || !validIsoTimestamp(input.createdAt) ||
      typeof input.vaultId !== 'string' || !UUID.test(input.vaultId) ||
      typeof input.liveSigbashProofDigest !== 'string' || !DIGEST.test(input.liveSigbashProofDigest) ||
      typeof input.reportDigest !== 'string' || !DIGEST.test(input.reportDigest) ||
      !isPlainObject(input.fundingFinalization)) {
    throw new Error('funding release report has an invalid release identity');
  }
  const finalization = input.fundingFinalization;
  if (finalization.status !== 'approved' ||
      typeof finalization.finalizationDigest !== 'string' || !DIGEST.test(finalization.finalizationDigest) ||
      typeof finalization.finalTxid !== 'string' || !DIGEST.test(finalization.finalTxid)) {
    throw new Error('funding release report is not bound to one unanimously approved final transaction');
  }
  const checks = Array.isArray(input.checks) && input.checks.length > 0 && input.checks.every(validCheck)
    ? input.checks as FundingReleaseCheck[]
    : null;
  const manualGates = Array.isArray(input.manualGates) && input.manualGates.length > 0 &&
    input.manualGates.every((item) => typeof item === 'string' && item.length >= 10 && item.length <= 500)
    ? input.manualGates as string[]
    : null;
  if (!checks || checks.some((item) => !item.ok) || !manualGates) {
    throw new Error('funding release report does not contain passing automated and acknowledged manual gates');
  }
  const requiredCheckPrefixes = [
    'protected live Sigbash mainnet proof receipt',
    'reviewed Node runtime is active',
    'production WebAuthn origin and RP ID are explicit HTTPS values',
    'at least one independent HTTPS chain-observation origin is explicit',
    'tiny-mainnet amount is explicit and within the private-beta cap',
    'mainnet recovery delay is explicit and positive',
    'confirmation depth for funding and transitions is explicit',
    'three-wallet funding fee is explicit and cannot consume one deposit',
    'Sigbash service origin is an explicit credential-free HTTPS origin',
    'Sigbash WASM matches the pinned SHA-384',
    'Sigbash Go loader matches the pinned SHA-384',
    'production database uses a non-local TLS endpoint',
    'protected production database restore receipt is present, fresh, and bound to this endpoint',
    'production database is PostgreSQL 16 or newer',
    'all required database migrations are applied',
    'exactly one three-person private-beta vault exists',
    'all three participants have two completed PRF passkey envelopes',
    'the immutable roster has nine live Sigbash keys and three confirmations',
    'all nine server-verified Sigbash readiness proofs are recorded',
    'the pre-funding database contains no current Bitcoin coin',
    'funding ceremony is either untouched or unanimously approved and still unbroadcast',
    'configured Bitcoin backend identifies as mainnet',
  ];
  if (requiredCheckPrefixes.some((prefix) => !checks.some((item) => item.name.startsWith(prefix)))) {
    throw new Error('funding release report is missing a mandatory automated gate');
  }
  const requiredManualGatePrefixes = [
    'Independently review the protected predeployment live-Sigbash receipt',
    'Sigbash must explicitly enable mainnet for all three independent participant organization hashes',
    'Each friend must complete setup and recovery with two real, distinct PRF-capable passkeys',
    'Each friend must independently review the unanimous roster and tiny-mainnet economics',
    'The deployed private service must use the independently reviewed immutable image digest',
    'Before initial wallet signing, all three friends must review the same funding PSBT fingerprint',
    'Three independent real wallets must sign only their own P2WPKH or P2TR funding inputs',
    'The private Bitcoin Core path must complete rejection, retry, duplicate, interruption, mempool, confirmation, and reorganization drills',
    'The operator has documented that this report does not authorize funding',
  ];
  if (requiredManualGatePrefixes.some((prefix) => !manualGates.some((item) => item.startsWith(prefix)))) {
    throw new Error('funding release report is missing a mandatory acknowledged manual gate');
  }
  const body = canonicalBody({
    version: 1,
    kind: 'mainnet-funding-release',
    network: 'mainnet',
    createdAt: input.createdAt,
    automatedPreflightPassed: true,
    fundingAllowed: false,
    manualReviewAcknowledged: true,
    vaultId: input.vaultId,
    fundingFinalization: {
      status: 'approved',
      finalizationDigest: finalization.finalizationDigest as string,
      finalTxid: finalization.finalTxid as string,
    },
    liveSigbashProofDigest: input.liveSigbashProofDigest,
    checks,
    manualGates,
  });
  if (sha256Hex(JSON.stringify(body)) !== input.reportDigest) {
    throw new Error('funding release report digest does not match its canonical contents');
  }
  return { ...body, reportDigest: input.reportDigest };
}

export function readProtectedFundingReleaseReport(
  rawPath: string,
  expected: {
    reportDigest: string;
    vaultId: string;
    finalizationDigest: string;
    liveSigbashProofDigest: string;
    now?: number;
    maxAgeMs?: number;
  },
): FundingReleaseReport {
  const reportPath = resolve(rawPath);
  if (!existsSync(reportPath)) throw new Error(`funding release report does not exist: ${reportPath}`);
  assertProtectedRegularFile(reportPath, 'funding release report');
  const parent = lstatSync(dirname(reportPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error('funding release report parent must be a private real directory');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    throw new Error('funding release report is not valid JSON');
  }
  const report = validateFundingReleaseReport(parsed);
  if (!DIGEST.test(expected.reportDigest) || report.reportDigest !== expected.reportDigest) {
    throw new Error('funding release report does not match the reviewed report digest');
  }
  if (report.vaultId !== expected.vaultId ||
      report.fundingFinalization.finalizationDigest !== expected.finalizationDigest ||
      report.liveSigbashProofDigest !== expected.liveSigbashProofDigest) {
    throw new Error('funding release report is bound to a different vault, finalization, or live proof');
  }
  const now = expected.now ?? Date.now();
  const age = now - Date.parse(report.createdAt);
  const maxAge = expected.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge <= 0) {
    throw new Error('funding release report freshness policy is invalid');
  }
  if (!Number.isFinite(age) || age < 0 || age > maxAge) {
    throw new Error('funding release report is stale or dated in the future; generate and review a fresh report');
  }
  return report;
}

function canonicalBody(input: Omit<FundingReleaseReport, 'reportDigest'>): Omit<FundingReleaseReport, 'reportDigest'> {
  return {
    version: 1,
    kind: 'mainnet-funding-release',
    network: 'mainnet',
    createdAt: input.createdAt,
    automatedPreflightPassed: true,
    fundingAllowed: false,
    manualReviewAcknowledged: true,
    vaultId: input.vaultId,
    fundingFinalization: {
      status: 'approved',
      finalizationDigest: input.fundingFinalization.finalizationDigest,
      finalTxid: input.fundingFinalization.finalTxid,
    },
    liveSigbashProofDigest: input.liveSigbashProofDigest,
    checks: input.checks.map((item) => ({
      name: item.name,
      ok: item.ok,
      ...(item.detail ? { detail: item.detail } : {}),
    })),
    manualGates: [...input.manualGates],
  };
}

function validCheck(input: unknown): boolean {
  if (!isPlainObject(input)) return false;
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'name,ok' && keys !== 'detail,name,ok') return false;
  return typeof input.name === 'string' && input.name.length >= 3 && input.name.length <= 300 &&
    input.ok === true && (input.detail === undefined ||
      (typeof input.detail === 'string' && input.detail.length <= 1000));
}

function validIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
