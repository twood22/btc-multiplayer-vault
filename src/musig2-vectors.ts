import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ecc from 'tiny-secp256k1';
import {
  applyTweak,
  keyAggContext,
  nonceAgg,
  nonceGen,
  partialSigAgg,
  partialSigVerify,
  sign,
  type SessionContext,
} from './musig2.js';

// Runs the official BIP-327 test vectors (bitcoin/bips, bip-0327/vectors/*)
// against src/musig2.ts: NonceGen with fixed rand', NonceAgg, Sign/Verify,
// tweaked signing, and PartialSigAgg. Every hex string in the vector files is
// uppercase; everything here is case-insensitive via Buffer comparison.

const VECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'vectors');

interface VectorCheck {
  vector: string;
  case: string | number;
  ok: boolean;
  detail?: string;
}

export interface ProtocolVectorReport {
  passed: boolean;
  total: number;
  checks: VectorCheck[];
}

function loadVectors<T>(name: string): T {
  return JSON.parse(readFileSync(join(VECTOR_DIR, name), 'utf8')) as T;
}

function hex(value: string | null | undefined): Buffer | undefined {
  return value === null || value === undefined ? undefined : Buffer.from(value, 'hex');
}

export function runBip327ProtocolVectors(): ProtocolVectorReport {
  const checks: VectorCheck[] = [];
  const record = (vector: string, caseId: string | number, ok: boolean, detail?: string) => {
    checks.push({ vector, case: caseId, ok, ...(detail ? { detail } : {}) });
  };

  // ── NonceGen with fixed rand' ─────────────────────────────────────────────
  interface NonceGenVectors {
    test_cases: Array<{
      rand_: string;
      sk: string | null;
      pk: string;
      aggpk: string | null;
      msg: string | null;
      extra_in: string | null;
      expected_secnonce: string;
      expected_pubnonce: string;
    }>;
  }
  const nonceGenVectors = loadVectors<NonceGenVectors>('nonce_gen_vectors.json');
  nonceGenVectors.test_cases.forEach((testCase, index) => {
    try {
      const result = nonceGen({
        secretKey: hex(testCase.sk),
        publicKey: hex(testCase.pk)!,
        aggregateXonly: hex(testCase.aggpk),
        message: hex(testCase.msg),
        extraIn: hex(testCase.extra_in),
        rand: hex(testCase.rand_),
      });
      const ok =
        result.secnonce.equals(Buffer.from(testCase.expected_secnonce, 'hex')) &&
        result.pubnonce.equals(Buffer.from(testCase.expected_pubnonce, 'hex'));
      record('nonce_gen', index, ok);
    } catch (error) {
      record('nonce_gen', index, false, (error as Error).message);
    }
  });

  // ── NonceAgg ──────────────────────────────────────────────────────────────
  interface NonceAggVectors {
    pnonces: string[];
    valid_test_cases: Array<{ pnonce_indices: number[]; expected: string }>;
    error_test_cases: Array<{ pnonce_indices: number[]; error: { signer?: number } }>;
  }
  const nonceAggVectors = loadVectors<NonceAggVectors>('nonce_agg_vectors.json');
  nonceAggVectors.valid_test_cases.forEach((testCase, index) => {
    try {
      const aggregated = nonceAgg(
        testCase.pnonce_indices.map((i) => Buffer.from(nonceAggVectors.pnonces[i]!, 'hex')),
      );
      record('nonce_agg', index, aggregated.equals(Buffer.from(testCase.expected, 'hex')));
    } catch (error) {
      record('nonce_agg', index, false, (error as Error).message);
    }
  });
  nonceAggVectors.error_test_cases.forEach((testCase, index) => {
    try {
      nonceAgg(testCase.pnonce_indices.map((i) => Buffer.from(nonceAggVectors.pnonces[i]!, 'hex')));
      record('nonce_agg_error', index, false, 'expected an error');
    } catch (error) {
      const signer = (error as { signer?: number }).signer;
      record(
        'nonce_agg_error',
        index,
        testCase.error.signer === undefined || signer === testCase.error.signer,
      );
    }
  });

  // ── Sign / PartialSigVerify ───────────────────────────────────────────────
  interface SignVerifyVectors {
    sk: string;
    pubkeys: string[];
    secnonces: string[];
    pnonces: string[];
    aggnonces: string[];
    msgs: string[];
    valid_test_cases: Array<{
      key_indices: number[];
      nonce_indices: number[];
      aggnonce_index: number;
      msg_index: number;
      signer_index: number;
      expected: string;
    }>;
    verify_fail_test_cases: Array<{
      sig: string;
      key_indices: number[];
      nonce_indices: number[];
      msg_index: number;
      signer_index: number;
    }>;
  }
  const signVectors = loadVectors<SignVerifyVectors>('sign_verify_vectors.json');
  signVectors.valid_test_cases.forEach((testCase, index) => {
    try {
      const session: SessionContext = {
        aggnonce: Buffer.from(signVectors.aggnonces[testCase.aggnonce_index]!, 'hex'),
        pubkeys: testCase.key_indices.map((i) => signVectors.pubkeys[i]!.toLowerCase()),
        tweaks: [],
        isXonly: [],
        message: Buffer.from(signVectors.msgs[testCase.msg_index]!, 'hex'),
      };
      const partialSig = sign(
        Buffer.from(signVectors.secnonces[0]!, 'hex'),
        Buffer.from(signVectors.sk, 'hex'),
        session,
      );
      const matches = partialSig.equals(Buffer.from(testCase.expected, 'hex'));
      const verifies = partialSigVerify(
        partialSig,
        testCase.nonce_indices.map((i) => Buffer.from(signVectors.pnonces[i]!, 'hex')),
        session,
        testCase.signer_index,
      );
      record('sign_verify', index, matches && verifies, matches ? undefined : 'sig mismatch');
    } catch (error) {
      record('sign_verify', index, false, (error as Error).message);
    }
  });
  signVectors.verify_fail_test_cases.forEach((testCase, index) => {
    try {
      const pubnonces = testCase.nonce_indices.map((i) =>
        Buffer.from(signVectors.pnonces[i]!, 'hex'),
      );
      const session: SessionContext = {
        aggnonce: nonceAgg(pubnonces),
        pubkeys: testCase.key_indices.map((i) => signVectors.pubkeys[i]!.toLowerCase()),
        tweaks: [],
        isXonly: [],
        message: Buffer.from(signVectors.msgs[testCase.msg_index]!, 'hex'),
      };
      const verifies = partialSigVerify(
        Buffer.from(testCase.sig, 'hex'),
        pubnonces,
        session,
        testCase.signer_index,
      );
      record('verify_fail', index, !verifies);
    } catch {
      record('verify_fail', index, true);
    }
  });

  // ── Tweaked signing ───────────────────────────────────────────────────────
  interface TweakVectors {
    sk: string;
    pubkeys: string[];
    secnonce: string;
    pnonces: string[];
    aggnonce: string;
    tweaks: string[];
    msg: string;
    valid_test_cases: Array<{
      key_indices: number[];
      nonce_indices: number[];
      tweak_indices: number[];
      is_xonly: boolean[];
      signer_index: number;
      expected: string;
    }>;
    error_test_cases: Array<{
      key_indices: number[];
      nonce_indices: number[];
      tweak_indices: number[];
      is_xonly: boolean[];
      signer_index: number;
    }>;
  }
  const tweakVectors = loadVectors<TweakVectors>('tweak_vectors.json');
  tweakVectors.valid_test_cases.forEach((testCase, index) => {
    try {
      const session: SessionContext = {
        aggnonce: Buffer.from(tweakVectors.aggnonce, 'hex'),
        pubkeys: testCase.key_indices.map((i) => tweakVectors.pubkeys[i]!.toLowerCase()),
        tweaks: testCase.tweak_indices.map((i) => Buffer.from(tweakVectors.tweaks[i]!, 'hex')),
        isXonly: testCase.is_xonly,
        message: Buffer.from(tweakVectors.msg, 'hex'),
      };
      const partialSig = sign(
        Buffer.from(tweakVectors.secnonce, 'hex'),
        Buffer.from(tweakVectors.sk, 'hex'),
        session,
      );
      const matches = partialSig.equals(Buffer.from(testCase.expected, 'hex'));
      const verifies = partialSigVerify(
        partialSig,
        testCase.nonce_indices.map((i) => Buffer.from(tweakVectors.pnonces[i]!, 'hex')),
        session,
        testCase.signer_index,
      );
      record('tweak', index, matches && verifies, matches ? undefined : 'sig mismatch');
    } catch (error) {
      record('tweak', index, false, (error as Error).message);
    }
  });
  tweakVectors.error_test_cases.forEach((testCase, index) => {
    try {
      const session: SessionContext = {
        aggnonce: Buffer.from(tweakVectors.aggnonce, 'hex'),
        pubkeys: testCase.key_indices.map((i) => tweakVectors.pubkeys[i]!.toLowerCase()),
        tweaks: testCase.tweak_indices.map((i) => Buffer.from(tweakVectors.tweaks[i]!, 'hex')),
        isXonly: testCase.is_xonly,
        message: Buffer.from(tweakVectors.msg, 'hex'),
      };
      sign(Buffer.from(tweakVectors.secnonce, 'hex'), Buffer.from(tweakVectors.sk, 'hex'), session);
      record('tweak_error', index, false, 'expected an error');
    } catch {
      record('tweak_error', index, true);
    }
  });

  // ── PartialSigAgg ─────────────────────────────────────────────────────────
  interface SigAggVectors {
    pubkeys: string[];
    pnonces: string[];
    tweaks: string[];
    psigs: string[];
    msg: string;
    valid_test_cases: Array<{
      aggnonce: string;
      nonce_indices: number[];
      key_indices: number[];
      tweak_indices: number[];
      is_xonly: boolean[];
      psig_indices: number[];
      expected: string;
    }>;
  }
  const sigAggVectors = loadVectors<SigAggVectors>('sig_agg_vectors.json');
  sigAggVectors.valid_test_cases.forEach((testCase, index) => {
    try {
      const pubnonces = testCase.nonce_indices.map((i) =>
        Buffer.from(sigAggVectors.pnonces[i]!, 'hex'),
      );
      const aggregatedNonce = nonceAgg(pubnonces);
      const aggnonceMatches = aggregatedNonce.equals(Buffer.from(testCase.aggnonce, 'hex'));
      const session: SessionContext = {
        aggnonce: aggregatedNonce,
        pubkeys: testCase.key_indices.map((i) => sigAggVectors.pubkeys[i]!.toLowerCase()),
        tweaks: testCase.tweak_indices.map((i) => Buffer.from(sigAggVectors.tweaks[i]!, 'hex')),
        isXonly: testCase.is_xonly,
        message: Buffer.from(sigAggVectors.msg, 'hex'),
      };
      const signature = partialSigAgg(
        testCase.psig_indices.map((i) => Buffer.from(sigAggVectors.psigs[i]!, 'hex')),
        session,
      );
      const matches = signature.equals(Buffer.from(testCase.expected, 'hex'));
      // The final signature must be a valid BIP-340 signature for the tweaked
      // aggregate key over the vector message.
      let context = keyAggContext(session.pubkeys);
      session.tweaks.forEach((tweak, tweakIndex) => {
        context = applyTweak(context, tweak, session.isXonly[tweakIndex]!);
      });
      const verifies = ecc.verifySchnorr(
        session.message,
        context.q.subarray(1),
        signature,
      );
      record('sig_agg', index, aggnonceMatches && matches && verifies);
    } catch (error) {
      record('sig_agg', index, false, (error as Error).message);
    }
  });

  return {
    passed: checks.every((item) => item.ok),
    total: checks.length,
    checks,
  };
}
