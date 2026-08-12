/**
 * Offline contract and fail-closed checks for the pinned @sigbash/sdk 0.7.1.
 *
 * Everything here runs without network access or WASM loading. Credential-file
 * checks use a fresh temporary directory and delete their throwaway values;
 * the remaining checks use synthetic inputs. The type imports are the SDK's
 * real published 0.7.1 declarations, so a future SDK bump that changes the
 * verify/sign result shapes fails `tsc --noEmit` here instead of failing open
 * at signing time.
 */
import type {
  SigbashClientOptions,
  SignPSBTResult,
  VerifyPSBTResult,
  WasmLoaderOptions,
} from '@sigbash/sdk';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSigbashCredentialFile } from './sigbash-credentials.js';
import {
  normalizeSigbashSigningResult,
  resolveSigbashCredentials,
  sigbashVerificationExplicitlyRejected,
  sigbashVerificationPassed,
  validateWasmSha384,
  type SigbashVerifyResult,
} from './sigbash.js';

export interface ContractCheck {
  name: string;
  ok: boolean;
  details?: unknown;
}

function check(name: string, ok: unknown, details?: unknown): ContractCheck {
  return { name, ok: Boolean(ok), ...(details === undefined ? {} : { details }) };
}

function thrownMessage(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Compile-time proof (via `satisfies`) that the option shapes this repo
// passes to `new SigbashClient(...)` and `loadWasm(...)` match the real
// 0.7.1 types. The values are inert placeholders — never used to connect.
const CONTRACT_CLIENT_OPTIONS = {
  serverUrl: 'https://sigbash.invalid',
  apiKey: 'contract-placeholder-api-key',
  userKey: 'contract-placeholder-user-key',
  userSecretKey: 'contract-placeholder-user-secret',
} satisfies SigbashClientOptions;

const CONTRACT_WASM_OPTIONS = {
  wasmUrl: 'https://sigbash.invalid/sigbash.wasm',
  expectedHash: 'ab'.repeat(48),
} satisfies WasmLoaderOptions;

export async function runSigbashOfflineChecks(): Promise<{
  passed: boolean;
  checks: ContractCheck[];
}> {
  const sdk = await import('@sigbash/sdk');
  const checks = [
    ...sdkContractChecks(sdk),
    ...verificationGateChecks(),
    ...signingNormalizationChecks(),
    ...credentialChecks(),
    ...(await credentialFileChecks()),
    ...wasmHashChecks(),
  ];
  return { passed: checks.every((item) => item.ok), checks };
}

async function credentialFileChecks(): Promise<ContractCheck[]> {
  const directory = mkdtempSync(join(tmpdir(), 'btc-vault-sigbash-credentials-'));
  const credentialFile = join(directory, '.env');
  try {
    const created = await createSigbashCredentialFile(credentialFile);
    const contentBefore = readFileSync(credentialFile, 'utf8');
    const values = Object.fromEntries(contentBefore.trim().split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const secrets = [
      values.SIGBASH_API_KEY,
      values.SIGBASH_USER_KEY,
      values.SIGBASH_SECRET_KEY,
      values.VAULT_DEMO_SEED,
    ];
    let overwriteRejected = false;
    try {
      await createSigbashCredentialFile(credentialFile);
    } catch {
      overwriteRejected = true;
    }
    const contentAfter = readFileSync(credentialFile, 'utf8');
    let exampleRejected = false;
    try {
      await createSigbashCredentialFile(join(directory, '.env.example'));
    } catch {
      exampleRejected = true;
    }
    return [
      check(
        'credential bootstrap exclusively creates a triplet and vault seed as distinct 256-bit values with mode 0600',
        (statSync(credentialFile).mode & 0o777) === 0o600 &&
          secrets.every((value) => /^[0-9a-f]{64}$/u.test(value ?? '')) &&
          new Set(secrets).size === 4,
      ),
      check(
        'credential bootstrap returns only the non-secret organization hash',
        /^[0-9a-f]{64}$/u.test(created.apikeyHash) &&
          secrets.every((value) => value !== undefined && !JSON.stringify(created).includes(value)),
      ),
      check(
        'credential bootstrap refuses overwrite and the tracked example file',
        overwriteRejected && contentAfter === contentBefore && exampleRejected,
      ),
    ];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sdkContractChecks(sdk: typeof import('@sigbash/sdk')): ContractCheck[] {
  return [
    check('SDK_VERSION is exactly 0.7.1', sdk.SDK_VERSION === '0.7.1', {
      actual: sdk.SDK_VERSION ?? null,
    }),
    check('loadWasm is exported as a function', typeof sdk.loadWasm === 'function'),
    check('SigbashClient is exported as a constructor', typeof sdk.SigbashClient === 'function'),
    check(
      'conditionConfigToPoetPolicy is exported as a function',
      typeof sdk.conditionConfigToPoetPolicy === 'function',
    ),
    check('client and loadWasm option shapes typecheck against the real 0.7.1 types', true, {
      clientOptionKeys: Object.keys(CONTRACT_CLIENT_OPTIONS),
      wasmOptionKeys: Object.keys(CONTRACT_WASM_OPTIONS),
    }),
  ];
}

function verificationGateChecks(): ContractCheck[] {
  // Typed against the SDK's real VerifyPSBTResult so a shape change breaks
  // the build here.
  const passing: VerifyPSBTResult = {
    passed: true,
    pathId: 'deadbeef',
    satisfiedClause: 'solo withdrawal clause',
    nullifierStatus: [],
  };
  const failing: VerifyPSBTResult = {
    passed: false,
    pathId: '',
    satisfiedClause: '',
    nullifierStatus: [],
    error: 'policy violation',
  };
  const passedWithError: VerifyPSBTResult = { ...passing, error: 'server_error' };
  const absentBoolean: SigbashVerifyResult = {};
  const legacySuccessOnly: SigbashVerifyResult = { success: true };
  return [
    check(
      'verification passes on passed === true with no error',
      sigbashVerificationPassed(passing) === true,
    ),
    check(
      'verification fails closed when the passed boolean is absent',
      sigbashVerificationPassed(absentBoolean) === false,
    ),
    check('verification fails when passed === false', sigbashVerificationPassed(failing) === false),
    check(
      'hostile rejection accepts only an explicit passed false verdict',
      sigbashVerificationExplicitlyRejected(failing) === true &&
        sigbashVerificationExplicitlyRejected(passing) === false &&
        sigbashVerificationExplicitlyRejected(absentBoolean) === false &&
        sigbashVerificationExplicitlyRejected(null) === false,
    ),
    check(
      'verification fails when passed === true but an error is present',
      sigbashVerificationPassed(passedWithError) === false,
    ),
    check(
      'verification fails closed on legacy success-only results',
      sigbashVerificationPassed(legacySuccessOnly) === false,
    ),
    check(
      'verification fails closed on null and undefined results',
      sigbashVerificationPassed(null) === false && sigbashVerificationPassed(undefined) === false,
    ),
  ];
}

function signingNormalizationChecks(): ContractCheck[] {
  const signedOk: SignPSBTResult = {
    success: true,
    txHex: '0200',
    signedPSBT: 'cHNidP8BAA==',
    pathId: 'deadbeef',
    satisfiedClause: 'solo withdrawal clause',
    policyRootHex: 'ab'.repeat(32),
  };
  const signedFailed: SignPSBTResult = {
    success: false,
    error: 'server_error: Signing service error',
  };
  const successOk = normalizeSigbashSigningResult(signedOk);
  const successFalse = normalizeSigbashSigningResult(signedFailed);
  const successTrueWithError = normalizeSigbashSigningResult({ success: true, error: 'boom' });
  const successAbsent = normalizeSigbashSigningResult({});
  return [
    check(
      'signing normalization succeeds on success === true with no error and extracts artifacts',
      successOk.success === true &&
        successOk.txHex === signedOk.txHex &&
        successOk.signedPsbtBase64 === signedOk.signedPSBT,
      successOk,
    ),
    check(
      'signing normalization fails when success === false and surfaces the error',
      successFalse.success === false && successFalse.error === signedFailed.error,
    ),
    check(
      'signing normalization fails when success === true but an error is present',
      successTrueWithError.success === false,
    ),
    check(
      'signing normalization fails closed when the success boolean is absent',
      successAbsent.success === false && successAbsent.txHex === null,
    ),
    check(
      'signing normalization fails closed on null and undefined results',
      normalizeSigbashSigningResult(null).success === false &&
        normalizeSigbashSigningResult(undefined).success === false,
    ),
  ];
}

function credentialChecks(): ContractCheck[] {
  // Distinctive sentinel values so leakage into error/warning text is
  // detectable. These never touch process.env.
  const sentinels = {
    sharedApi: 'shared-api-sentinel-1',
    sharedUser: 'shared-user-sentinel-2',
    sharedSecret: 'shared-secret-sentinel-3',
    scopedApi: 'scoped-api-sentinel-4',
    scopedUser: 'scoped-user-sentinel-5',
    scopedSecret: 'scoped-secret-sentinel-6',
  };
  const sharedEnv = {
    SIGBASH_API_KEY: sentinels.sharedApi,
    SIGBASH_USER_KEY: sentinels.sharedUser,
    SIGBASH_SECRET_KEY: sentinels.sharedSecret,
  };
  const scopedEnv = {
    ...sharedEnv,
    SIGBASH_API_KEY_ALICE: sentinels.scopedApi,
    SIGBASH_USER_KEY_ALICE: sentinels.scopedUser,
    SIGBASH_SECRET_KEY_ALICE: sentinels.scopedSecret,
  };
  const leaked = (text: string | null) =>
    text !== null && Object.values(sentinels).some((value) => text.includes(value));

  const scopedWarnings: string[] = [];
  const scoped = resolveSigbashCredentials(scopedEnv, 'alice', (message) =>
    scopedWarnings.push(message),
  );

  const partialEnv = { ...sharedEnv, SIGBASH_API_KEY_ALICE: sentinels.scopedApi };
  const partialError = thrownMessage(() => resolveSigbashCredentials(partialEnv, 'alice', () => {}));

  const sharedWarnings: string[] = [];
  const sharedFallback = resolveSigbashCredentials(sharedEnv, 'alice', (message) =>
    sharedWarnings.push(message),
  );

  const noParticipantWarnings: string[] = [];
  const noParticipant = resolveSigbashCredentials(sharedEnv, undefined, (message) =>
    noParticipantWarnings.push(message),
  );

  const missingSharedError = thrownMessage(() =>
    resolveSigbashCredentials(
      { SIGBASH_API_KEY: sentinels.sharedApi, SIGBASH_USER_KEY: sentinels.sharedUser },
      'alice',
      () => {},
    ),
  );

  return [
    check(
      'a complete suffixed triplet is used atomically, never mixed with shared values',
      scoped.source === 'participant' &&
        scoped.apiKey === sentinels.scopedApi &&
        scoped.userKey === sentinels.scopedUser &&
        scoped.userSecretKey === sentinels.scopedSecret &&
        scopedWarnings.length === 0,
    ),
    check(
      'a partial suffixed triplet is rejected even when shared variables could fill the gaps',
      partialError !== null &&
        partialError.includes('SIGBASH_USER_KEY_ALICE') &&
        partialError.includes('SIGBASH_SECRET_KEY_ALICE'),
      { error: partialError },
    ),
    check('the partial-triplet error never contains credential values', !leaked(partialError)),
    check(
      'with no suffixed variables the shared triplet is used and a warning is emitted',
      sharedFallback.source === 'shared' &&
        sharedFallback.apiKey === sentinels.sharedApi &&
        sharedFallback.userKey === sentinels.sharedUser &&
        sharedFallback.userSecretKey === sentinels.sharedSecret &&
        sharedWarnings.length === 1,
    ),
    check(
      'the shared-fallback warning names variables but never contains credential values',
      sharedWarnings.length === 1 &&
        sharedWarnings[0]!.includes('SIGBASH_API_KEY_ALICE') &&
        !leaked(sharedWarnings[0]!),
      { warning: sharedWarnings[0] ?? null },
    ),
    check(
      'without a participantId the shared triplet is used without warning',
      noParticipant.source === 'shared' &&
        noParticipant.apiKey === sentinels.sharedApi &&
        noParticipantWarnings.length === 0,
    ),
    check(
      'missing shared variables are rejected by name without leaking values',
      missingSharedError !== null &&
        missingSharedError.includes('SIGBASH_SECRET_KEY') &&
        !leaked(missingSharedError),
      { error: missingSharedError },
    ),
  ];
}

function wasmHashChecks(): ContractCheck[] {
  const validHash = 'a1b2c3'.repeat(16); // 96 lowercase hex chars
  const missingError = thrownMessage(() => validateWasmSha384(undefined));
  const emptyError = thrownMessage(() => validateWasmSha384(''));
  const shortError = thrownMessage(() => validateWasmSha384(validHash.slice(1)));
  const longError = thrownMessage(() => validateWasmSha384(`${validHash}a`));
  const nonHexError = thrownMessage(() => validateWasmSha384(`z${validHash.slice(1)}`));
  return [
    check(
      'a 96-char lowercase hex SIGBASH_WASM_SHA384 is accepted unchanged',
      validateWasmSha384(validHash) === validHash,
    ),
    check(
      'a 96-char uppercase hex SIGBASH_WASM_SHA384 is accepted',
      validateWasmSha384(validHash.toUpperCase()) === validHash.toUpperCase(),
    ),
    check(
      'a missing SIGBASH_WASM_SHA384 is rejected by name',
      missingError !== null && missingError.includes('SIGBASH_WASM_SHA384'),
      { error: missingError },
    ),
    check('an empty SIGBASH_WASM_SHA384 is rejected', emptyError !== null),
    check('a 95-char hash is rejected', shortError !== null),
    check('a 97-char hash is rejected', longError !== null),
    check('a 96-char non-hex hash is rejected', nonHexError !== null, { error: nonHexError }),
  ];
}
