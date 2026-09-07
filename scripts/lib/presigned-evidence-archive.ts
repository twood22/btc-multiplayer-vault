/** Local transport only. Neither an archive nor its checksum authorizes funding
 * or publication. Never recursively archive an acceptance working directory. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, createWriteStream, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { parseAcceptanceJson, readPrivateAcceptanceFile, validateLocalAcceptanceRun } from './presigned-acceptance-run.js';
import { validateRetainedImageEvidence } from './presigned-image-evidence.js';
import { IMAGE_EXECUTION_STAGES } from './presigned-image-commands.js';
import { presignedSourceDigest } from '../presigned-build-identity.mjs';

const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_TOTAL_BYTES = 8 * 1024 ** 3;
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3 - 1;
type FileRecord = { relativePath: string; bytes: number; sha256: string };
export type EvidenceArchiveKind = 'local' | 'signet-image' | 'mainnet-image';

function ownedDirectory(directory: string, privateRoot = true) {
  const stat = lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() &&
    (!privateRoot || (stat.mode & 0o077) === 0), 'archive directories must be owned, unlinked and private at the root');
}
function canonicalRoot(directory: string) {
  assert(isAbsolute(directory) && realpathSync(directory) === resolve(directory), 'use a canonical absolute archive directory');
  ownedDirectory(directory);
  return resolve(directory);
}
function relativeName(name: string) {
  assert(name.length <= 100 && name.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(part)),
    'archive members must be bounded plain relative file names');
}
function regularFile(filename: string) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES,
      'archive inputs must be bounded owned regular files, not links or devices');
    return { fd, stat };
  } catch (error) { closeSync(fd); throw error; }
}
function readOrCopy(filename: string, relativePath: string, destination?: string): FileRecord {
  const { fd, stat } = regularFile(filename);
  let output: number | undefined;
  try {
    if (destination) output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let bytes = 0;
    for (;;) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - bytes + 1), null);
      if (!length) break;
      bytes += length; assert(bytes <= stat.size, 'archive input grew during copying');
      hash.update(buffer.subarray(0, length));
      if (output !== undefined) for (let written = 0; written < length;) written += writeSync(output, buffer, written, length - written);
    }
    const after = fstatSync(fd);
    assert(bytes === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs,
      'archive input changed during copying');
    return { relativePath, bytes, sha256: hash.digest('hex') };
  } finally { if (output !== undefined) closeSync(output); closeSync(fd); }
}

async function tarCommand(args: string[], archiveOutput?: string, members?: string[]) {
  // Do not inherit TAR_OPTIONS, GZIP, shell startup files or operational secrets.
  const child = spawn('tar', args, { env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise<void>((done, fail) => {
    child.once('error', () => fail(new Error('local tar command could not start')));
    child.once('close', code => code === 0 ? done() : fail(new Error('local tar command failed; no accepted archive produced')));
  });
  // Attach a handler before streaming, including the early-spawn-error case.
  void completion.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
  const output: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) child.kill('SIGTERM'); });
  child.stdin.on('error', () => {});
  child.stdin.end(members ? Buffer.from(`${members.join('\0')}\0`) : undefined);
  try {
    if (archiveOutput) {
      const bound = new Transform({ transform(chunk: Buffer, _encoding, next) {
        stdoutBytes += chunk.length;
        next(stdoutBytes <= MAX_ARCHIVE_BYTES ? null : new Error('compressed evidence archive exceeds its bound'), chunk);
      } });
      await pipeline(child.stdout, createGzip(), bound, createWriteStream(archiveOutput, { flags: 'wx', mode: 0o600 }));
    } else {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 1024 * 1024) child.kill('SIGTERM'); else output.push(Buffer.from(chunk));
      });
    }
    await completion;
    assert(stderrBytes <= 64 * 1024 && (archiveOutput || stdoutBytes <= 1024 * 1024), 'archive command output exceeded its bound');
    return Buffer.concat(output).toString();
  } catch (error) { child.kill('SIGTERM'); await completion.catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}

/** Transport primitive, also exercised by synthetic boundary tests. The caller
 * supplies an exact allowlist and a semantic validator; this is not itself a
 * release-evidence validator or a content-privacy scanner. */
export async function archiveRegularEvidenceFiles(input: {
  directory: string; files: string[]; output: string;
  validate: (directory: string) => void | Promise<void>;
  offlineUtility?: { filename: string; sha256: string };
}) {
  const directory = canonicalRoot(input.directory);
  assert(isAbsolute(input.output) && input.output.endsWith('.tar.gz'), 'use an absolute .tar.gz output path');
  const output = resolve(input.output); const parent = canonicalRoot(dirname(output));
  assert(!output.startsWith(`${directory}/`), 'archive output must be outside its input evidence directory');
  try { lstatSync(output); throw new Error('refusing to overwrite an archive output'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const names = [...input.files].sort();
  assert(names.length > 0 && names.length <= 512 && new Set(names).size === names.length, 'invalid or duplicated archive allowlist');
  names.forEach(relativeName);
  assert(!names.includes('offline-recovery.html'), 'offline utility has a separate fixed input');
  await input.validate(directory);
  const scratch = mkdtempSync(join(parent, 'presigned-evidence-stage.'));
  const staged = join(scratch, 'evidence'); const restored = join(scratch, 'restored');
  mkdirSync(staged, { mode: 0o700 }); mkdirSync(restored, { mode: 0o700 });
  const temporaryArchive = join(scratch, 'evidence.tar.gz');
  try {
    const files: FileRecord[] = []; let totalBytes = 0;
    for (const name of names) {
      const parts = name.split('/');
      for (let length = 1; length < parts.length; length++) ownedDirectory(join(directory, ...parts.slice(0, length)), false);
      const source = join(directory, name);
      // Check the total before allocating/copying a potentially large member.
      const opened = regularFile(source); totalBytes += opened.stat.size; closeSync(opened.fd);
      assert(totalBytes <= MAX_TOTAL_BYTES, 'uncompressed evidence exceeds its archive bound');
      mkdirSync(dirname(join(staged, name)), { recursive: true, mode: 0o700 });
      files.push(readOrCopy(source, name, join(staged, name)));
    }
    if (input.offlineUtility) {
      const utility = readOrCopy(input.offlineUtility.filename, 'offline-recovery.html', join(staged, 'offline-recovery.html'));
      assert(utility.sha256 === input.offlineUtility.sha256, 'offline utility differs from the actually tested bytes');
      totalBytes += utility.bytes; assert(totalBytes <= MAX_TOTAL_BYTES); files.push(utility);
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    await input.validate(staged);
    const expectedNames = files.map(file => file.relativePath);
    await tarCommand(['--create', '--format=ustar', '--numeric-owner', '--owner=0', '--group=0', '--mtime=@0',
      '--directory', staged, '--no-recursion', '--null', '--verbatim-files-from', '--files-from=-'], temporaryArchive, expectedNames);
    const archive = readOrCopy(temporaryArchive, 'evidence.tar.gz');
    const listed = await tarCommand(['--list', '--gzip', '--file', temporaryArchive]);
    assert.deepEqual(listed.trimEnd().split('\n'), expectedNames, 'archive member list differs from the allowlist');
    // Only extract an archive we just created from fresh regular files. This is
    // deliberately not a general-purpose extractor for untrusted downloads.
    await tarCommand(['--extract', '--gzip', '--file', temporaryArchive, '--directory', restored,
      '--no-same-owner', '--no-same-permissions', '--keep-old-files']);
    for (const file of files) assert.deepEqual(readOrCopy(join(restored, file.relativePath), file.relativePath), file,
      'restored archive bytes differ from the original evidence');
    await input.validate(restored);
    assert.deepEqual(readOrCopy(temporaryArchive, 'evidence.tar.gz'), archive, 'archive changed during restore verification');
    // Atomic, no-clobber publication to a LOCAL file only; never replace a user file.
    linkSync(temporaryArchive, output);
    return { archiveSha256: archive.sha256, archiveBytes: archive.bytes, uncompressedFileBytes: totalBytes, files };
  } finally {
    // Only our fresh, exact mkdtemp scratch directory is removed. Original
    // evidence is read-only, and a successful output retains the archive inode.
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function packPresignedEvidence(kind: EvidenceArchiveKind, directory: string, output: string) {
  assert(['local', 'signet-image', 'mainnet-image'].includes(kind), 'unsupported evidence archive kind');
  const sourceDigest = presignedSourceDigest();
  let files: string[]; let offlineUtilityDigest: string; let evidenceDigest: string;
  let validate: (candidate: string) => Promise<void>;
  if (kind === 'local') {
    const run = validateLocalAcceptanceRun(directory, sourceDigest, 'local');
    evidenceDigest = run.runDigest; offlineUtilityDigest = run.offlineUtilityDigest!;
    files = ['run.json', ...run.commands.flatMap(execution => [`${execution.command.id}.stdout.log`,
      `${execution.command.id}.stderr.log`, ...execution.artifactDigests.map(artifact => artifact.relativePath)])];
    validate = async candidate => { assert.equal(validateLocalAcceptanceRun(candidate, sourceDigest, 'local').runDigest, evidenceDigest); };
  } else {
    const network = kind === 'signet-image' ? 'signet' : 'mainnet';
    const image = await validateRetainedImageEvidence(directory, sourceDigest, network);
    evidenceDigest = image.receiptDigest; offlineUtilityDigest = image.offlineUtilityDigest;
    const receipt = parseAcceptanceJson(readPrivateAcceptanceFile(`${directory}/image-acceptance.json`)) as any;
    const digests = [...new Set<string>([receipt.image.manifestDigest, receipt.image.configDigest, ...receipt.image.layerDigests])];
    assert(digests.every(digest => /^sha256:[0-9a-f]{64}$/u.test(digest)));
    files = ['image-acceptance.json', 'browser.json', 'runtime.json', 'oci/oci-layout', 'oci/index.json',
      ...IMAGE_EXECUTION_STAGES.flatMap(stage => [`${stage}.stdout.log`, `${stage}.stderr.log`]),
      ...digests.map(digest => `oci/blobs/sha256/${digest.slice(7)}`)];
    validate = async candidate => { assert.equal((await validateRetainedImageEvidence(candidate, sourceDigest, network)).receiptDigest, evidenceDigest); };
  }
  const archive = await archiveRegularEvidenceFiles({ directory, files, output,
    // The local suite builds/tests this standalone utility. Image jobs already
    // retain its exact bytes in their verified OCI layers, not on the host.
    offlineUtility: kind === 'local' ? { filename: resolve('public/offline/presigned-recovery.html'), sha256: offlineUtilityDigest } : undefined,
    validate: async candidate => {
      assert.equal(presignedSourceDigest(), sourceDigest, 'source changed while packaging acceptance evidence');
      await validate(candidate);
      assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during archive evidence validation');
    } });
  return { passed: true, kind: 'presigned-v2-local-evidence-archive', evidenceKind: kind, sourceDigest, evidenceDigest,
    archiveSha256: archive.archiveSha256, archiveBytes: archive.archiveBytes, files: archive.files.length,
    restoredBytesRevalidated: true, contentPrivacyReviewed: false, published: false, realDefaultSignetVerified: false,
    releaseReceiptProduced: false, fundingAuthorized: false };
}
