/** Controls only a persistent isolated test host; never adopts an old V2 host. */
import assert from 'node:assert/strict';
import { acquirePersistentSignetOperationLocks, assertPersistentSignetIdentity, persistentSignetPid, persistentSignetRpc, readPersistentSignetControl,
  startPersistentSignetHost, stopPersistentSignetHost, verifyReceivingWalletRecovery } from './lib/presigned-signet-host-state.js';

process.umask(0o077);
const [operation, filename] = process.argv.slice(2);
assert(process.argv.length === 4 && ['start', 'status', 'stop'].includes(operation ?? '') && filename,
  'usage: tsx scripts/presigned-signet-control.mts start|status|stop /absolute/persistent/host/control.json');
// Read-only status and safe shutdown remain available after source edits, but
// starting or advancing a funded host requires its exact original source.
const control = readPersistentSignetControl(filename, operation === 'start', operation === 'start');
let independentCustodyVerified = false;
try { readPersistentSignetControl(filename, operation === 'start'); verifyReceivingWalletRecovery(control); independentCustodyVerified = true; }
catch { assert(operation !== 'start', 'starting the host requires intact independent custody'); }
const lock = operation === 'status' ? null : acquirePersistentSignetOperationLocks(control, independentCustodyVerified);
try {
  if (operation === 'start') await startPersistentSignetHost(control);
  if (operation === 'stop') await stopPersistentSignetHost(control);
  if (!persistentSignetPid(control)) {
    console.log(JSON.stringify({ status: 'stopped', control: filename, stateNotDeleted: true, independentCustodyVerified, publicListeners: false }));
  } else {
    const { chain, indexes, network } = await assertPersistentSignetIdentity(control, false);
    const balances = await persistentSignetRpc(control)('getbalances', [], true);
    console.log(JSON.stringify({ status: 'running', network: 'default-Signet', blocks: chain.blocks, headers: chain.headers,
      initialBlockDownload: chain.initialblockdownload, txindexSynced: indexes.txindex?.synced === true,
      activePeers: network.connections, networkActive: network.networkactive,
      confirmedTestSats: Math.round(balances.mine.trusted * 1e8), pendingTestSats: Math.round(balances.mine.untrusted_pending * 1e8),
      control: filename, publicListeners: false, walletBroadcastDisabled: true, independentCustodyVerified,
      nativeReceivingWalletRestorationVerified: independentCustodyVerified }));
  }
} finally { lock?.release(); }
