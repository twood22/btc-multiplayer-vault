/** Synthetic transport boundaries only, never a real acceptance dossier. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveRegularEvidenceFiles, packPresignedEvidence } from './lib/presigned-evidence-archive.js';

export async function runEvidenceArchiveBoundaryTests() {
  const root = mkdtempSync('/tmp/btc-presigned-synthetic-archive.');
  const input = `${root}/input`; const output = `${root}/output`;
  mkdirSync(input, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  mkdirSync(`${input}/oci`, { mode: 0o700 }); mkdirSync(`${input}/wallet`, { mode: 0o700 });
  const marker = 'SYNTHETIC TRANSPORT FIXTURE - NOT ACCEPTANCE EVIDENCE\n';
  const bytes = Buffer.from([0, 1, 2, 255, 128, 10]);
  writeFileSync(`${input}/receipt.json`, marker, { mode: 0o600, flag: 'wx' });
  writeFileSync(`${input}/oci/layer`, bytes, { mode: 0o600, flag: 'wx' });
  writeFileSync(`${input}/wallet/excluded.txt`, 'SYNTHETIC EXCLUSION MARKER', { mode: 0o600, flag: 'wx' });
  let validations = 0; let negatives = 0;
  const validate = async (directory: string) => {
    assert.equal(readFileSync(`${directory}/receipt.json`, 'utf8'), marker);
    assert.deepEqual(readFileSync(`${directory}/oci/layer`), bytes);
    if (directory !== input) {
      assert.deepEqual(readdirSync(directory).sort(), ['oci', 'receipt.json']);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      assert.equal(lstatSync(`${directory}/receipt.json`).mode & 0o777, 0o600);
    }
    validations++;
  };
  const request = { directory: input, files: ['receipt.json', 'oci/layer'], output: `${output}/valid.tar.gz`, validate };
  const result = await archiveRegularEvidenceFiles(request);
  assert.equal(validations, 3); // Original, private projection, actual restored archive.
  assert.equal(result.archiveSha256, createHash('sha256').update(readFileSync(request.output)).digest('hex'));
  assert.equal(lstatSync(request.output).mode & 0o777, 0o600);
  assert.equal(lstatSync(request.output).nlink, 1);
  assert.equal(result.files.length, 2);
  assert.equal(existsSync(`${input}/wallet/excluded.txt`), true);
  assert.deepEqual(readdirSync(output), ['valid.tar.gz']);
  const utilityFilename = `${root}/synthetic-offline.html`;
  const utilityBytes = 'SYNTHETIC NON-EXECUTABLE OFFLINE ARTIFACT';
  writeFileSync(utilityFilename, utilityBytes, { mode: 0o600, flag: 'wx' });
  const utilitySha256 = createHash('sha256').update(utilityBytes).digest('hex');
  const utilityRequest = { ...request, output: `${output}/utility.tar.gz`,
    offlineUtility: { filename: utilityFilename, sha256: utilitySha256 },
    validate: async (directory: string) => {
      assert.equal(readFileSync(`${directory}/receipt.json`, 'utf8'), marker);
      if (directory !== input) assert.equal(readFileSync(`${directory}/offline-recovery.html`, 'utf8'), utilityBytes);
    } };
  const utilityArchive = await archiveRegularEvidenceFiles(utilityRequest);
  assert(utilityArchive.files.some(file => file.relativePath === 'offline-recovery.html' && file.sha256 === utilitySha256));
  await assert.rejects(archiveRegularEvidenceFiles({ ...utilityRequest, output: `${output}/wrong-utility.tar.gz`,
    offlineUtility: { filename: utilityFilename, sha256: '00'.repeat(32) } }), /offline utility differs/); negatives++;
  assert.equal(existsSync(`${output}/wrong-utility.tar.gz`), false);
  const refused = async (overrides: Partial<typeof request>, expected?: RegExp) => {
    const candidate = { ...request, output: `${output}/rejected-${negatives}.tar.gz`, ...overrides };
    if (expected) await assert.rejects(archiveRegularEvidenceFiles(candidate), expected);
    else await assert.rejects(archiveRegularEvidenceFiles(candidate));
    if (candidate.output !== request.output) assert.equal(existsSync(candidate.output), false);
    negatives++;
  };
  await refused({ output: request.output }, /overwrite/);
  await refused({ files: ['../outside'] });
  await refused({ files: ['/absolute'] });
  await refused({ files: ['oci/../receipt.json'] });
  await refused({ files: ['receipt.json', 'receipt.json'] });
  await refused({ files: ['receipt.json\nwallet'] });
  await refused({ files: ['--checkpoint-action=exec'] });
  await refused({ output: `${input}/inside.tar.gz` });
  symlinkSync(input, `${root}/input-link`);
  await refused({ directory: `${root}/input-link` });
  await refused({ validate: async () => { throw new Error('synthetic semantic refusal'); } }, /semantic refusal/);
  let lastValidation = 0;
  await refused({ validate: async directory => { await validate(directory); if (++lastValidation === 3) throw new Error('restored semantic refusal'); } }, /restored semantic refusal/);
  symlinkSync(`${input}/receipt.json`, `${input}/linked.json`);
  await refused({ files: ['linked.json'], validate: async () => {} });
  symlinkSync(`${input}/oci`, `${input}/linked-dir`);
  await refused({ files: ['linked-dir/layer'], validate: async () => {} });
  linkSync(`${input}/receipt.json`, `${input}/hardlinked.json`);
  await refused({ files: ['hardlinked.json'], validate: async () => {} });
  await refused({ files: ['oci'], validate: async () => {} });
  chmodSync(output, 0o755);
  await refused({ files: ['oci/layer'], validate: async () => {} });
  chmodSync(output, 0o700);
  chmodSync(input, 0o755);
  await refused({ files: ['oci/layer'], validate: async () => {} });
  chmodSync(input, 0o700);
  const refusalOutput = `${output}/not-real-evidence.tar.gz`;
  await assert.rejects(packPresignedEvidence('local', input, refusalOutput)); negatives++;
  assert.equal(existsSync(refusalOutput), false);
  assert.deepEqual(readdirSync(output).sort(), ['utility.tar.gz', 'valid.tar.gz']);
  return { passed: true, syntheticTransportFixtures: true, negativeBoundaries: negatives,
    restoredArchiveBytesVerified: true, unlistedWalletDirectoryExcluded: true, networkRequests: 0,
    actualLocalDossierPacked: false, actualImageDossierPacked: false, publicationAuthorized: false, fundingAuthorized: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  console.log(JSON.stringify(await runEvidenceArchiveBoundaryTests()));
}
