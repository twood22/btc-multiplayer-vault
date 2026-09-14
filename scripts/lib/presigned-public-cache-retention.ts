/** Exact, recoverable retention of duplicate PUBLIC cache files. Never wallets.
 * No automatic cleanup: verify is read-only; prepare and both mutations are explicit.
 * The retained keeper is never chmodded, linked, moved, overwritten or deleted.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireLifecycleProcessLock } from './presigned-lifecycle-lock.js';
import { assertNoOwnedProcessUsesDatadir, withStoppedCoreDataDirectoryLock } from './presigned-signet-cache.js';
import { privateJournalDirectory, readPrivateJournalBytes, syncPrivateJournalDirectory, writePrivateJournalBytes } from './presigned-durable-journal.js';

const REPO = '/home/codex/btc-multiplayer-vault';
const PREFIX = 'presigned-v2-signet-host.VERfpj';
const NAMES = ['blk', 'rev'].flatMap(prefix => Array.from({ length: 145 }, (_, i) => `${prefix}${String(i).padStart(5, '0')}.dat`));
const EXPECTED_CONTENT = '123267f4f869f67071ffd1beb8b30e6daf1cb8145396500bac6cdb29c2ef88a4';
const MAX_FILE = 134_217_728;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value);
interface Scope {
  kind: 'verified-verfpj-drill-public-cache-v1' | 'synthetic-retention-test-v1';
  target: string; keeper: string; records: string; protectedRoots: string[];
}
type Metadata = { dev: string; ino: string; size: string; mode: string; uid: string; gid: string; mtimeNs: string; ctimeNs: string; nlink: string };
interface Entry { name: string; size: number; sha256: string; target: Metadata; keeper: Metadata }
interface ProtectedEntry { path: string; metadata: Metadata; sha256: string | null }
export interface PublicCacheRetentionManifest {
  version: 1; kind: 'exact-public-cache-retention'; scope: Scope; createdAt: string;
  entries: Entry[]; protectedEntries: ProtectedEntry[]; bytes: number; contentManifestSha256: string;
  requiredKeeperRetention: true; preservedInodesOnRestore: false; preservedCtimesOnRestore: false;
  manifestDigest: string;
}
export function productionPublicCacheRetentionScope(): Scope {
  const live = `${REPO}/live-run`; const base = `${live}/${PREFIX}`;
  return { kind: 'verified-verfpj-drill-public-cache-v1', target: `${base}.retained-unfunded-drill-1/core/signet`,
    keeper: `${base}.retained-unfunded-drill-2/core/signet`, records: `${live}/public-cache-retention-verfpj`,
    protectedRoots: [`${base}.retained-unfunded-drill-1`, `${base}.retained-unfunded-drill-2`, base,
      `${live}/presigned-v2-signet-backup.ethQLo`, `${live}/presigned-v2-signet-anchor.6aHTJ9`] };
}
/** Only isolated, bounded fixtures; the production CLI never accepts this scope. */
export function syntheticPublicCacheRetentionScope(root: string): Scope {
  assert(/^\/tmp\/btc-public-cache-retention-test\.[A-Za-z0-9]{6}$/u.test(root));
  privateJournalDirectory(root, false);
  return { kind: 'synthetic-retention-test-v1', target: `${root}/target/core/signet`, keeper: `${root}/keeper/core/signet`,
    records: `${root}/records`, protectedRoots: [`${root}/target`, `${root}/keeper`, `${root}/custody`] };
}
function validateScope(scope: Scope) {
  const expected = scope.kind === 'verified-verfpj-drill-public-cache-v1' ? productionPublicCacheRetentionScope()
    : syntheticPublicCacheRetentionScope(dirname(scope.records));
  assert.deepEqual(scope, expected, 'cache retention scope is not the exact approved profile');
  for (const root of scope.protectedRoots) privateJournalDirectory(root, false);
  for (const path of [scope.target, scope.keeper, `${scope.target}/blocks`, `${scope.keeper}/blocks`]) privateJournalDirectory(path, false);
  assertNoOwnedProcessUsesDatadir(dirname(scope.target)); assertNoOwnedProcessUsesDatadir(dirname(scope.keeper));
}
function metadata(path: string): Metadata {
  assert(path === resolve(path) && realpathSync(path) === path, 'cache retention refuses aliases');
  const s = lstatSync(path, { bigint: true });
  assert(!s.isSymbolicLink() && (s.isFile() || s.isDirectory()) && s.uid === BigInt(process.getuid!()) &&
    (s.mode & 0o077n) === 0n && (s.isDirectory() || s.nlink === 1n), 'cache retention refuses aliases, special files or unsafe ownership');
  return Object.fromEntries(['dev','ino','size','mode','uid','gid','mtimeNs','ctimeNs','nlink'].map(k =>
    [k, String(s[k as keyof typeof s])])) as Metadata;
}
function openFile(path: string) {
  const before = metadata(path); assert(Number(before.size) <= MAX_FILE, 'public cache file exceeds its bound');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NOATIME);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assert(stat.isFile() && String(stat.dev) === before.dev && String(stat.ino) === before.ino && stat.nlink === 1n,
      'cache file changed while opening');
    return { fd, before };
  } catch (error) { closeSync(fd); throw error; }
}
function hashFd(fd: number) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(8 * 1024 * 1024, fstatSync(fd).size))); let offset = 0;
  for (;;) { const length = readSync(fd, buffer, 0, buffer.length, offset); if (!length) break;
    offset += length; assert(offset <= MAX_FILE); hash.update(buffer.subarray(0, length)); }
  return hash.digest('hex');
}
function hashFile(path: string) {
  const { fd, before } = openFile(path);
  try { const digest = hashFd(fd); assert.deepEqual(metadata(path), before, 'cache file changed while hashing');
    return { sha256: digest, metadata: before }; } finally { closeSync(fd); }
}
function movedMetadata(actual: Metadata, expected: Metadata) {
  const { ctimeNs: _a, ...a } = actual; const { ctimeNs: _b, ...b } = expected;
  assert.deepEqual(a, b, 'quarantined original changed its inode, bytes or restorable metadata');
}
function quarantine(scope: Scope, digest: string, name: string) { return `${scope.target}/blocks/.retained-${digest}-${name}`; }
function restorePartial(scope: Scope, digest: string, name: string) { return `${scope.target}/blocks/.restore-${digest}-${name}`; }
function protectedSnapshot(scope: Scope, digest?: string): ProtectedEntry[] {
  const entries: ProtectedEntry[] = []; const blockRoots = [scope.target, scope.keeper].map(root => `${root}/blocks`);
  const targetFiles = new Set(blockRoots.flatMap(root => NAMES.map(name => `${root}/${name}`)));
  const allowedTemporary = digest ? new Set(NAMES.flatMap(name => [quarantine(scope, digest, name), restorePartial(scope, digest, name)])) : new Set<string>();
  function visit(path: string) {
    if (targetFiles.has(path) || allowedTemporary.has(path)) return;
    const before = metadata(path); const stat = lstatSync(path);
    assert(entries.length < 100_000, 'protected inventory exceeds its bound');
    // Only these two directory mtimes/ctimes/sizes change as exact children are removed/restored.
    const stable = blockRoots.includes(path) ? { ...before, size: '0', mtimeNs: '0', ctimeNs: '0', nlink: '0' } : before;
    const publicCache = /\/core\/signet\/(?:chainstate|indexes|blocks\/index)(?:\/|$)/u.test(path) ||
      (/\/core\/signet\/blocks\/(?:blk|rev)[0-9]{5}\.dat$/u.test(path) && !/\/(?:blk|rev)00145\.dat$/u.test(path));
    const digest = stat.isFile() && !publicCache ? hashFile(path).sha256 : null;
    entries.push({ path, metadata: stable, sha256: digest });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(`${path}/${name}`);
  }
  for (const root of scope.protectedRoots) visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function underCoreLocks<T>(scope: Scope, action: (assertHeld: () => void) => Promise<T>) {
  validateScope(scope);
  return withStoppedCoreDataDirectoryLock(scope.target, async targetHeld =>
    withStoppedCoreDataDirectoryLock(scope.keeper, async keeperHeld => {
      const locks = [scope.target, scope.keeper].map(root => {
        const path = `${root}/.lock`; const identity = metadata(path);
        return { path, identity, holder: kernelCoreLockHolder(identity) };
      });
      const assertHeld = () => {
        targetHeld(); keeperHeld();
        // The hashing/copy loop is synchronous: ChildProcess exit callbacks may
        // not have run yet. Read current kernel ownership, not only cached flags.
        for (const lock of locks) {
          assert.deepEqual(metadata(lock.path), lock.identity, 'Core lock inode or metadata changed');
          assert.equal(kernelCoreLockHolder(lock.identity, lock.holder), lock.holder, 'Core kernel lock ownership changed');
        }
      };
      validateScope(scope); assertHeld(); const result = await action(assertHeld);
      targetHeld(); keeperHeld(); validateScope(scope); return result;
    }));
}
function kernelCoreLockHolder(identity: Metadata, expectedHolder?: string) {
  assert(process.platform === 'linux', 'this exact retention profile requires Linux kernel lock verification');
  const dev = BigInt(identity.dev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  const holders = readFileSync('/proc/locks', 'utf8').trim().split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/u);
    if (fields[1] !== 'POSIX' || fields[2] !== 'ADVISORY' || fields[3] !== 'WRITE' || fields[6] !== '0' || fields[7] !== 'EOF') return [];
    const [ma, mi, inode] = fields[5]!.split(':');
    return inode === identity.ino && BigInt(`0x${ma}`) === major && BigInt(`0x${mi}`) === minor ? [fields[4]!] : [];
  });
  if (holders.length !== 1) {
    let helperState = 'unknown';
    if (expectedHolder) {
      try { helperState = readFileSync(`/proc/${expectedHolder}/status`, 'utf8').split('\n').find(line => line.startsWith('State:')) ?? 'unknown'; }
      catch (error) { helperState = (error as NodeJS.ErrnoException).code ?? 'unreadable'; }
    }
    throw new Error(`exact Core POSIX lock is not currently held; matches=${holders.length}; expectedHelper=${expectedHolder ?? 'acquiring'}; helperState=${helperState}`);
  }
  const holder = holders[0]!; assert(/^[1-9][0-9]*$/u.test(holder));
  assert.equal(lstatSync(`/proc/${holder}`).uid, process.getuid!());
  assert(readFileSync(`/proc/${holder}/status`, 'utf8').split('\n').includes(`PPid:\t${process.pid}`),
    'Core lock holder is not our direct helper');
  return holder;
}
async function underOperationLock<T>(scope: Scope, create: boolean, action: (assertHeld: () => void) => Promise<T>) {
  validateScope(scope);
  if (!existsSync(scope.records)) { assert(create, 'prepare a protected retention record first');
    mkdirSync(scope.records, { mode: 0o700 }); syncPrivateJournalDirectory(dirname(scope.records)); }
  privateJournalDirectory(scope.records, false);
  const lock = acquireLifecycleProcessLock(scope.records, sha(encoded(scope)));
  const identity = metadata(`${scope.records}/active.lock`);
  try { return await underCoreLocks(scope, coreHeld => action(() => {
    coreHeld(); assert.deepEqual(metadata(`${scope.records}/active.lock`), identity, 'retention operation lock inode changed');
  })); } finally { lock.release(); }
}
function manifestBody(manifest: PublicCacheRetentionManifest) { const { manifestDigest: _digest, ...body } = manifest; return body; }
async function buildManifest(scope: Scope, assertHeld: () => void): Promise<PublicCacheRetentionManifest> {
  const before = protectedSnapshot(scope); const entries: Entry[] = [];
  for (const name of NAMES) {
    assertHeld();
    const target = hashFile(`${scope.target}/blocks/${name}`); const keeper = hashFile(`${scope.keeper}/blocks/${name}`);
    assert(target.sha256 === keeper.sha256 && target.metadata.size === keeper.metadata.size, `not an exact duplicate: ${name}`);
    entries.push({ name, size: Number(target.metadata.size), sha256: target.sha256, target: target.metadata, keeper: keeper.metadata });
  }
  assertHeld(); assert.deepEqual(protectedSnapshot(scope), before, 'protected custody or non-target files changed during verification');
  const contentManifestSha256 = sha(encoded(entries.map(({ name, size, sha256 }) => ({ name, size, sha256 }))));
  if (scope.kind === 'verified-verfpj-drill-public-cache-v1') assert.equal(contentManifestSha256, EXPECTED_CONTENT,
    'public cache differs from the independently reviewed duplicate set');
  const body = { version: 1 as const, kind: 'exact-public-cache-retention' as const, scope, createdAt: new Date().toISOString(),
    entries, protectedEntries: before, bytes: entries.reduce((sum, item) => sum + item.size, 0), contentManifestSha256,
    requiredKeeperRetention: true as const, preservedInodesOnRestore: false as const, preservedCtimesOnRestore: false as const };
  return { ...body, manifestDigest: sha(encoded(body)) };
}
export async function verifyPublicCacheRetention(scope = productionPublicCacheRetentionScope()) {
  return underCoreLocks(scope, assertHeld => buildManifest(scope, assertHeld));
}
function record(scope: Scope, digest: string, kind: string) { return `${scope.records}/${digest}.${kind}`; }
function protectedWrite(path: string, value: Buffer) {
  writePrivateJournalBytes(path, value);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o400); fsyncSync(fd); } finally { closeSync(fd); }
  syncPrivateJournalDirectory(dirname(path));
}
function recipe(manifest: PublicCacheRetentionManifest) {
  return `Public cache retention ${manifest.manifestDigest}\n\n` +
    `REQUIRED KEEPER: ${manifest.scope.keeper}/blocks. Never remove or modify these retained files.\n` +
    `Only the ${NAMES.length} exact manifest members may be reclaimed. Keep blk00145.dat, rev00145.dat, xor.dat, locks, indexes, chainstate and ALL custody.\n` +
    `Restore only absent targets with this exact command:\n` +
    `cd ${REPO} && node --import tsx ${REPO}/scripts/presigned-public-cache-retention.mts restore --manifest=${record(manifest.scope, manifest.manifestDigest, 'manifest.json')} --approve=${manifest.manifestDigest}\n` +
    `The tool rechecks keeper hashes, takes both Core locks, copies atomically without overwrite, fsyncs, and restores mode/uid/gid/mtime.\n` +
    `Interrupted operations resume with the same command and approval. Verified quarantined originals are moved back; verified partial copies are appended only after an exact prefix comparison. Unknown or changed partials are retained and refused, never discarded.\n` +
    `Original inode numbers and ctimes CANNOT be restored. The historical cache is incomplete until restoration. No historical custody or evidence is rewritten.\n`;
}
export async function preparePublicCacheRetention(scope = productionPublicCacheRetentionScope()) {
  return underOperationLock(scope, true, async assertHeld => {
    const manifest = await buildManifest(scope, assertHeld); const digest = manifest.manifestDigest;
    const manifestPath = record(scope, digest, 'manifest.json'); const restoreRecipe = Buffer.from(recipe(manifest));
    assertHeld(); protectedWrite(manifestPath, Buffer.from(encoded(manifest)));
    protectedWrite(record(scope, digest, 'restore.txt'), restoreRecipe);
    protectedWrite(record(scope, digest, 'ready.json'), Buffer.from(encoded({ manifestDigest: digest,
      manifestFileSha256: sha(encoded(manifest)), restoreRecipeSha256: sha(restoreRecipe), requiredKeeperRetention: true })));
    return { manifestPath, manifestDigest: digest, bytes: manifest.bytes, files: manifest.entries.length, changedCacheFiles: 0 };
  });
}
function loadManifest(scope: Scope, path: string, approvedDigest: string) {
  assert(/^[0-9a-f]{64}$/u.test(approvedDigest), 'explicit exact manifest approval is required');
  assert.equal(path, record(scope, approvedDigest, 'manifest.json'), 'manifest escaped its exact retention scope');
  const raw = readPrivateJournalBytes(path); const manifest = JSON.parse(raw.toString()) as PublicCacheRetentionManifest;
  assert.equal(manifest.manifestDigest, approvedDigest); assert.equal(sha(encoded(manifestBody(manifest))), approvedDigest);
  assert.equal(encoded(manifest), raw.toString(), 'manifest is not canonical'); assert.deepEqual(manifest.scope, scope);
  assert(manifest.version === 1 && manifest.kind === 'exact-public-cache-retention' && manifest.requiredKeeperRetention === true &&
    manifest.preservedInodesOnRestore === false && manifest.preservedCtimesOnRestore === false);
  assert.deepEqual(manifest.entries.map(item => item.name), NAMES, 'manifest attempts a different file set or wallet target');
  assert.equal(sha(encoded(manifest.entries.map(({ name, size, sha256 }) => ({ name, size, sha256 })))), manifest.contentManifestSha256);
  if (scope.kind === 'verified-verfpj-drill-public-cache-v1') assert.equal(manifest.contentManifestSha256, EXPECTED_CONTENT);
  for (const entry of manifest.entries) assert(/^[0-9a-f]{64}$/u.test(entry.sha256) && Number.isSafeInteger(entry.size) &&
    entry.size > 0 && entry.size <= MAX_FILE && Number(entry.target.size) === entry.size && Number(entry.keeper.size) === entry.size);
  assert.equal(manifest.bytes, manifest.entries.reduce((sum, item) => sum + item.size, 0));
  const ready = JSON.parse(readPrivateJournalBytes(record(scope, approvedDigest, 'ready.json')).toString());
  assert.deepEqual(ready, { manifestDigest: approvedDigest, manifestFileSha256: sha(raw),
    restoreRecipeSha256: sha(Buffer.from(recipe(manifest))), requiredKeeperRetention: true });
  assert.equal(readPrivateJournalBytes(record(scope, approvedDigest, 'restore.txt')).toString(), recipe(manifest));
  return manifest;
}
function assertKeeper(scope: Scope, entry: Entry) {
  const actual = hashFile(`${scope.keeper}/blocks/${entry.name}`);
  assert.equal(actual.sha256, entry.sha256, 'retained keeper changed');
  assert.deepEqual(actual.metadata, entry.keeper, 'retained keeper metadata changed');
}
function assertProtected(scope: Scope, manifest: PublicCacheRetentionManifest) {
  assert.deepEqual(protectedSnapshot(scope, manifest.manifestDigest), manifest.protectedEntries,
    'custody, unique tail, index or other protected metadata changed');
}
function assertKeeperMetadata(scope: Scope, manifest: PublicCacheRetentionManifest) {
  for (const entry of manifest.entries) assert.deepEqual(metadata(`${scope.keeper}/blocks/${entry.name}`), entry.keeper,
    'retained keeper changed during the operation');
}
function noReplaceMove(from: string, to: string) {
  execFileSync('/usr/bin/mv', ['--no-copy','--no-clobber','--no-target-directory','--',from,to], { stdio: 'ignore' });
  assert(!existsSync(from) && existsSync(to), 'atomic no-overwrite move refused; retained original/partial files');
  syncPrivateJournalDirectory(dirname(to));
}
/** Explicit approval authorizes only these exact duplicated public bytes. */
export async function reclaimPublicCacheRetention(input: { manifestPath: string; approvedDigest: string },
  scope = productionPublicCacheRetentionScope()) {
  return underOperationLock(scope, false, async assertHeld => {
    const manifest = loadManifest(scope, input.manifestPath, input.approvedDigest); assertProtected(scope, manifest);
    const intentPath = record(scope, manifest.manifestDigest, 'reclaim-intent.json');
    const intent = { manifestDigest: manifest.manifestDigest, requiredKeeperRetention: true, files: NAMES };
    const resumed = existsSync(intentPath);
    if (resumed) assert.deepEqual(JSON.parse(readPrivateJournalBytes(intentPath).toString()), intent);
    // Check EVERY keeper and every present original before the first removal.
    for (const entry of manifest.entries) {
      assertHeld();
      assertKeeper(scope, entry); const target = `${scope.target}/blocks/${entry.name}`;
      assert(!existsSync(restorePartial(scope, manifest.manifestDigest, entry.name)), 'restore is in progress; resume restore, not reclaim');
      const q = quarantine(scope, manifest.manifestDigest, entry.name);
      if (existsSync(target)) { assert(!existsSync(q), 'both original and quarantined duplicate exist');
        const file = hashFile(target); assert.equal(file.sha256, entry.sha256); assert.deepEqual(file.metadata, entry.target); }
      else { assert(resumed, 'an original disappeared before a durable reclaim intent');
        if (existsSync(q)) { const file = hashFile(q); assert.equal(file.sha256, entry.sha256); movedMetadata(file.metadata, entry.target); } }
    }
    assertProtected(scope, manifest); assertKeeperMetadata(scope, manifest);
    assertHeld(); if (!resumed) protectedWrite(intentPath, Buffer.from(encoded(intent)));
    let removedFiles = 0;
    for (const entry of manifest.entries) {
      assertHeld(); validateScope(scope); assertKeeper(scope, entry);
      const target = `${scope.target}/blocks/${entry.name}`; const q = quarantine(scope, manifest.manifestDigest, entry.name);
      if (existsSync(target)) {
        const original = openFile(target);
        try { assert.deepEqual(original.before, entry.target); assert.equal(hashFd(original.fd), entry.sha256);
          assert.deepEqual(metadata(target), original.before, 'original replaced before quarantine');
          assertHeld(); noReplaceMove(target, q);
          const moved = hashFile(q); movedMetadata(moved.metadata, original.before); assert.equal(moved.sha256, entry.sha256);
        } finally { closeSync(original.fd); }
      }
      if (existsSync(q)) {
        const held = openFile(q);
        try { movedMetadata(held.before, entry.target); assert.equal(hashFd(held.fd), entry.sha256);
          assert.deepEqual(metadata(q), held.before, 'quarantine replaced before unlink');
          assertHeld(); unlinkSync(q); syncPrivateJournalDirectory(`${scope.target}/blocks`); removedFiles++; }
        finally { closeSync(held.fd); }
      }
    }
    assertHeld(); assertProtected(scope, manifest); assertKeeperMetadata(scope, manifest);
    const completed = { manifestDigest: manifest.manifestDigest, files: NAMES.length, retainedBytes: manifest.bytes,
      requiredKeeperRetention: true, originalInodesCannotBeRestored: true, custodyUnchanged: true };
    const resultPath = record(scope, manifest.manifestDigest, 'reclaimed.json');
    if (!existsSync(resultPath)) protectedWrite(resultPath, Buffer.from(encoded(completed)));
    return { ...completed, removedFilesThisInvocation: removedFiles };
  });
}
function restoredMetadata(actual: Metadata, original: Metadata) {
  for (const key of ['size','mode','uid','gid'] as const) assert.equal(actual[key], original[key]);
  // Node utimes has microsecond resolution; original fractional nanoseconds
  // need the exact native touch command below, not floating-point timestamps.
  assert.equal(actual.mtimeNs, original.mtimeNs, 'restored mtime differs');
}
function checkPartialPrefix(scope: Scope, entry: Entry, path: string) {
  const partial = openFile(path); const source = openFile(`${scope.keeper}/blocks/${entry.name}`);
  try {
    assert.deepEqual(source.before, entry.keeper); const size = Number(partial.before.size);
    assert(size <= entry.size, 'retained restore partial exceeds original size');
    const left = Buffer.allocUnsafe(Math.max(1, Math.min(8 * 1024 * 1024, size))); const right = Buffer.allocUnsafe(left.length);
    for (let offset = 0; offset < size;) {
      const count = Math.min(left.length, size - offset);
      assert.equal(readSync(partial.fd, left, 0, count, offset), count);
      assert.equal(readSync(source.fd, right, 0, count, offset), count);
      assert(left.subarray(0, count).equals(right.subarray(0, count)), 'retained restore partial differs; retained for manual review');
      offset += count;
    }
    assert.deepEqual(metadata(path), partial.before, 'restore partial changed during prefix verification');
    assert.deepEqual(metadata(`${scope.keeper}/blocks/${entry.name}`), source.before);
    return partial.before;
  } finally { closeSync(partial.fd); closeSync(source.fd); }
}
export async function restorePublicCacheRetention(input: { manifestPath: string; approvedDigest: string },
  scope = productionPublicCacheRetentionScope()) {
  return underOperationLock(scope, false, async assertHeld => {
    const manifest = loadManifest(scope, input.manifestPath, input.approvedDigest); assertProtected(scope, manifest);
    const reclaimIntent = { manifestDigest: manifest.manifestDigest, requiredKeeperRetention: true, files: NAMES };
    const reclaimIntentPath = record(scope, manifest.manifestDigest, 'reclaim-intent.json');
    const restoreIntentPath = record(scope, manifest.manifestDigest, 'restore-intent.json');
    const restoreIntent = { manifestDigest: manifest.manifestDigest, requiredKeeperRetention: true, absentTargetsOnly: true, files: NAMES };
    const resumed = existsSync(restoreIntentPath);
    if (resumed) assert.deepEqual(JSON.parse(readPrivateJournalBytes(restoreIntentPath).toString()), restoreIntent);
    for (const entry of manifest.entries) { assertHeld(); assertKeeper(scope, entry);
      const path = `${scope.target}/blocks/${entry.name}`;
      const q = quarantine(scope, manifest.manifestDigest, entry.name);
      const partial = restorePartial(scope, manifest.manifestDigest, entry.name);
      if (existsSync(path)) { const existing = hashFile(path); assert.equal(existing.sha256, entry.sha256,
        'restore refuses an occupied, different target'); restoredMetadata(existing.metadata, entry.target);
        assert(!existsSync(q) && !existsSync(partial), 'occupied target also has a retained quarantine or partial');
      } else {
        assert.deepEqual(JSON.parse(readPrivateJournalBytes(reclaimIntentPath).toString()), reclaimIntent,
          'missing target has no exact durable reclaim intent');
        assert(!(existsSync(q) && existsSync(partial)), 'both quarantine and restore partial exist');
        if (existsSync(q)) { const held = hashFile(q); assert.equal(held.sha256, entry.sha256); movedMetadata(held.metadata, entry.target); }
        if (existsSync(partial)) { assert(resumed, 'restore partial predates a durable restore intent'); checkPartialPrefix(scope, entry, partial); }
      }
    }
    assertHeld(); assertProtected(scope, manifest); assertKeeperMetadata(scope, manifest);
    if (!resumed) protectedWrite(restoreIntentPath, Buffer.from(encoded(restoreIntent)));
    let restoredFiles = 0;
    for (const entry of manifest.entries) {
      const target = `${scope.target}/blocks/${entry.name}`; if (existsSync(target)) continue;
      assertHeld(); validateScope(scope); assertKeeper(scope, entry);
      const q = quarantine(scope, manifest.manifestDigest, entry.name);
      if (existsSync(q)) {
        const held = hashFile(q); assert.equal(held.sha256, entry.sha256); movedMetadata(held.metadata, entry.target);
        assertHeld(); noReplaceMove(q, target); restoredMetadata(metadata(target), entry.target); restoredFiles++; continue;
      }
      const temporary = restorePartial(scope, manifest.manifestDigest, entry.name);
      const before = existsSync(temporary) ? checkPartialPrefix(scope, entry, temporary) : null;
      const source = openFile(`${scope.keeper}/blocks/${entry.name}`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_NOFOLLOW |
        (before ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
      try {
        if (before) assert.deepEqual(metadata(temporary), before);
        const current = fstatSync(fd, { bigint: true }); const onDisk = metadata(temporary);
        assert.equal(String(current.ino), onDisk.ino); assert.equal(String(current.dev), onDisk.dev);
        assert.deepEqual(source.before, entry.keeper);
        const buffer = Buffer.allocUnsafe(Math.min(8 * 1024 * 1024, entry.size)); let offset = Number(before?.size ?? 0);
        for (;;) { const count = readSync(source.fd, buffer, 0, buffer.length, offset); if (!count) break;
          assert(offset + count <= entry.size, 'keeper grew during restore; retained bounded partial');
          let written = 0; while (written < count) {
            const length = writeSync(fd, buffer, written, count - written, offset + written);
            assert(length > 0, 'restore copy made no progress; retained partial'); written += length;
          }
          offset += count;
        }
        assert.equal(offset, entry.size); fchownSync(fd, Number(entry.target.uid), Number(entry.target.gid));
        fchmodSync(fd, Number(entry.target.mode) & 0o7777); fsyncSync(fd);
      } finally { closeSync(fd); closeSync(source.fd); }
      assert.equal(hashFile(temporary).sha256, entry.sha256, 'keeper changed during restore copy');
      const mtime = BigInt(entry.target.mtimeNs); const stamp = `@${mtime / 1_000_000_000n}.${String(mtime % 1_000_000_000n).padStart(9, '0')}`;
      execFileSync('/usr/bin/touch', ['--no-dereference','--no-create','-m',`--date=${stamp}`,'--',temporary], { stdio: 'ignore' });
      const syncFd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(syncFd); } finally { closeSync(syncFd); }
      restoredMetadata(metadata(temporary), entry.target);
      assertHeld(); noReplaceMove(temporary, target); restoredMetadata(metadata(target), entry.target); restoredFiles++;
    }
    assertHeld(); assertProtected(scope, manifest); assertKeeperMetadata(scope, manifest);
    return { manifestDigest: manifest.manifestDigest, restoredFiles, restoredBytes: manifest.bytes,
      overwrittenFiles: 0, originalInodesRestored: false, originalCtimesRestored: false, custodyUnchanged: true };
  });
}
