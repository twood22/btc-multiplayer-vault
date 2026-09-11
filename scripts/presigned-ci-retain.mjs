/** One approved test-only retention operation. Never publishes the draft. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE = '163afb1ad68566c1ae33d59811b775add4988e12';
const SOURCE = '49e4240d66a9780a7403996e4cca96478eb50e797e158ffb38157d910c9071ae';
const TAG = 'presigned-v2-test-evidence-49e4240d-20260911';
process.umask(0o077);
const [operation, network, suppliedDirectory] = process.argv.slice(2);
assert(['run', 'upload'].includes(operation) && ['signet', 'mainnet'].includes(network));
assert(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux' && process.env.RUNNER_ARCH === 'X64');
assert(process.env.GITHUB_REF === 'refs/heads/codex/presigned-test-evidence');
assert(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
assert(/^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? '') && /^[0-9]+$/u.test(process.env.GITHUB_RUN_ID ?? ''));
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), CANDIDATE);
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
assert(event.repository?.private === false, 'Only the approved public repository is eligible');
const assetName = `presigned-v2-${network}-test-evidence.tar.gz`;
async function fileHash(filename) {
  const stat = lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return { sha256: hash.digest('hex'), bytes: stat.size };
}
function readOwnedJson(filename) {
  const stat = lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.size < 1024 * 1024 && (stat.mode & 0o077) === 0);
  return JSON.parse(readFileSync(filename, 'utf8'));
}
const expectedDirectory = join(process.env.RUNNER_TEMP, `presigned-public-evidence-${network}`);
if (operation === 'run') {
  assert(!suppliedDirectory && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,
    'Do not expose publication credentials or operational build keys to acceptance');
  const { presignedSourceDigest } = await import(pathToFileURL(resolve('scripts/presigned-build-identity.mjs')).href);
  const { acceptanceJsonRecords } = await import(pathToFileURL(resolve('scripts/lib/presigned-acceptance-run.ts')).href);
  assert.equal(presignedSourceDigest(), SOURCE);
  const before = new Set(readdirSync('/tmp').filter(name => /^btc-presigned-archive-output\.[A-Za-z0-9]+$/u.test(name)));
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/presigned-ci.mts', network], {
    stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  let output = ''; let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) { child.kill('SIGTERM'); return; }
    output += chunk.toString(); process.stdout.write(chunk);
  });
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
  assert(code === 0 && bytes <= 2 * 1024 * 1024, 'Exact candidate acceptance failed; no upload is permitted');
  assert.equal(presignedSourceDigest(), SOURCE);
  const records = acceptanceJsonRecords(output);
  const packed = records.filter(item => item.stage === 'verified-local-only-archive');
  assert.equal(packed.length, 1);
  const pack = packed[0];
  assert(pack.passed === true && pack.evidenceKind === `${network}-image` && pack.sourceDigest === SOURCE &&
    pack.restoredBytesRevalidated === true && pack.contentPrivacyReviewed === false && pack.published === false);
  const created = readdirSync('/tmp').filter(name => /^btc-presigned-archive-output\.[A-Za-z0-9]+$/u.test(name) && !before.has(name));
  assert.equal(created.length, 1, 'Require one unambiguous archive from this invocation');
  const archive = join('/tmp', created[0], `presigned-v2-${network}.tar.gz`);
  const actual = await fileHash(archive);
  assert(actual.sha256 === pack.archiveSha256 && actual.bytes === pack.archiveBytes);
  mkdirSync(expectedDirectory, { mode: 0o700 });
  linkSync(archive, join(expectedDirectory, assetName));
  const retention = { version: 1, kind: 'presigned-v2-public-test-evidence', network, sourceCommit: CANDIDATE,
    sourceDigest: SOURCE, toolingCommit: process.env.GITHUB_SHA, workflowRunId: process.env.GITHUB_RUN_ID,
    assetName, archiveSha256: actual.sha256, archiveBytes: actual.bytes, evidenceDigest: pack.evidenceDigest,
    files: pack.files, restoredBytesRevalidated: true, syntheticOnly: true,
    productionUsePermitted: false, realDefaultSignetVerified: false, physicalPasskeysVerified: false,
    releaseReceiptProduced: false, fundingAuthorized: false };
  writeFileSync(join(expectedDirectory, `presigned-v2-${network}-retention.json`), `${JSON.stringify(retention, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  assert(!expectedDirectory.includes('\n'));
  appendFileSync(process.env.GITHUB_OUTPUT, `directory=${expectedDirectory}\n`);
  console.log(JSON.stringify({ stage: 'retained-for-content-review', ...retention }));
} else {
  assert(suppliedDirectory === expectedDirectory && process.env.GH_TOKEN && process.env.GH_REPO === process.env.GITHUB_REPOSITORY);
  const stat = lstatSync(expectedDirectory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  const retentionName = `presigned-v2-${network}-retention.json`;
  const reviewName = `presigned-v2-${network}-content-review.json`;
  const retention = readOwnedJson(join(expectedDirectory, retentionName));
  const review = readOwnedJson(join(expectedDirectory, reviewName));
  const actual = await fileHash(join(expectedDirectory, assetName));
  assert(retention.sourceCommit === CANDIDATE && retention.sourceDigest === SOURCE && retention.network === network &&
    retention.toolingCommit === process.env.GITHUB_SHA && retention.workflowRunId === process.env.GITHUB_RUN_ID &&
    retention.assetName === assetName && retention.archiveSha256 === actual.sha256 && retention.archiveBytes === actual.bytes &&
    retention.syntheticOnly === true && retention.productionUsePermitted === false && retention.fundingAuthorized === false);
  assert(review.passed === true && review.archiveSha256 === actual.sha256 && review.archiveBytes === actual.bytes &&
    review.historicalLayersInspected === true && review.exactArchiveMembersInspected === true && review.productionUsePermitted === false &&
    review.canonicalOuterEnvelopeVerified === true &&
    review.sourceCommit === CANDIDATE && review.sourceDigest === SOURCE && review.toolingCommit === process.env.GITHUB_SHA &&
    review.workflowRunId === process.env.GITHUB_RUN_ID && review.network === network &&
    review.scannerSha256 === createHash('sha256').update(readFileSync(resolve('../scripts/presigned-public-evidence.py'))).digest('hex'));
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const release = JSON.parse(gh(['release', 'view', TAG, '--json', 'tagName,isDraft,isPrerelease,targetCommitish,assets']));
  assert(release.tagName === TAG && release.isDraft === true && release.isPrerelease === true && release.targetCommitish === CANDIDATE,
    'Only the exact preapproved test-only draft is eligible; never create or publish a release automatically');
  assert(!release.assets.some(asset => [assetName, retentionName, reviewName].includes(asset.name)), 'Never overwrite retained evidence');
  gh(['release', 'upload', TAG, ...[assetName, retentionName, reviewName].map(name => join(expectedDirectory, name))]);
  const after = JSON.parse(gh(['release', 'view', TAG, '--json', 'isDraft,isPrerelease,targetCommitish']));
  assert(after.isDraft === true && after.isPrerelease === true && after.targetCommitish === CANDIDATE,
    'Draft state changed during upload; stop and review before any publication');
  console.log(JSON.stringify({ uploadedToDraft: true, tag: TAG, network, ...actual,
    releasePublished: false, productionUsePermitted: false, fundingAuthorized: false }));
}
