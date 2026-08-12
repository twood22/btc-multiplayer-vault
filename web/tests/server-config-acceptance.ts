import assert from 'node:assert/strict';
import {
  REVIEWED_NODE_VERSION,
  assertReviewedNodeRuntime,
  reviewedNodeRuntimeCheck,
} from '../../src/runtime-version';
import { assertDatabaseUrl, databaseEndpointCheck } from '../lib/database-config.js';
import { chainConfirmationsRequired, fundingFeeSats } from '../lib/server/config.js';

const previous = process.env.VAULT_CONFIRMATIONS_REQUIRED;
const previousFundingFee = process.env.VAULT_FUNDING_FEE_SATS;
try {
  delete process.env.VAULT_CONFIRMATIONS_REQUIRED;
  assert.throws(() => chainConfirmationsRequired(), /VAULT_CONFIRMATIONS_REQUIRED is required/);

  for (const invalid of ['0', '1.5', '145', '-1', 'not-a-number']) {
    process.env.VAULT_CONFIRMATIONS_REQUIRED = invalid;
    assert.throws(() => chainConfirmationsRequired(), /integer from 1 to 144/);
  }

  process.env.VAULT_CONFIRMATIONS_REQUIRED = '3';
  assert.equal(chainConfirmationsRequired(), 3);

  delete process.env.VAULT_FUNDING_FEE_SATS;
  assert.equal(fundingFeeSats(), 600);
  for (const invalid of ['0', '499', '600.5', '-1', 'not-a-number']) {
    process.env.VAULT_FUNDING_FEE_SATS = invalid;
    assert.throws(() => fundingFeeSats(), /integer of at least 500/);
  }
  process.env.VAULT_FUNDING_FEE_SATS = '900';
  assert.equal(fundingFeeSats(), 900);

  assert.deepEqual(reviewedNodeRuntimeCheck(REVIEWED_NODE_VERSION), {
    ok: true,
    actual: REVIEWED_NODE_VERSION,
    expected: REVIEWED_NODE_VERSION,
  });
  assert.throws(() => assertReviewedNodeRuntime('22.23.1'), /requires the reviewed Node\.js 22\.23\.2 runtime/);

  const local = 'postgresql://127.0.0.1:5432/vault';
  assert.equal(assertDatabaseUrl(local, { production: true }), local);
  assert.throws(
    () => assertDatabaseUrl('postgresql://db.example/vault?sslmode=require', { production: true }),
    /sslmode=verify-full/,
  );
  const verified = 'postgresql://user:secret@db.example/vault?sslmode=verify-full';
  assert.equal(assertDatabaseUrl(verified, { production: true }), verified);
  assert.deepEqual(databaseEndpointCheck(local), {
    ok: false,
    detail: 'local database endpoint',
  });
  assert.deepEqual(databaseEndpointCheck(verified), {
    ok: true,
    detail: 'non-local endpoint; sslmode=verify-full',
  });
} finally {
  if (previous === undefined) delete process.env.VAULT_CONFIRMATIONS_REQUIRED;
  else process.env.VAULT_CONFIRMATIONS_REQUIRED = previous;
  if (previousFundingFee === undefined) delete process.env.VAULT_FUNDING_FEE_SATS;
  else process.env.VAULT_FUNDING_FEE_SATS = previousFundingFee;
}

console.log(JSON.stringify({
  passed: true,
  checks: [
    {
      name: 'the operator must explicitly choose a confirmation depth from 1 to 144',
      ok: true,
    },
    {
      name: 'non-local production PostgreSQL requires full certificate and hostname verification',
      ok: true,
    },
    {
      name: 'the exact reviewed Node runtime rejects mismatched patch versions',
      ok: true,
    },
    {
      name: 'funding fee configuration rejects values below the transaction safety floor',
      ok: true,
    },
  ],
}, null, 2));
