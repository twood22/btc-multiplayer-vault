/** Persistent isolated default-Signet host identity and loopback-only transport. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { privateJournalDirectory, readPrivateJournalBytes, parsePrivateJournalJson } from './presigned-durable-journal.js';
import { assertHostRestorationReady } from './presigned-host-restoration-gate.js';
import { acquireLifecycleProcessLock } from './presigned-lifecycle-lock.js';
import { presignedSourceDigest } from '../presigned-build-identity.mjs';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { verifyNativeWalletRestoreProof } from './presigned-wallet-restore-proof.js';

export const SIGNET_CORE_BINARY = '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind';
export const SIGNET_CORE_SHA256 = '986e63b3c8770f08d0059820ad3dd085d1ab9e1bea23946c243f858a06888a08';
export const DEFAULT_SIGNET_GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';
export const DEFAULT_SIGNET_BLOCK_ONE = '00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53';
export interface PersistentSignetControl {
  version: 3; kind: 'persistent-isolated-default-signet'; network: 'signet'; sourceDigest: string;
  hostId: string; startedAt: string; directory: string; backupRoot: string; anchorRoot: string;
  journalBackupDirectory: string; journalAnchorDirectory: string; restorationParent: string; nativeWalletBackupParent: string;
  walletName: 'presigned-v2-signet-acceptance'; address: string; addressScriptPubKeyHex: string;
  rpcUrl: string; cookiePath: string; port: number; binaryPath: string; binarySha256: string;
  existingOperationalWalletsUsed: false; publicListeners: false; walletBroadcastDisabled: true;
  receivingWalletRecovery: { directory: string; backupSha256: string; proofSha256: string; actualRestoredNativeSignatures: number };
}
export function verifySignetBinary() {
  const stat = lstatSync(SIGNET_CORE_BINARY);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0 &&
    realpathSync(SIGNET_CORE_BINARY) === SIGNET_CORE_BINARY, 'isolated Signet binary ownership changed');
  assert.equal(createHash('sha256').update(readFileSync(SIGNET_CORE_BINARY)).digest('hex'), SIGNET_CORE_SHA256, 'isolated Signet binary changed');
}
function validatePersistentSignetControl(control: PersistentSignetControl, bytes: Buffer, filename: string,
  requireCurrentSource: boolean, requireIndependentCustody: boolean, requirePrimary: boolean) {
  const root = resolve(process.cwd(), 'live-run');
  assert(filename === resolve(filename) && dirname(dirname(filename)) === root && basename(filename) === 'control.json' &&
    /^presigned-v2-signet-host\.[A-Za-z0-9]{6}$/u.test(basename(dirname(filename))), 'not a persistent isolated Signet control path');
  privateJournalDirectory(root, true);
  if (requirePrimary) privateJournalDirectory(dirname(filename), true);
  assert(control.version === 3 && control.kind === 'persistent-isolated-default-signet' && control.network === 'signet' &&
    control.directory === dirname(filename) && /^[0-9a-f-]{36}$/u.test(control.hostId) &&
    /^[0-9a-f]{64}$/u.test(control.sourceDigest) && (!requireCurrentSource || control.sourceDigest === presignedSourceDigest()) &&
    control.walletName === 'presigned-v2-signet-acceptance' &&
    control.existingOperationalWalletsUsed === false && control.publicListeners === false && control.walletBroadcastDisabled === true,
    'isolated host version, source or wallet provenance changed; never reinterpret a funded run');
  for (const [directory, prefix] of [[control.backupRoot, 'presigned-v2-signet-backup.'], [control.anchorRoot, 'presigned-v2-signet-anchor.']]) {
    assert(dirname(directory!) === root && basename(directory!).startsWith(prefix!) && /^[A-Za-z0-9]{6}$/u.test(basename(directory!).slice(prefix!.length)),
      'isolated backup or anchor root escaped its exact persistent scope');
    if (requireIndependentCustody) privateJournalDirectory(directory!, true);
  }
  assert(control.journalBackupDirectory === `${control.backupRoot}/journal` && control.journalAnchorDirectory === `${control.anchorRoot}/journal` &&
    control.nativeWalletBackupParent === `${control.backupRoot}/native-wallet` && control.restorationParent === `${control.directory}/restores`,
    'isolated custody layout changed');
  if (requirePrimary && requireIndependentCustody) privateJournalDirectory(control.restorationParent, true);
  if (requireIndependentCustody) {
    for (const directory of [control.journalBackupDirectory, control.journalAnchorDirectory, control.nativeWalletBackupParent]) privateJournalDirectory(directory, true);
    for (const directory of [control.backupRoot, control.anchorRoot])
      assert(bytes.equals(readPrivateJournalBytes(`${directory}/host-control.json`)), 'persistent host control differs from its independently retained copies');
  }
  assert(Number.isSafeInteger(control.port) && control.port > 1024 && control.port < 65536 &&
    control.rpcUrl === `http://127.0.0.1:${control.port}` && control.cookiePath === `${control.directory}/core/signet/.cookie` &&
    control.binaryPath === SIGNET_CORE_BINARY && control.binarySha256 === SIGNET_CORE_SHA256, 'isolated transport or executable changed');
  verifySignetBinary();
  return control;
}
export function readPersistentSignetControl(filename: string, requireCurrentSource = true, requireIndependentCustody = true,
  allowIncompleteRestoration = false): PersistentSignetControl {
  assert(filename === resolve(filename) && dirname(dirname(filename)) === resolve(process.cwd(), 'live-run') && basename(filename) === 'control.json' &&
    /^presigned-v2-signet-host\.[A-Za-z0-9]{6}$/u.test(basename(dirname(filename))), 'not a persistent isolated Signet control path');
  const bytes = readPrivateJournalBytes(filename);
  const control = parsePrivateJournalJson<PersistentSignetControl>(bytes);
  validatePersistentSignetControl(control, bytes, filename, requireCurrentSource, requireIndependentCustody, true);
  if (requireIndependentCustody && !allowIncompleteRestoration) assertHostRestorationReady(control);
  return control;
}
/** Recovery starts with the independently retained control, not a fabricated
 * replacement identity. The exact missing primary path and both replicas bind. */
export function readPersistentSignetRecoveryControl(filename: string) {
  assert(filename === resolve(filename) && dirname(dirname(filename)) === resolve(process.cwd(), 'live-run') && basename(filename) === 'host-control.json' &&
    /^presigned-v2-signet-backup\.[A-Za-z0-9]{6}$/u.test(basename(dirname(filename))), 'not an independent isolated Signet control path');
  const bytes = readPrivateJournalBytes(filename);
  const control = parsePrivateJournalJson<PersistentSignetControl>(bytes);
  assert(filename === `${control.backupRoot}/host-control.json`, 'restore requires the exact independent full-backup control');
  return validatePersistentSignetControl(control, bytes, `${control.directory}/control.json`, true, true, false);
}
export function acquirePersistentSignetOperationLocks(control: PersistentSignetControl, requireBackup = true) {
  const locks: Array<ReturnType<typeof acquireLifecycleProcessLock>> = [];
  try {
    // The shared backup inode also excludes a recovered primary from a retained
    // older copy. A local-primary lock still allows safe degraded shutdown.
    if (requireBackup) locks.push(acquireLifecycleProcessLock(control.backupRoot, control.sourceDigest));
    locks.push(acquireLifecycleProcessLock(control.directory, control.sourceDigest));
  } catch (error) { for (const lock of locks.reverse()) lock.release(); throw error; }
  return { release() { for (const lock of [...locks].reverse()) lock.release(); } };
}
export function persistentSignetArguments(control: Pick<PersistentSignetControl, 'directory' | 'port' | 'walletName'>, loadWallet: boolean) {
  return ['-signet', `-datadir=${control.directory}/core`, `-walletdir=${control.directory}/wallets`, `-conf=${control.directory}/empty.conf`,
    `-pid=${control.directory}/core.pid`, '-nosettings', '-daemonwait', '-server=1', '-listen=0', '-discover=0', '-networkactive=0',
    '-walletbroadcast=0', '-persistmempool=0', '-txindex=1', '-dbcache=256', '-maxconnections=12', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1',
    `-rpcport=${control.port}`, '-printtoconsole=0', ...(loadWallet ? [`-wallet=${control.walletName}`] : [])];
}

export function persistentSignetRpc(control: Pick<PersistentSignetControl, 'rpcUrl' | 'cookiePath' | 'walletName'>) {
  assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/u.test(control.rpcUrl) && control.walletName === 'presigned-v2-signet-acceptance');
  return async (method: string, params: unknown[] = [], wallet = false): Promise<any> => {
    const cookie = readPrivateJournalBytes(control.cookiePath, 512).toString().trim();
    const response = await fetch(`${control.rpcUrl}/${wallet ? `wallet/${control.walletName}` : ''}`, {
      method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'persistent-isolated-signet', method, params }),
      signal: AbortSignal.timeout(30_000), redirect: 'error' });
    const body = await response.json() as { result: any; error?: { code: number } };
    if (!response.ok || body.error) throw Object.assign(new Error('isolated default-Signet RPC refused; private response omitted'), { code: body.error?.code });
    return body.result;
  };
}
export function persistentSignetPid(control: Pick<PersistentSignetControl, 'directory' | 'port' | 'walletName'>, requireRpcListener = true) {
  if (!existsSync(`${control.directory}/core.pid`)) return null;
  const text = readPrivateJournalBytes(`${control.directory}/core.pid`, 32).toString().trim();
  assert(/^[1-9][0-9]*$/u.test(text)); const pid = Number(text); assert(Number.isSafeInteger(pid) && pid > 1);
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
  // A stale PID can have been reused after reboot. Never signal or adopt it.
  let args: string[];
  try {
    if (realpathSync(`/proc/${pid}/exe`) !== SIGNET_CORE_BINARY) return null;
    args = readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  assert([false, true].some(load => JSON.stringify(args) === JSON.stringify([SIGNET_CORE_BINARY, ...persistentSignetArguments(control, load)])),
    'a live Core process differs from the exact isolated launch vector');
  assert.equal(readPrivateJournalBytes(`${control.directory}/empty.conf`).length, 0, 'isolated Core configuration is no longer empty');
  if (requireRpcListener) {
    const sockets = execFileSync('ss', ['-H', '-ltnp'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`pid=${pid},`));
    assert(sockets.length === 1 && sockets[0]!.trim().split(/\s+/)[3] === `127.0.0.1:${control.port}`, 'isolated Core has an unexpected listener');
  }
  return pid;
}
export async function assertPersistentSignetIdentity(control: PersistentSignetControl, requireSynchronized: boolean, beforeWalletCreation = false) {
  verifySignetBinary(); assert(persistentSignetPid(control), 'the exact isolated Core process is not live');
  const rpc = persistentSignetRpc(control);
  const network = await rpc('getnetworkinfo'); const chain = await rpc('getblockchaininfo');
  assert(network.version === 310100 && chain.chain === 'signet' && chain.pruned === false);
  assert.equal(await rpc('getblockhash', [0]), DEFAULT_SIGNET_GENESIS);
  assert.equal(await rpc('getblockhash', [1]), DEFAULT_SIGNET_BLOCK_ONE);
  assert.deepEqual(await rpc('listwallets'), beforeWalletCreation ? [] : [control.walletName], 'isolated Core loaded an unexpected wallet');
  if (!beforeWalletCreation) {
    const address = await rpc('getaddressinfo', [control.address], true);
    assert(address.ismine === true && address.solvable === true && address.scriptPubKey === control.addressScriptPubKeyHex);
  }
  const indexes = await rpc('getindexinfo');
  if (requireSynchronized) assert(!chain.initialblockdownload && chain.blocks === chain.headers && indexes.txindex?.synced === true &&
    network.networkactive === true && network.connections > 0, 'isolated Signet is not synchronized with active peers');
  return { network, chain, indexes };
}
export function receivingWalletRecoveryBinding(control: Pick<PersistentSignetControl,
  'hostId' | 'sourceDigest' | 'address' | 'addressScriptPubKeyHex' | 'binarySha256'>) {
  return { chain: 'signet' as const, binarySha256: control.binarySha256,
    bindingDigest: commitmentDigest('vault/presigned-graph-v2/persistent-isolated-host-wallet', {
      hostId: control.hostId, sourceDigest: control.sourceDigest, address: control.address, scriptPubKeyHex: control.addressScriptPubKeyHex }),
    targets: [{ address: control.address, scriptPubKeyHex: control.addressScriptPubKeyHex }] };
}
export function verifyReceivingWalletRecovery(control: PersistentSignetControl) {
  const receipt = control.receivingWalletRecovery;
  assert(receipt && typeof receipt.directory === 'string' && dirname(receipt.directory) === control.nativeWalletBackupParent &&
    /^wallet-restore-proof\.[A-Za-z0-9]{6}$/u.test(basename(receipt.directory)), 'receiving-wallet backup escaped its private scope');
  const actual = verifyNativeWalletRestoreProof(receipt.directory, receivingWalletRecoveryBinding(control));
  assert(actual.actualRestoredNativeSignatures === 1 && actual.backupSha256 === receipt.backupSha256 && actual.proofSha256 === receipt.proofSha256,
    'persistent host lost its independently restored receiving wallet');
  return actual;
}
export async function launchPersistentSignetDaemon(control: PersistentSignetControl, loadWallet: boolean) {
  verifySignetBinary();
  for (const directory of [control.directory, `${control.directory}/core`, `${control.directory}/wallets`]) privateJournalDirectory(directory, true);
  if (existsSync(`${control.directory}/core/signet`)) privateJournalDirectory(`${control.directory}/core/signet`, true);
  assert.equal(readPrivateJournalBytes(`${control.directory}/empty.conf`).length, 0);
  assert.equal(persistentSignetPid(control), null, 'the isolated Core process is already live; do not launch another');
  if (loadWallet) {
    privateJournalDirectory(`${control.directory}/wallets/${control.walletName}`, true);
    const wallet = lstatSync(`${control.directory}/wallets/${control.walletName}/wallet.dat`);
    assert(wallet.isFile() && !wallet.isSymbolicLink() && wallet.nlink === 1 && wallet.uid === process.getuid?.() && (wallet.mode & 0o077) === 0,
      'existing test-wallet bytes are missing; use explicit verified restoration, never create a replacement wallet');
  }
  await new Promise<void>((resolveExit, reject) => {
    const child = spawn(SIGNET_CORE_BINARY, persistentSignetArguments(control, loadWallet), { stdio: 'ignore' });
    child.once('error', () => reject(new Error('isolated Core could not launch')));
    child.once('exit', code => code === 0 ? resolveExit() : reject(new Error('isolated Core startup failed; retain its private state')));
  });
  for (let attempt = 0; attempt < 300 && !existsSync(control.cookiePath); attempt++) await pause(100);
  assert(persistentSignetPid(control), 'new isolated Core process could not be verified');
}
export async function startPersistentSignetHost(control: PersistentSignetControl) {
  assertHostRestorationReady(control);
  if (!persistentSignetPid(control)) await launchPersistentSignetDaemon(control, true);
  await assertPersistentSignetIdentity(control, false);
  verifyReceivingWalletRecovery(control);
  const rpc = persistentSignetRpc(control);
  if (!(await rpc('getnetworkinfo')).networkactive) assert.equal(await rpc('setnetworkactive', [true]), true);
}
export async function stopPersistentSignetHost(control: PersistentSignetControl) {
  const pid = persistentSignetPid(control); if (!pid) return;
  const rpc = persistentSignetRpc(control);
  // Do not signal a numeric PID after a transport delay: it could be reused.
  await rpc('stop');
  let stopped = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    if (persistentSignetPid(control, false) === null) { stopped = true; break; }
    await pause(100);
  }
  assert(stopped, 'isolated Core shutdown is still unconfirmed; inspect the same process');
}
