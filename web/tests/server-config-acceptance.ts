import assert from 'node:assert/strict';
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
} finally {
  if (previous === undefined) delete process.env.VAULT_CONFIRMATIONS_REQUIRED;
  else process.env.VAULT_CONFIRMATIONS_REQUIRED = previous;
}

console.log(JSON.stringify({
  passed: true,
  checks: [{
    name: 'the operator must explicitly choose a confirmation depth from 1 to 144',
    ok: true,
  }],
}, null, 2));
