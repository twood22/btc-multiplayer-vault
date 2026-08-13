import './check-runtime.mjs';
import { spawnSync } from 'node:child_process';

// This probe deliberately omits every required broadcast argument. Reaching
// the exact argument error proves the packaged npm command, tsx loader,
// operator source tree, and its static imports can load without allowing the
// command to inspect release artifacts, open PostgreSQL, contact Bitcoin Core,
// or submit a transaction.
const result = spawnSync('npm', ['run', 'web:broadcast-funding', '--'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, NODE_ENV: 'production' },
});

if (result.error) {
  throw new Error(`production operator runtime could not launch npm: ${result.error.message}`);
}
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
if (result.status === 0 || !output.includes('--vault-id is required')) {
  throw new Error(
    `production operator runtime did not reach its fail-closed argument boundary (exit ${String(result.status)})`,
  );
}

console.log(JSON.stringify({
  passed: true,
  mutationBoundaryReached: false,
  externalServiceAccessRequired: false,
  expectedFailure: '--vault-id is required',
}, null, 2));
