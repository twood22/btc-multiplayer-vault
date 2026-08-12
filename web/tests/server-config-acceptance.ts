import assert from 'node:assert/strict';
import { assertDatabaseUrl, databaseEndpointCheck } from '../lib/database-config.js';
import { chainConfirmationsRequired } from '../lib/server/config.js';

const previous = process.env.VAULT_CONFIRMATIONS_REQUIRED;
try {
  delete process.env.VAULT_CONFIRMATIONS_REQUIRED;
  assert.throws(() => chainConfirmationsRequired(), /VAULT_CONFIRMATIONS_REQUIRED is required/);

  for (const invalid of ['0', '1.5', '145', '-1', 'not-a-number']) {
    process.env.VAULT_CONFIRMATIONS_REQUIRED = invalid;
    assert.throws(() => chainConfirmationsRequired(), /integer from 1 to 144/);
  }

  process.env.VAULT_CONFIRMATIONS_REQUIRED = '3';
  assert.equal(chainConfirmationsRequired(), 3);

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
  ],
}, null, 2));
