import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'vault-build-network-'));
const checker = resolve('scripts/check-build-network.mjs');
const launcher = resolve('scripts/start-production.mjs');
const run = (path, args, env) => spawnSync(process.execPath, [path, ...args], {
  cwd: directory, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000,
});
try {
  // Stand-in only for the final entrypoint: the actual production network gate
  // executes first, with no database, listener, credentials, or provider call.
  writeFileSync(join(directory, 'server.js'), 'console.log("ENTRYPOINT_REACHED")');
  for (const network of ['mainnet', 'signet']) {
    const env = { VAULT_NETWORK: network, NEXT_PUBLIC_VAULT_NETWORK: network };
    const recorded = run(checker, ['--record'], env);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(run(checker, [], env).status, 0);
    const good = run(launcher, [], env);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /ENTRYPOINT_REACHED/u);
    const other = network === 'signet' ? 'mainnet' : 'signet';
    for (const bad of [
      { VAULT_NETWORK: other, NEXT_PUBLIC_VAULT_NETWORK: other },
      { VAULT_NETWORK: network, NEXT_PUBLIC_VAULT_NETWORK: other },
      { VAULT_NETWORK: '', NEXT_PUBLIC_VAULT_NETWORK: '' },
    ]) {
      const result = run(launcher, [], bad);
      assert.notEqual(result.status, 0);
      assert(!result.stdout.includes('ENTRYPOINT_REACHED'));
    }
  }
  console.log('Production entrypoint rejects missing, mixed, and wrong-build networks before starting the server');
} finally { rmSync(directory, { recursive: true, force: true }); }
