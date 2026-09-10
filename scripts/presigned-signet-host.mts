/** Fresh persistent default-Signet acceptance host. No operational wallet use. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { privateJournalDirectory, syncPrivateJournalDirectory, writePrivateJournalBytes } from './lib/presigned-durable-journal.js';
import { createNativeWalletRestoreProof } from './lib/presigned-wallet-restore-proof.js';
import { acquireLifecycleProcessLock } from './lib/presigned-lifecycle-lock.js';
import { checkStoppedPublicSignetCache, copyStoppedPublicSignetCache } from './lib/presigned-signet-cache.js';
import { assertPersistentSignetIdentity, launchPersistentSignetDaemon, persistentSignetRpc,
  readPersistentSignetControl, receivingWalletRecoveryBinding, SIGNET_CORE_BINARY, SIGNET_CORE_SHA256,
  startPersistentSignetHost, stopPersistentSignetHost, verifySignetBinary, type PersistentSignetControl } from './lib/presigned-signet-host-state.js';

process.umask(0o077);
const argument = process.argv[2];
assert(process.argv.length === 3 && argument?.startsWith('--stopped-chain-cache=/'),
  'usage: tsx scripts/presigned-signet-host.mts --stopped-chain-cache=/absolute/stopped/public/chain-cache/signet');
const source = argument.slice('--stopped-chain-cache='.length);
checkStoppedPublicSignetCache(source);
verifySignetBinary();
const root = resolve(process.cwd(), 'live-run'); privateJournalDirectory(root, true);

const directory = mkdtempSync(`${root}/presigned-v2-signet-host.`);
const backupRoot = mkdtempSync(`${root}/presigned-v2-signet-backup.`);
const anchorRoot = mkdtempSync(`${root}/presigned-v2-signet-anchor.`);
syncPrivateJournalDirectory(root);
for (const path of [`${directory}/core`, `${directory}/core/signet`, `${directory}/wallets`, `${directory}/restores`,
  `${backupRoot}/journal`, `${backupRoot}/native-wallet`, `${anchorRoot}/journal`]) mkdirSync(path, { mode: 0o700 });
for (const parent of [directory, `${directory}/core`, backupRoot, anchorRoot]) syncPrivateJournalDirectory(parent);
writePrivateJournalBytes(`${directory}/empty.conf`, Buffer.alloc(0));
await copyStoppedPublicSignetCache(source, `${directory}/core/signet`);
const listener = createServer();
await new Promise<void>(resolveListen => listener.listen(0, '127.0.0.1', resolveListen));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
// This incomplete object is never published as control or as a funding address.
// The only publication comes after an actual offline receiving-wallet restore.
const control: PersistentSignetControl = { version: 3, kind: 'persistent-isolated-default-signet', network: 'signet',
  sourceDigest: presignedSourceDigest(), hostId: randomUUID(), startedAt: new Date().toISOString(), directory, backupRoot, anchorRoot,
  journalBackupDirectory: `${backupRoot}/journal`, journalAnchorDirectory: `${anchorRoot}/journal`,
  restorationParent: `${directory}/restores`, nativeWalletBackupParent: `${backupRoot}/native-wallet`,
  walletName: 'presigned-v2-signet-acceptance', address: '', addressScriptPubKeyHex: '', rpcUrl: `http://127.0.0.1:${port}`,
  cookiePath: `${directory}/core/signet/.cookie`, port, binaryPath: SIGNET_CORE_BINARY, binarySha256: SIGNET_CORE_SHA256,
  existingOperationalWalletsUsed: false, publicListeners: false, walletBroadcastDisabled: true,
  receivingWalletRecovery: { directory: '', backupSha256: '', proofSha256: '', actualRestoredNativeSignatures: 0 } };
const lock = acquireLifecycleProcessLock(directory, control.sourceDigest);
let ready = false;
try {
  await launchPersistentSignetDaemon(control, false);
  const { network } = await assertPersistentSignetIdentity(control, false, true);
  assert(network.networkactive === false && network.connections === 0, 'new host must remain offline through receiving-wallet restoration');
  const rpc = persistentSignetRpc(control);
  await rpc('createwallet', [control.walletName, false, false, '', false, true, false]);
  control.address = await rpc('getnewaddress', ['isolated-signet-test-coins', 'bech32m'], true);
  const address = await rpc('getaddressinfo', [control.address], true);
  assert(address.ismine === true && address.solvable === true); control.addressScriptPubKeyHex = address.scriptPubKey;
  control.receivingWalletRecovery = await createNativeWalletRestoreProof({ ...receivingWalletRecoveryBinding(control),
    binary: control.binaryPath, parentDirectory: control.nativeWalletBackupParent,
    sourceWalletRpc: (method, params) => { assert(method === 'backupwallet'); return rpc(method, params, true); } });
  const bytes = Buffer.from(`${JSON.stringify(control, null, 2)}\n`);
  writePrivateJournalBytes(`${backupRoot}/host-control.json`, bytes);
  writePrivateJournalBytes(`${anchorRoot}/host-control.json`, bytes);
  writePrivateJournalBytes(`${directory}/control.json`, bytes);
  const verified = readPersistentSignetControl(`${directory}/control.json`);
  await startPersistentSignetHost(verified);
  ready = true;
  console.log(JSON.stringify({ stage: 'persistent-isolated-default-Signet-host-ready', control: `${directory}/control.json`,
    address: control.address, nativeReceivingWalletRestorationVerified: true, persistentPrivateCustody: true,
    walletBroadcastDisabled: true, publicListeners: false, initialWalletTestSats: 0 }));
} finally {
  if (!ready) {
    try { await stopPersistentSignetHost(control); }
    catch { throw new Error(`host creation did not complete; retained private state requires inspection at ${directory}`); }
  }
  lock.release();
}
