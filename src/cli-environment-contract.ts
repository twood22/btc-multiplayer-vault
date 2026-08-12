import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { writeProtectedEnvironmentFile } from './operator-environment.js';

const cliPath = resolve('src/cli.ts');
const tsxCliPath = createRequire(import.meta.url).resolve('tsx/cli');
const checks: Array<{ name: string; ok: true }> = [];
const secretSeed = 'a4'.repeat(32);
const directory = mkdtempSync(join(tmpdir(), 'btc-vault-cli-env-'));

try {
  const dockerIgnoreEntries = readFileSync(resolve('.dockerignore'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim());
  assert(dockerIgnoreEntries.includes('live-run'));
  checks.push({ name: 'the protected proof directory is excluded from the container build context', ok: true });

  const privateDirectory = join(directory, 'private');
  mkdirSync(privateDirectory, { mode: 0o700 });
  writeEnvironment(join(privateDirectory, '.env'), [
    `VAULT_DEMO_SEED=${secretSeed}`,
    'VAULT_DEPOSIT_SATS=10000',
    'VAULT_FIRST_WITHDRAWAL_SATS=9000',
    'VAULT_SECOND_WITHDRAWAL_SATS=10500',
    'PRIVATE_BETA_MAX_DEPOSIT_SATS=10000',
    'RECOVERY_DELAY_BLOCKS=123',
  ]);
  const configured = runCli(privateDirectory, ['funding-manifest']);
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /"depositSats": 10000/u);
  assert.match(configured.stdout, /"valueSats": 30000/u);
  assert.match(configured.stdout, /"relativeBlocks": 123/u);
  assert.match(configured.stdout, /contributing 10000 sats each/u);
  assert(!configured.stdout.includes(secretSeed));
  checks.push({
    name: 'the protected environment loads before configuration modules and never prints its seed',
    ok: true,
  });

  const proofDirectory = join(directory, 'proof');
  mkdirSync(proofDirectory, { mode: 0o700 });
  const proofPath = join(proofDirectory, 'predeployment.env');
  const proofContent = 'RECOVERY_DELAY_BLOCKS=321\n';
  const createdProof = writeProtectedEnvironmentFile(proofPath, proofContent);
  const reusedProof = writeProtectedEnvironmentFile(proofPath, proofContent);
  assert.equal(createdProof.reused, false);
  assert.equal(reusedProof.reused, true);
  assert.equal(lstatSync(proofPath).mode & 0o777, 0o600);
  assert.throws(
    () => writeProtectedEnvironmentFile(proofPath, 'RECOVERY_DELAY_BLOCKS=322\n'),
    /different content/u,
  );
  const extraEnvironmentDirectory = join(directory, 'extra-environment');
  mkdirSync(extraEnvironmentDirectory, { mode: 0o700 });
  writeEnvironment(join(extraEnvironmentDirectory, '.env'), [
    `VAULT_DEMO_SEED=${secretSeed}`,
    'VAULT_DEPOSIT_SATS=10000',
    'VAULT_FIRST_WITHDRAWAL_SATS=9000',
    'VAULT_SECOND_WITHDRAWAL_SATS=10500',
    'PRIVATE_BETA_MAX_DEPOSIT_SATS=10000',
  ]);
  const withProof = runCli(extraEnvironmentDirectory, ['funding-manifest'], {
    BTC_VAULT_EXTRA_ENV_FILE: proofPath,
  });
  assert.equal(withProof.status, 0, withProof.stderr);
  assert.match(withProof.stdout, /"relativeBlocks": 321/u);
  checks.push({
    name: 'the proof environment is owner-only, exact-content resumable, and loaded before configuration',
    ok: true,
  });

  const permissiveDirectory = join(directory, 'permissive');
  mkdirSync(permissiveDirectory, { mode: 0o700 });
  const permissivePath = join(permissiveDirectory, '.env');
  writeEnvironment(permissivePath, [`VAULT_DEMO_SEED=${secretSeed}`]);
  chmodSync(permissivePath, 0o640);
  const permissive = runCli(permissiveDirectory, ['funding-manifest']);
  assert.notEqual(permissive.status, 0);
  assert.match(permissive.stderr, /must not be accessible by group or other users/u);
  assert(!`${permissive.stdout}${permissive.stderr}`.includes(secretSeed));
  checks.push({ name: 'an over-permissive environment is rejected without leaking values', ok: true });

  const writableParentDirectory = join(directory, 'writable-parent');
  mkdirSync(writableParentDirectory, { mode: 0o700 });
  writeEnvironment(join(writableParentDirectory, '.env'), [`VAULT_DEMO_SEED=${secretSeed}`]);
  chmodSync(writableParentDirectory, 0o770);
  const replaceable = runCli(writableParentDirectory, ['funding-manifest']);
  assert.notEqual(replaceable.status, 0);
  assert.match(replaceable.stderr, /parent must not be writable by group or other users/u);
  assert(!`${replaceable.stdout}${replaceable.stderr}`.includes(secretSeed));
  checks.push({ name: 'an environment in a replaceable parent directory is rejected', ok: true });

  const symlinkDirectory = join(directory, 'symlink');
  mkdirSync(symlinkDirectory, { mode: 0o700 });
  const target = join(symlinkDirectory, 'target.env');
  writeEnvironment(target, [`VAULT_DEMO_SEED=${secretSeed}`]);
  symlinkSync(target, join(symlinkDirectory, '.env'));
  const linked = runCli(symlinkDirectory, ['funding-manifest']);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /must be a regular file, not a link/u);
  assert(!`${linked.stdout}${linked.stderr}`.includes(secretSeed));
  checks.push({ name: 'a linked environment is rejected without leaking values', ok: true });

  const missingExtra = runCli(privateDirectory, ['funding-manifest'], {
    BTC_VAULT_EXTRA_ENV_FILE: join(privateDirectory, 'absent.env'),
  });
  assert.notEqual(missingExtra.status, 0);
  assert.match(missingExtra.stderr, /protected environment file does not exist/u);
  checks.push({ name: 'an explicitly requested proof environment must exist', ok: true });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(JSON.stringify({ passed: true, checks }, null, 2));

function writeEnvironment(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function runCli(
  cwd: string,
  args: string[],
  overrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const environment = { ...process.env, ...overrides };
  for (const name of [
    'BTC_VAULT_ENV_FILE',
    'BTC_VAULT_EXTRA_ENV_FILE',
    'VAULT_DEMO_SEED',
    'VAULT_DEPOSIT_SATS',
    'VAULT_FIRST_WITHDRAWAL_SATS',
    'VAULT_SECOND_WITHDRAWAL_SATS',
    'PRIVATE_BETA_MAX_DEPOSIT_SATS',
    'RECOVERY_DELAY_BLOCKS',
  ]) {
    if (!(name in overrides)) delete environment[name];
  }
  const result = spawnSync(process.execPath, [tsxCliPath, cliPath, ...args], {
    cwd,
    env: environment,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}
