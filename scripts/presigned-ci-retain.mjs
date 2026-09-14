/** One approved test-only retention operation. Never publishes the draft. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE = 'd907d42b49acb440394d703fca1e31d4e575f577';
const SOURCE = '61d3b2c5e0d37b49775b87c7554b644c4225a7afbaee358e2ad2f1b257780353';
const TAG = 'presigned-v3-test-evidence-61d3b2c5-20260914';
const PROTOCOL = 'presigned-graph-v3';

export function validateFinalPins(candidate = CANDIDATE, source = SOURCE, tag = TAG) {
  assert(/^[0-9a-f]{40}$/u.test(candidate), 'Final immutable candidate pin is unset or invalid');
  assert(/^[0-9a-f]{64}$/u.test(source), 'Final source digest pin is unset or invalid');
  assert(new RegExp(`^presigned-v3-test-evidence-${source.slice(0, 8)}-[0-9]{8}$`, 'u').test(tag),
    'Exact preapproved V3 test-only draft tag is unset or invalid');
}
export function assertV3ArchivePack(pack, network, source) {
  assert(pack.passed === true && pack.protocol === PROTOCOL && pack.kind === 'presigned-v3-local-evidence-archive' &&
    pack.evidenceKind === `${network}-image` && pack.sourceDigest === source && pack.restoredBytesRevalidated === true &&
    pack.contentPrivacyReviewed === false && pack.published === false && pack.realDefaultSignetVerified === false &&
    pack.releaseReceiptProduced === false && pack.fundingAuthorized === false,
    'Require exact V3 synthetic image evidence, not V2 or a production authorization');
}
export function assertV3Retention(retention) {
  // Version 1 is the retention-record schema; the Bitcoin protocol is V3.
  assert(retention.version === 1 && retention.protocol === PROTOCOL && retention.kind === 'presigned-v3-public-test-evidence' &&
    retention.restoredBytesRevalidated === true && retention.syntheticOnly === true && retention.productionUsePermitted === false &&
    retention.realDefaultSignetVerified === false && retention.physicalPasskeysVerified === false &&
    retention.releaseReceiptProduced === false && retention.fundingAuthorized === false,
    'Require the V3 synthetic-only retention schema and unchanged limitations');
}
export function assertV3ContentReview(review) {
  assert(review.version === 1 && review.protocol === PROTOCOL && review.kind === 'presigned-v3-test-archive-content-review' &&
    review.passed === true && review.syntheticOnly === true && review.productionUsePermitted === false &&
    review.realDefaultSignetVerified === false && review.physicalPasskeysVerified === false &&
    review.releaseReceiptProduced === false && review.fundingAuthorized === false,
    'Require exact V3 synthetic content review, not V2 or a release receipt');
}

/** Only fixed labels, bounded counts and source locations leave a failed
 * browser run. Never publish raw logs, errors, DOM snapshots or credentials. */
export function publicBrowserFailureMetadata(text) {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024);
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  const actors = ['alice', 'bob', 'carol'];
  const roles = ['primary', 'recovery', 'unknown'];
  const endpoints = ['/api/vault/presigned/action/options', '/api/vault/presigned/action/finish',
    '/api/vault/presigned/status', '/api/passkeys/unlock/options', '/api/passkeys/unlock/finish',
    '/api/passkeys/register/options', '/api/passkeys/register/verify',
    '/api/passkeys/envelope/options', '/api/passkeys/envelope/finish',
    '/api/vault/presigned/runtime/status', '/api/vault/presigned/runtime/action/options', '/api/vault/presigned/runtime/action/finish',
    '/api/vault/presigned/cashout/status', '/api/vault/presigned/cashout/prepare', '/api/vault/presigned/cashout/broadcast'];
  const api = values => Array.isArray(values) ? values.slice(-16).flatMap(item =>
    item && endpoints.includes(item.endpoint) && count(item.status) && item.status <= 599
      ? [{ endpoint: item.endpoint, status: item.status }] : []) : [];
  const diagnostic = (actor, value) => {
    if (!actors.includes(actor) || !value || typeof value !== 'object') return [];
    const safe = { actor };
    for (const key of ['pageErrors', 'crashes', 'failedScriptRequests', 'credentialCreations',
      'credentialAssertions', 'primaryAssertions', 'recoveryAssertions']) if (count(value[key])) safe[key] = value[key];
    for (const key of ['selectedAuthenticator', 'unlockRequestedAuthenticator'])
      if (roles.includes(value[key])) safe[key] = value[key];
    safe.recentApi = api(value.recentApi);
    return [safe];
  };
  const records = [];
  for (const line of text.split('\n')) {
    if (line.length > 65_536 || !line.startsWith('{')) continue;
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (!value || !Array.isArray(value.assertionLocations)) continue;
    const locations = value.assertionLocations.slice(0, 8).flatMap(item => item &&
      ['presigned-v2.spec.ts', 'presigned-v2-fixture.ts'].includes(item.file) &&
      count(item.line) && item.line > 0 && count(item.column) && item.column > 0
      ? [{ file: item.file, line: item.line, column: item.column }] : []);
    const diagnostics = Array.isArray(value.browserDiagnostics)
      ? value.browserDiagnostics.slice(0, 3).flatMap(item => item ? diagnostic(item.actor, item) : [])
      : diagnostic(value.actor, value.diagnostics);
    const failureKind = ['timeout', 'strict-locator', 'closed-page', 'other'].includes(value.failureKind) ? value.failureKind : 'other';
    records.push({ locations, diagnostics, failureKind, httpFailures: api(value.httpFailures) });
    if (records.length === 8) break;
  }
  return { records };
}

async function main() {
  process.umask(0o077);
  const [operation, network, suppliedDirectory] = process.argv.slice(2);
  validateFinalPins();
  if (operation === 'check-pins') {
    assert(process.argv.length === 3, 'check-pins accepts no overrides');
    console.log(JSON.stringify({ finalizedPins: true, protocol: PROTOCOL, candidate: CANDIDATE, sourceDigest: SOURCE, draftTag: TAG }));
    return;
  }
  assert(['run', 'upload'].includes(operation) && ['signet', 'mainnet'].includes(network));
  assert(process.argv.length === (operation === 'run' ? 4 : 5), 'unexpected retention arguments');
  assert(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux' && process.env.RUNNER_ARCH === 'X64');
  assert(process.env.GITHUB_REF === 'refs/heads/codex/presigned-v3-test-evidence');
  assert(process.env.PRESIGNED_ACCEPTANCE_PROTOCOL === PROTOCOL && process.env.PRESIGNED_BUILD_PROTOCOL === PROTOCOL,
    'Both candidate acceptance and exact-image build must explicitly select V3');
  assert(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
  assert(/^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? '') && /^[0-9]+$/u.test(process.env.GITHUB_RUN_ID ?? ''));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), CANDIDATE);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  assert(event.repository?.private === false, 'Only the approved public repository is eligible');
  const assetName = `presigned-v3-${network}-test-evidence.tar.gz`;
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
  const expectedDirectory = join(process.env.RUNNER_TEMP, `presigned-v3-public-evidence-${network}`);
  if (operation === 'run') {
    assert(!suppliedDirectory && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,
      'Do not expose publication credentials or operational build keys to acceptance');
    const { presignedSourceDigest } = await import(pathToFileURL(resolve('scripts/presigned-build-identity.mjs')).href);
    const { acceptanceJsonRecords, readPrivateAcceptanceFile } = await import(pathToFileURL(resolve('scripts/lib/presigned-acceptance-run.ts')).href);
    assert.equal(presignedSourceDigest(), SOURCE);
    const before = new Set(readdirSync('/tmp').filter(name => /^btc-presigned-archive-output\.[A-Za-z0-9]+$/u.test(name)));
    const beforeBrowsers = new Set(readdirSync('/tmp').filter(name => /^btc-presigned-browser\.[A-Za-z0-9]+$/u.test(name)));
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
    if (code !== 0) {
      try {
        const browsers = readdirSync('/tmp').filter(name => /^btc-presigned-browser\.[A-Za-z0-9]+$/u.test(name) && !beforeBrowsers.has(name));
        assert.equal(browsers.length, 1);
        const safe = publicBrowserFailureMetadata(readPrivateAcceptanceFile(join('/tmp', browsers[0], 'browser.log'), 1024 * 1024).toString());
        console.log(JSON.stringify({ stage: 'safe-browser-failure-metadata', ...safe }));
      } catch { console.log(JSON.stringify({ stage: 'safe-browser-failure-metadata-unavailable' })); }
    }
    assert(code === 0 && bytes <= 2 * 1024 * 1024, 'Exact candidate acceptance failed; no upload is permitted');
    assert.equal(presignedSourceDigest(), SOURCE);
    const records = acceptanceJsonRecords(output);
    const packed = records.filter(item => item.stage === 'verified-local-only-archive');
    assert.equal(packed.length, 1);
    const pack = packed[0];
    assertV3ArchivePack(pack, network, SOURCE);
    const created = readdirSync('/tmp').filter(name => /^btc-presigned-archive-output\.[A-Za-z0-9]+$/u.test(name) && !before.has(name));
    assert.equal(created.length, 1, 'Require one unambiguous archive from this invocation');
    const archive = join('/tmp', created[0], `presigned-v3-${network}.tar.gz`);
    const actual = await fileHash(archive);
    assert(actual.sha256 === pack.archiveSha256 && actual.bytes === pack.archiveBytes);
    mkdirSync(expectedDirectory, { mode: 0o700 });
    linkSync(archive, join(expectedDirectory, assetName));
    const retention = { version: 1, protocol: PROTOCOL, kind: 'presigned-v3-public-test-evidence', network, sourceCommit: CANDIDATE,
      sourceDigest: SOURCE, toolingCommit: process.env.GITHUB_SHA, workflowRunId: process.env.GITHUB_RUN_ID,
      assetName, archiveSha256: actual.sha256, archiveBytes: actual.bytes, evidenceDigest: pack.evidenceDigest,
      files: pack.files, restoredBytesRevalidated: true, syntheticOnly: true,
      productionUsePermitted: false, realDefaultSignetVerified: false, physicalPasskeysVerified: false,
      releaseReceiptProduced: false, fundingAuthorized: false };
    assertV3Retention(retention);
    writeFileSync(join(expectedDirectory, `presigned-v3-${network}-retention.json`), `${JSON.stringify(retention, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    assert(!expectedDirectory.includes('\n'));
    appendFileSync(process.env.GITHUB_OUTPUT, `directory=${expectedDirectory}\n`);
    console.log(JSON.stringify({ stage: 'retained-for-content-review', ...retention }));
  } else {
    assert(suppliedDirectory === expectedDirectory && process.env.GH_TOKEN && process.env.GH_REPO === process.env.GITHUB_REPOSITORY);
    const stat = lstatSync(expectedDirectory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
    const retentionName = `presigned-v3-${network}-retention.json`;
    const reviewName = `presigned-v3-${network}-content-review.json`;
    const retention = readOwnedJson(join(expectedDirectory, retentionName));
    const review = readOwnedJson(join(expectedDirectory, reviewName));
    assertV3Retention(retention); assertV3ContentReview(review);
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
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
