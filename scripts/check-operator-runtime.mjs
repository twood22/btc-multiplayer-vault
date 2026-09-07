import './check-runtime.mjs';
import assert from 'node:assert/strict';
import { assertBuildNetwork } from './check-build-network.mjs';
import { spawnSync } from 'node:child_process';

// Both argument guards and later dynamic server imports must load. The fresh
// environment has no operational files, credentials, endpoints or opt-ins;
// the later probes stop at missing substantive prerequisites. In particular,
// a missing-argument-only check cannot detect a broken server-only import.
const network = assertBuildNetwork();
const environment = { NODE_ENV: 'production', VAULT_NETWORK: network, NEXT_PUBLIC_VAULT_NETWORK: network,
  NEXT_TELEMETRY_DISABLED: '1' };
for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) environment[key] = process.env[key];
function run(command, args, expected) {
  const result = spawnSync('npm', ['run', command, '--', ...args], {
    cwd: process.cwd(), encoding: 'utf8', env: environment, timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error('production operator runtime could not launch or finish its bounded private probe');
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(result.status === 1 && output.includes(expected),
    `production operator runtime did not reach its intended fail-closed boundary (exit ${String(result.status)})`);
  return result.stdout;
}
const commands = [
  ['web:broadcast-funding', '--vault-id is required'],
  ['presigned:release-status', '--vault-id is required'],
  ['presigned:verify-database-restore', 'invalid restore vault'],
];
for (const [command, expected] of commands) run(command, [], expected);
const identityArgs = ['--vault-id', '11111111-1111-4111-8111-111111111111',
  '--epoch-id', '22222222-2222-4222-8222-222222222222'];
const postArgumentFailures = [
  ['presigned:release-status', 'PRESIGNED_V2_ACCEPTANCE_RECEIPT is required for v2 funding release'],
  ['presigned:verify-database-restore', 'both exact database endpoints must use non-local verified TLS'],
];
const release = run(postArgumentFailures[0][0], identityArgs, postArgumentFailures[0][1]);
assert(release.includes('"reportWritten":false') && release.includes('"fundingAllowed":false'));
run(postArgumentFailures[1][0], [...identityArgs,
  '--write-protected-receipt', '/tmp/presigned-probe-do-not-create-funding.json',
  '--write-database-receipt', '/tmp/presigned-probe-do-not-create-database.json',
  '--confirm-source-quiesced', 'SOURCE_QUIESCED_FOR_BACKUP_RESTORE'], postArgumentFailures[1][1]);

console.log(JSON.stringify({
  passed: true,
  mutationBoundaryReached: false,
  externalServiceAccessRequired: false,
  postArgumentImportsVerified: true,
  expectedFailures: commands,
  postArgumentFailures,
}, null, 2));
