/** Public synthetic-test progress and receipts; never publish private test directories. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { acceptanceJsonRecords, parseAcceptanceJson, readPrivateAcceptanceFile,
  validateLocalAcceptanceRun } from './lib/presigned-acceptance-run.js';
import { validateRetainedImageEvidence } from './lib/presigned-image-evidence.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';

process.umask(0o077);
const mode = process.argv[2];
assert(process.env.GITHUB_ACTIONS === 'true' && ['local', 'signet', 'mainnet'].includes(mode ?? ''),
  'usage on a disposable GitHub runner: tsx scripts/presigned-ci.mts local|signet|mainnet');
const sourceDigest = presignedSourceDigest();
const target = mode === 'local' ? 'presigned-acceptance' : 'presigned-container-acceptance';
const child = spawn(process.execPath, ['--import', 'tsx', `scripts/${target}.mts`, mode!], {
  stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
});
let output = ''; let length = 0;
// Parent runners emit stage names and bounded failure summaries, not child logs,
// RPC cookies, passkey envelopes, lifecycle material or native wallet backups.
for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes: Buffer) => {
  length += bytes.length;
  if (length > 1024 * 1024) { child.kill('SIGTERM'); return; }
  const text = bytes.toString(); output += text; process.stdout.write(text);
});
const code = await new Promise<number | null>((resolve, reject) => {
  child.once('error', reject); child.once('close', resolve);
});
assert(code === 0 && length <= 1024 * 1024, 'acceptance failed; no successful receipt or release authorization produced');
assert.equal(presignedSourceDigest(), sourceDigest);
const result = acceptanceJsonRecords(output).findLast(item => item.passed === true);
assert(result && typeof result.evidence === 'string');
const directory = result.evidence;
if (mode === 'local') {
  assert(/^\/tmp\/btc-presigned-acceptance\.[A-Za-z0-9]+$/u.test(directory));
  validateLocalAcceptanceRun(directory, sourceDigest, 'local');
} else {
  assert(/^\/tmp\/btc-presigned-image\.[A-Za-z0-9]+$/u.test(directory));
  await validateRetainedImageEvidence(directory, sourceDigest, mode as 'signet' | 'mainnet');
}
const filename = mode === 'local' ? 'run.json' : 'image-acceptance.json';
const receipt = parseAcceptanceJson(readPrivateAcceptanceFile(`${directory}/${filename}`));
console.log(JSON.stringify({ stage: 'verified-public-ci-receipt', receipt }, null, 2));
console.log(JSON.stringify({ passed: true, mode, sourceDigest, nodeVersion: readFileSync('.node-version', 'utf8').trim(),
  artifactUploads: false, caches: false, registryPush: false, deployment: false,
  completeRetainedReleaseDossier: false, realDefaultSignetVerified: false, fundingAuthorized: false }));
