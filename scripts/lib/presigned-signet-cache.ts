/** Copy only a stopped, owned, public default-Signet chain cache. No wallets. */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { privateJournalDirectory, syncPrivateJournalDirectory } from './presigned-durable-journal.js';

export function assertNoOwnedProcessUsesDatadir(datadir: string) {
  assert(datadir === resolve(datadir));
  for (const entry of readdirSync('/proc').filter(value => /^[1-9][0-9]*$/u.test(value))) {
    try {
      if (lstatSync(`/proc/${entry}`).uid !== process.getuid?.()) continue;
      const args = readFileSync(`/proc/${entry}/cmdline`).toString().split('\0').filter(Boolean);
      assert(!args.some(value => value.startsWith('-datadir=') && resolve(value.slice(9)) === datadir),
        'the exact data directory is used by a live process; stop that process before copying or restoring');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
}
export function checkStoppedPublicSignetCache(source: string) {
  assert(source === resolve(source) && realpathSync(source) === source && source.endsWith('/signet') &&
    existsSync(`${source}/blocks`) && existsSync(`${source}/chainstate`), 'need the exact stopped public Signet chain cache');
  assertNoOwnedProcessUsesDatadir(source.slice(0, -'/signet'.length));
  const root = lstatSync(source);
  assert(root.isDirectory() && root.uid === process.getuid?.() && (root.mode & 0o022) === 0, 'public cache root has unsafe ownership or write permissions');
  const parts = ['blocks', 'chainstate', 'indexes'].filter(part => existsSync(`${source}/${part}`));
  checkPublicCacheParts(source, parts);
  return parts;
}
function checkPublicCacheParts(root: string, parts: string[]) {
  let entries = 0;
  function check(path: string) {
    const stat = lstatSync(path);
    assert(++entries <= 200_000 && stat.uid === process.getuid?.() && !stat.isSymbolicLink() &&
      (stat.mode & 0o022) === 0 && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)),
      'public cache contains an unexpected owner, unsafe write permissions, alias or special file');
    if (stat.isDirectory()) for (const entry of readdirSync(path)) check(`${path}/${entry}`);
  }
  for (const part of parts) check(`${root}/${part}`);
}
/** Core 31.1 uses a whole-file POSIX F_SETLK write lock, not BSD flock:
 * https://github.com/bitcoin/bitcoin/blob/v31.1/src/util/fs.cpp#L59-L74
 * Node has no standard fcntl binding. This small isolated stdlib helper owns
 * the real lock until validation, copy, destination audit and fsync finish.
 * It never reads/writes chain bytes or credentials. Parent death closes stdin.
 */
export async function withStoppedCoreDataDirectoryLock<T>(directory: string, action: (assertHeld: () => void) => Promise<T>) {
  assert(directory === resolve(directory) && realpathSync(directory) === directory);
  const helperSource = `import fcntl, os, stat, sys
try:
    fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOFOLLOW)
    info = os.fstat(fd)
    assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and not (info.st_mode & 0o022)
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 0, 0, os.SEEK_SET)
    print('locked', flush=True)
    assert sys.stdin.readline() == 'release\\n'
    assert os.stat(sys.argv[1], follow_symlinks=False).st_ino == info.st_ino
    os.close(fd)
except BaseException:
    sys.exit(2)
`;
  const helper = spawn('/usr/bin/python3', ['-I', '-c', helperSource, `${directory}/.lock`], { stdio: ['pipe', 'pipe', 'ignore'] });
  let stopped = false; let failed = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    helper.once('error', () => { failed = true; stopped = true; resolveExit({ code: null, signal: null }); });
    helper.once('exit', (code, signal) => { stopped = true; resolveExit({ code, signal }); });
  });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Core directory-lock acquisition timed out')), 10_000);
      let output = '';
      helper.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output === 'locked\n') { clearTimeout(timeout); resolveReady(); }
        else if (output.length > 32) { clearTimeout(timeout); reject(new Error('unexpected Core directory-lock helper result')); }
      });
      void exited.then(() => { clearTimeout(timeout); reject(new Error('Core cache is live or its exact directory lock could not be acquired')); });
    });
    const assertHeld = () => assert(!stopped && !failed && helper.exitCode === null && helper.signalCode === null,
      'Core cache lock owner exited before copy verification completed');
    assertHeld(); const result = await action(assertHeld); assertHeld();
    helper.stdin.end('release\n');
    const ended = await exited;
    assert(!failed && ended.code === 0 && ended.signal === null, 'Core cache lock did not cover the complete verified copy');
    return result;
  } finally {
    if (!stopped) helper.stdin.destroy();
    await exited;
  }
}
export async function copyStoppedPublicSignetCache(source: string, destination: string) {
  checkStoppedPublicSignetCache(source);
  await withStoppedCoreDataDirectoryLock(source, async assertHeld => {
    const parts = checkStoppedPublicSignetCache(source);
    privateJournalDirectory(destination, true);
    assert(readdirSync(destination).length === 0, 'public-cache destination must be new and empty');
    assertHeld();
    await new Promise<void>((resolveCopy, reject) => {
      const copy = spawn('/usr/bin/cp', ['--reflink=auto', '--sparse=always', '-a', '--', ...parts.map(part => `${source}/${part}`), `${destination}/`],
        { stdio: 'ignore' });
      copy.once('error', () => reject(new Error('public chain-cache copy could not start')));
      copy.once('exit', code => code === 0 ? resolveCopy() : reject(new Error('public chain-cache copy failed')));
    });
    assertHeld();
    assert.deepEqual(readdirSync(destination).sort(), [...parts].sort(), 'copied cache has unexpected top-level entries');
    // Recheck the actual destination, including copied symlinks or permissions
    // raced into the source after preflight; never launch Core on an unaudited tree.
    checkPublicCacheParts(destination, parts);
    assert.deepEqual(checkStoppedPublicSignetCache(source), parts);
    syncPrivateJournalDirectory(destination); assertHeld();
  });
}
