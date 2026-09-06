// Explicitly Signet-only live provisioning acceptance. Creates at most the two
// actual pair-round proof keys, never funds/signs/broadcasts. Keep the generated
// credentials and recovery journal private and durable, including failed runs.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtectedEnvironmentFile, writeProtectedFile } from '../src/operator-environment.js';

assert.equal(process.env.VAULT_NETWORK, 'signet');
assert.equal(process.env.NEXT_PUBLIC_VAULT_NETWORK, 'signet');
const directory = resolve(process.argv[2] || '');
assert(directory.startsWith(`${resolve('live-run/signet')}/provisioning-verification-`));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('SIGBASH_') || name.startsWith('BTC_VAULT_') || name === 'VAULT_DEMO_SEED') delete process.env[name];
}
for (const name of ['log', 'warn', 'error', 'debug', 'info'] as const) console[name] = () => {};
const emit = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
const { createIndependentSigbashCredentialFile } = await import('../src/sigbash-credentials.js');
const credentialsPath = `${directory}/credentials.env`;
if (!existsSync(credentialsPath)) await createIndependentSigbashCredentialFile(credentialsPath, ['alice', 'bob', 'carol']);
loadProtectedEnvironmentFile(credentialsPath, { required: true });
Object.assign(process.env, {
  SIGBASH_MODE: 'live', VAULT_DEPOSIT_SATS: '10000', PRIVATE_BETA_MAX_DEPOSIT_SATS: '10000',
  VAULT_SOLO_FEE_SATS: '300', VAULT_SOLO_FEE_BUDGET_SATS: '2000', VAULT_COOP_FEE_SATS: '300',
  VAULT_RECOVERY_FEE_SATS: '500', VAULT_FINAL_SWEEP_FEE_SATS: '300', RECOVERY_DELAY_BLOCKS: '12',
  SIGBASH_SETUP_CHECKPOINT: `${directory}/checkpoint.jsonl`,
  SIGBASH_RECOVERY_JOURNAL: `${directory}/recovery-kits.jsonl`,
});
const secrets = Object.entries(process.env).filter(([name]) =>
  /SIGBASH_(?:API_KEY|USER_KEY|SECRET_KEY)|VAULT_DEMO_SEED/u.test(name)).map(([, value]) => value!).filter(Boolean);
const rows = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const before = rows(process.env.SIGBASH_SETUP_CHECKPOINT!).length;
let errorMessage: string | null = null;
function redact(message: string): string {
  for (const value of secrets) message = message.split(value).join('[redacted]');
  return message.replace(/\b[0-9a-f]{64}\b/giu, '[32-byte value]')
    .replace(/[A-Za-z0-9+/=_-]{80,}/gu, '[long value]').slice(0, 900);
}
// The actual CLI reports a terminal stack and calls process.exit. Capture only
// its sanitized first error line, then preserve the summary in a synchronous
// exit handler; do not let that control flow bypass recovery evidence recording.
console.error = (value: unknown) => {
  if (typeof value === 'string' && /^[A-Za-z]*Error:/u.test(value)) errorMessage = redact(value.split('\n')[0]!);
};
const timeout = setTimeout(() => { emit({ status: 'timeout', network: 'signet' }); process.exit(124); }, 300_000);
process.once('exit', (exitCode) => {
  clearTimeout(timeout);
  const registrations = rows(process.env.SIGBASH_SETUP_CHECKPOINT!);
  const recovery = rows(process.env.SIGBASH_RECOVERY_JOURNAL!);
  const passed = exitCode === 0 && !errorMessage && registrations.length === 2 && recovery.length === 2;
  const result = { createdAt: new Date().toISOString(), network: 'signet', passed,
    previouslyCheckpointedKeys: before, checkpointedKeys: registrations.length,
    protectedRecoveryKits: recovery.length, error: errorMessage,
    signatures: 0, broadcasts: 0, coinsUsed: 0, physicalPasskeysTested: false };
  writeProtectedFile(`${directory}/summary-${Date.now()}.json`, JSON.stringify(result, null, 2));
  emit(result);
  if (!passed) process.exitCode = 1;
});
emit({ stage: 'real-signet-pair-provisioning', previouslyCheckpointedKeys: before });
try {
  process.argv = [process.execPath, resolve('src/cli.ts'), 'sigbash-live-setup', '--proof-round', 'alice,bob',
    '--proof-env-output', `${directory}/predeployment.env`];
  // Run the actual CLI implementation, including its fresh-organization,
  // guarded SDK, exact-policy, recovery-before-checkpoint, and resume paths.
  await import('../src/cli-main.js');
} catch (error) {
  errorMessage = redact(error instanceof Error ? error.message : 'non-Error provisioning failure');
} finally {
  process.exit(errorMessage ? 1 : 0);
}
