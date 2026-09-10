/** Private paired checkpoints for isolated acceptance custody. Never public evidence.
 * A checkpoint is committed to the independent store and its primary watermark
 * before a caller may release signatures or send exact saved transactions.
 * Loss or rollback of either side is a refusal, not permission to reinitialize.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const MAXIMUM_FILE_BYTES = 4_000_000;
const MAXIMUM_TOTAL_BYTES = 128 * 1024 * 1024;
const MAXIMUM_ENTRIES = 20_000;
const FENCES = '.checkpoint-fences';
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => `${JSON.stringify(value)}\n`;
interface Identity {
  version: 1; kind: 'presigned-isolated-paired-journal'; journalId: string; createdAt: string;
  sourceDigest: string; chain: 'default-Signet' | 'isolated-regtest'; actualGenesisHash: string;
}
interface Entry { path: string; bytes: number; sha256: string }
interface Snapshot {
  version: 1; kind: 'presigned-isolated-complete-checkpoint'; journalIdentityDigest: string;
  sequence: number; previousCheckpointDigest: string | null; reason: string; createdAt: string;
  directories: string[]; files: Entry[]; totalBytes: number; checkpointDigest: string;
}
type Binding = Pick<Identity, 'sourceDigest' | 'chain' | 'actualGenesisHash'>;

export function privateJournalDirectory(directory: string, persistent: boolean) {
  assert(directory === resolve(directory) && realpathSync(directory) === directory, 'journal path must be canonical without symlink ancestors');
  const stat = lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    'journal directory must be owned and private');
  if (persistent) {
    assert(!['/tmp', '/var/tmp', '/run', '/dev/shm'].some(prefix => directory === prefix || directory.startsWith(`${prefix}/`)),
      'funded Signet custody cannot use temporary storage');
    const type = statfsSync(directory, { bigint: true }).type;
    assert(type !== 0x01021994n && type !== 0x858458f6n, 'funded Signet custody cannot use volatile filesystems');
  }
}
export function readPrivateJournalBytes(filename: string, maximum = MAXIMUM_FILE_BYTES) {
  privateJournalDirectory(dirname(filename), false);
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= maximum,
      'checkpoint requires bounded owner-only regular files without hardlinks');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function readPrivateJournalJson<T>(filename: string): T {
  return parsePrivateJournalJson<T>(readPrivateJournalBytes(filename));
}
/** Parse the same checked bytes used for replica/hash comparison. */
export function parsePrivateJournalJson<T>(bytes: Buffer): T {
  try { return JSON.parse(bytes.toString()) as T; }
  catch { throw new Error('private checkpoint JSON is invalid; contents omitted'); }
}
const json = readPrivateJournalJson;
export function syncPrivateJournalDirectory(directory: string) {
  privateJournalDirectory(directory, false);
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function writePrivateJournalBytes(filename: string, bytes: Buffer) {
  privateJournalDirectory(dirname(filename), false);
  assert(bytes.length <= MAXIMUM_FILE_BYTES, 'checkpoint file exceeds its bound');
  const temporary = `${dirname(filename)}/.partial-${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  // Atomic no-replace rename leaves either a single-link partial or a complete
  // single-link member after process death; it cannot strand a two-link final
  // object that would make an otherwise complete backup unrestorable.
  execFileSync('/usr/bin/mv', ['--no-copy', '--no-clobber', '--no-target-directory', '--', temporary, filename], { stdio: 'ignore' });
  assert(!existsSync(temporary), 'immutable checkpoint destination already exists; retained new partial bytes');
  syncPrivateJournalDirectory(dirname(filename));
}
function writeJson(filename: string, value: unknown) { writePrivateJournalBytes(filename, Buffer.from(canonical(value))); }
function createDirectory(directory: string) { mkdirSync(directory, { mode: 0o700 }); syncPrivateJournalDirectory(dirname(directory)); }
function relativeName(name: string) {
  assert(name.length <= 1024 && name.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(part) && part !== '..'),
    'checkpoint contains an unsafe relative path');
}
function binding(identity: Identity): Binding {
  return { sourceDigest: identity.sourceDigest, chain: identity.chain, actualGenesisHash: identity.actualGenesisHash };
}
function validateIdentity(identity: Identity, expected: Binding) {
  assert(identity.version === 1 && identity.kind === 'presigned-isolated-paired-journal' &&
    /^[0-9a-f-]{36}$/u.test(identity.journalId) && Number.isFinite(Date.parse(identity.createdAt)) &&
    (identity.chain === 'default-Signet' || identity.chain === 'isolated-regtest') &&
    /^[0-9a-f]{64}$/u.test(identity.sourceDigest) && /^[0-9a-f]{64}$/u.test(identity.actualGenesisHash) &&
    identity.sourceDigest === expected.sourceDigest && identity.chain === expected.chain &&
    identity.actualGenesisHash === expected.actualGenesisHash, 'durable journal source or chain identity changed');
}
function scan(directory: string) {
  const directories: string[] = []; const files: Entry[] = []; let totalBytes = 0;
  function visit(relative: string) {
    const current = relative ? `${directory}/${relative}` : directory;
    privateJournalDirectory(current, false);
    for (const name of readdirSync(current).sort()) {
      if (!relative && (name === FENCES || name === 'active.lock')) continue;
      const path = relative ? `${relative}/${name}` : name; relativeName(path);
      const stat = lstatSync(`${directory}/${path}`);
      assert(!stat.isSymbolicLink(), 'checkpoint does not follow symlinks');
      if (stat.isDirectory()) {
        directories.push(path);
        assert(files.length + directories.length <= MAXIMUM_ENTRIES, 'checkpoint exceeds its complete-state bound');
        visit(path);
      }
      else {
        const bytes = readPrivateJournalBytes(`${directory}/${path}`);
        files.push({ path, bytes: bytes.length, sha256: sha256(bytes) }); totalBytes += bytes.length;
        assert(files.length + directories.length <= MAXIMUM_ENTRIES && totalBytes <= MAXIMUM_TOTAL_BYTES, 'checkpoint exceeds its complete-state bound');
      }
    }
  }
  visit(''); return { directories: directories.sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)), totalBytes };
}
function recordName(sequence: number, digest: string) { return `${String(sequence).padStart(9, '0')}-${digest}.json`; }
function records(directory: string) {
  privateJournalDirectory(directory, false);
  return readdirSync(directory).filter(name => {
    if (/^\.partial-[0-9a-f-]{36}$/u.test(name)) { readPrivateJournalBytes(`${directory}/${name}`); return false; }
    if (name === 'identity.json') return false;
    assert(/^\d{9}-[0-9a-f]{64}\.json$/u.test(name), 'unexpected checkpoint or watermark filename');
    return true;
  }).sort().map(name => ({ name, sequence: Number(name.slice(0, 9)), digest: name.slice(10, 74) }));
}

export class DurableLifecycleJournal {
  readonly identity: Identity;
  constructor(readonly directory: string, readonly backupDirectory: string, readonly anchorDirectory: string,
    expected: Binding, private readonly purpose: 'operate' | 'restore' = 'operate') {
    if (purpose === 'operate' || existsSync(directory)) privateJournalDirectory(directory, expected.chain === 'default-Signet');
    else assert(directory === resolve(directory), 'missing primary path must still be canonical');
    privateJournalDirectory(backupDirectory, expected.chain === 'default-Signet');
    privateJournalDirectory(anchorDirectory, expected.chain === 'default-Signet');
    separateRoots([directory, backupDirectory, anchorDirectory]);
    this.identity = json<Identity>(`${backupDirectory}/identity.json`);
    validateIdentity(this.identity, expected);
    assert(canonical(json<Identity>(`${anchorDirectory}/identity.json`)) === canonical(this.identity), 'independent rollback anchor identity changed');
    if (purpose === 'operate') {
      privateJournalDirectory(`${directory}/${FENCES}`, false);
      const primary = json<Identity>(`${directory}/${FENCES}/identity.json`);
      assert(canonical(primary) === canonical(this.identity), 'primary journal is not paired with this independent checkpoint store');
    } else if (existsSync(`${directory}/${FENCES}`)) {
      privateJournalDirectory(`${directory}/${FENCES}`, false);
      // Recovery may retain a damaged/missing primary identity. A recognizable
      // VALID different identity is never treated as accidental damage. All
      // surviving watermark filenames/contents are still checked in latest().
      if (existsSync(`${directory}/${FENCES}/identity.json`)) {
        const bytes = readPrivateJournalBytes(`${directory}/${FENCES}/identity.json`);
        let primary: Identity | null = null;
        try { primary = parsePrivateJournalJson<Identity>(bytes); validateIdentity(primary, binding(primary)); }
        catch { primary = null; }
        if (primary) assert(canonical(primary) === canonical(this.identity), 'primary journal is not paired with this independent checkpoint store');
      }
    }
    for (const path of [`${backupDirectory}/snapshots`, `${backupDirectory}/objects`]) privateJournalDirectory(path, false);
  }
  get identityDigest() { return sha256(canonical(this.identity)); }
  private latest(): Snapshot | null {
    const saved = records(`${this.backupDirectory}/snapshots`);
    const fences = this.purpose === 'restore' && !existsSync(`${this.directory}/${FENCES}`) ? [] : records(`${this.directory}/${FENCES}`);
    const anchors = records(this.anchorDirectory);
    assert(saved.every((item, index) => item.sequence === index + 1), 'checkpoint sequence is missing or duplicated');
    assert([...fences, ...anchors].every(item => saved.some(record => record.sequence === item.sequence && record.digest === item.digest)),
      'independent store is stale or missing an acknowledged signing checkpoint');
    for (const fence of [...fences.map(item => ({ ...item, directory: `${this.directory}/${FENCES}` })),
      ...anchors.map(item => ({ ...item, directory: this.anchorDirectory }))]) {
      const value = json<{ sequence: number; checkpointDigest: string }>(`${fence.directory}/${fence.name}`);
      assert(value.sequence === fence.sequence && value.checkpointDigest === fence.digest, 'primary checkpoint watermark changed');
    }
    if (this.purpose === 'restore') assert(anchors.length > 0, 'full-primary-loss restoration requires an independently retained signing checkpoint anchor');
    if (!saved.length) { assert(!fences.length); return null; }
    if (this.purpose === 'operate') assert(anchors.length === saved.length &&
      fences.some(item => item.sequence === saved.at(-1)!.sequence && item.digest === saved.at(-1)!.digest),
      'latest custody checkpoint is not independently acknowledged; use explicit exact restoration before signing');
    return this.readSnapshot(saved, saved.length - 1);
  }
  private readSnapshot(saved: ReturnType<typeof records>, index: number): Snapshot {
    const head = saved[index]!;
    const snapshot = json<Snapshot>(`${this.backupDirectory}/snapshots/${head.name}`);
    const { checkpointDigest, ...body } = snapshot;
    assert(snapshot.version === 1 && snapshot.kind === 'presigned-isolated-complete-checkpoint' &&
      snapshot.journalIdentityDigest === this.identityDigest && snapshot.sequence === head.sequence &&
      snapshot.previousCheckpointDigest === (saved[index - 1]?.digest ?? null) && checkpointDigest === head.digest &&
      sha256(canonical(body)) === checkpointDigest && Number.isFinite(Date.parse(snapshot.createdAt)) &&
      /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,159}$/u.test(snapshot.reason), 'checkpoint identity or hash chain changed');
    assert(Array.isArray(snapshot.directories) && Array.isArray(snapshot.files) &&
      snapshot.directories.length + snapshot.files.length <= MAXIMUM_ENTRIES, 'checkpoint listing exceeds its bound');
    snapshot.directories.forEach(relativeName);
    const paths = snapshot.files.map(entry => {
      relativeName(entry.path);
      assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAXIMUM_FILE_BYTES && /^[0-9a-f]{64}$/u.test(entry.sha256),
        'invalid checkpoint member metadata');
      return entry.path;
    });
    assert(new Set(paths).size === paths.length && new Set(snapshot.directories).size === snapshot.directories.length &&
      paths.every(path => !snapshot.directories.includes(path)) &&
      snapshot.totalBytes === snapshot.files.reduce((sum, entry) => sum + entry.bytes, 0) && snapshot.totalBytes <= MAXIMUM_TOTAL_BYTES,
      'checkpoint members overlap or disagree with their complete size');
    for (const path of [...paths, ...snapshot.directories]) {
      assert(path !== 'active.lock' && !path.startsWith('active.lock/'), 'checkpoint cannot restore a process-lock inode');
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
      assert(parent === null || snapshot.directories.includes(parent), 'checkpoint member parent directory is missing');
    }
    return snapshot;
  }
  /** Historical pre-signing proof, anchored independently of the live tree.
   * Every requested member is reread from both stores and hash matched. */
  verifyCheckpoint(checkpointDigest: string, requiredFiles: string[], expectedReason: string) {
    assert(/^[0-9a-f]{64}$/u.test(checkpointDigest));
    this.latest();
    const saved = records(`${this.backupDirectory}/snapshots`);
    const index = saved.findIndex(item => item.digest === checkpointDigest); assert(index >= 0, 'required signing checkpoint is missing');
    assert(records(this.anchorDirectory).some(item => item.digest === checkpointDigest && item.sequence === saved[index]!.sequence),
      'required signing checkpoint lacks its independent acknowledgement');
    const snapshot = this.readSnapshot(saved, index);
    assert.equal(snapshot.reason, expectedReason, 'historical checkpoint has a different signing purpose');
    for (const path of requiredFiles) {
      relativeName(path); const entry = snapshot.files.find(item => item.path === path);
      assert(entry, 'historical signing checkpoint lacks required complete custody');
      const bytes = readPrivateJournalBytes(`${this.backupDirectory}/objects/${entry.sha256}`);
      assert(bytes.length === entry.bytes && sha256(bytes) === entry.sha256 &&
        readPrivateJournalBytes(`${this.directory}/${path}`).equals(bytes), 'historical signing custody bytes no longer match');
    }
    return { sequence: snapshot.sequence, checkpointDigest, files: snapshot.files.map(item => item.path) };
  }
  /** Read-only. Extra not-yet-checkpointed files are allowed; losing or changing
   * any committed file is not. Every independent object is reread and hashed. */
  assertCurrent() {
    assert(this.purpose === 'operate', 'a restore-only reader cannot authorize signing or broadcasting');
    const snapshot = this.latest(); const current = scan(this.directory);
    if (!snapshot) return { snapshot, current };
    const actual = new Map(current.files.map(entry => [entry.path, entry]));
    assert(snapshot.directories.every(path => current.directories.includes(path)), 'committed lifecycle directories are missing; restore the exact checkpoint');
    for (const entry of snapshot.files) {
      const present = actual.get(entry.path);
      assert(present && canonical(present) === canonical(entry), 'committed lifecycle bytes are missing or changed; restore the exact checkpoint');
      const bytes = readPrivateJournalBytes(`${this.backupDirectory}/objects/${entry.sha256}`);
      assert(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'independent checkpoint object is missing or corrupt');
    }
    return { snapshot, current };
  }
  checkpoint(reason: string) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,159}$/u.test(reason), 'invalid non-secret checkpoint reason');
    const { snapshot: previous, current } = this.assertCurrent();
    for (const entry of current.files) {
      const bytes = readPrivateJournalBytes(`${this.directory}/${entry.path}`);
      assert(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'primary journal changed during checkpoint');
      const object = `${this.backupDirectory}/objects/${entry.sha256}`;
      if (!existsSync(object)) writePrivateJournalBytes(object, bytes);
      const copied = readPrivateJournalBytes(object);
      assert(copied.equals(bytes), 'checkpoint object did not restore the exact committed bytes');
    }
    const body = { version: 1 as const, kind: 'presigned-isolated-complete-checkpoint' as const,
      journalIdentityDigest: this.identityDigest, sequence: (previous?.sequence ?? 0) + 1,
      previousCheckpointDigest: previous?.checkpointDigest ?? null, reason, createdAt: new Date().toISOString(), ...current };
    const checkpointDigest = sha256(canonical(body));
    const result: Snapshot = { ...body, checkpointDigest };
    const name = recordName(body.sequence, checkpointDigest);
    writeJson(`${this.backupDirectory}/snapshots/${name}`, result);
    writeJson(`${this.directory}/${FENCES}/${name}`, { sequence: body.sequence, checkpointDigest });
    writeJson(`${this.anchorDirectory}/${name}`, { sequence: body.sequence, checkpointDigest });
    const verified = this.assertCurrent().snapshot;
    assert(verified?.checkpointDigest === checkpointDigest, 'checkpoint was not durably published on both sides');
    return { sequence: result.sequence, checkpointDigest, files: result.files.map(entry => entry.path), totalBytes: result.totalBytes };
  }
  /** Explicit restoration into a NEW private directory. Never overwrite a live
   * tree, choose an older snapshot, remove evidence, or restore ephemeral locks. */
  restore(destination: string) {
    privateJournalDirectory(destination, this.identity.chain === 'default-Signet');
    syncPrivateJournalDirectory(dirname(destination));
    assert(readdirSync(destination).length === 0, 'restore requires a separate empty private destination');
    separateRoots([this.directory, this.backupDirectory, this.anchorDirectory, destination]);
    const snapshot = this.latest(); assert(snapshot, 'there is no complete checkpoint to restore');
    for (const path of [...snapshot.directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)))
      createDirectory(`${destination}/${path}`);
    for (const entry of snapshot.files) {
      const bytes = readPrivateJournalBytes(`${this.backupDirectory}/objects/${entry.sha256}`);
      assert(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'cannot restore missing or corrupt checkpoint bytes');
      writePrivateJournalBytes(`${destination}/${entry.path}`, bytes);
    }
    createDirectory(`${destination}/${FENCES}`);
    writeJson(`${destination}/${FENCES}/identity.json`, this.identity);
    const name = recordName(snapshot.sequence, snapshot.checkpointDigest);
    writeJson(`${destination}/${FENCES}/${name}`, { sequence: snapshot.sequence, checkpointDigest: snapshot.checkpointDigest });
    // Only explicit restore may finish an interrupted checkpoint publication.
    // First verify the COMPLETE restored bytes, then append missing exact anchor
    // records. Never drop a surviving newer/conflicting watermark to succeed.
    const restoredBytes = scan(destination);
    assert(canonical(restoredBytes) === canonical({ directories: [...snapshot.directories].sort(), files: snapshot.files, totalBytes: snapshot.totalBytes }),
      'restored checkpoint bytes differ before independent acknowledgement');
    const saved = records(`${this.backupDirectory}/snapshots`);
    for (const [index, record] of saved.entries()) {
      this.readSnapshot(saved, index);
      const path = `${this.anchorDirectory}/${record.name}`;
      if (!existsSync(path)) writeJson(path, { sequence: record.sequence, checkpointDigest: record.digest });
    }
    const restored = new DurableLifecycleJournal(destination, this.backupDirectory, this.anchorDirectory, binding(this.identity));
    const actual = restored.assertCurrent();
    assert(canonical(actual.current) === canonical({ directories: [...snapshot.directories].sort(), files: snapshot.files, totalBytes: snapshot.totalBytes }),
      'actual restored checkpoint is not the complete exact journal');
    return restored;
  }
}

function separateRoots(roots: string[]) {
  assert(roots.every((root, index) => roots.every((other, otherIndex) => index === otherIndex ||
    (root !== other && !root.startsWith(`${other}/`) && !other.startsWith(`${root}/`)))),
  'primary, complete backup, rollback anchor and restoration roots must be disjoint');
}

export function createDurableLifecycleJournal(directory: string, backupDirectory: string, anchorDirectory: string, expected: Binding) {
  privateJournalDirectory(directory, expected.chain === 'default-Signet');
  privateJournalDirectory(backupDirectory, expected.chain === 'default-Signet');
  privateJournalDirectory(anchorDirectory, expected.chain === 'default-Signet');
  separateRoots([directory, backupDirectory, anchorDirectory]);
  assert(readdirSync(directory).every(name => name === 'active.lock') && readdirSync(backupDirectory).length === 0 && readdirSync(anchorDirectory).length === 0,
    'never create a new journal over existing or interrupted custody');
  const identity: Identity = { version: 1, kind: 'presigned-isolated-paired-journal', journalId: randomUUID(),
    createdAt: new Date().toISOString(), ...expected };
  validateIdentity(identity, expected);
  createDirectory(`${directory}/${FENCES}`);
  createDirectory(`${backupDirectory}/snapshots`); createDirectory(`${backupDirectory}/objects`);
  writeJson(`${backupDirectory}/identity.json`, identity);
  writeJson(`${anchorDirectory}/identity.json`, identity);
  writeJson(`${directory}/${FENCES}/identity.json`, identity);
  return new DurableLifecycleJournal(directory, backupDirectory, anchorDirectory, expected);
}

/** Requires the original independent rollback anchor as well as full custody
 * bytes. A valid older backup alone cannot authorize resuming a funded run. */
export function restoreDurableLifecycleJournal(originalDirectory: string, backupDirectory: string, anchorDirectory: string,
  destination: string, expected: Binding) {
  return new DurableLifecycleJournal(originalDirectory, backupDirectory, anchorDirectory, expected, 'restore').restore(destination);
}
