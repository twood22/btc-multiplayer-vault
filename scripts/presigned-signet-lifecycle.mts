/** Actual persistent default-Signet only. Never adopts operational wallets. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../src/presigned/core.js';
import { advanceLiveLifecycle, fundLiveLifecycle, initializeLiveLifecycle, lifecycleFilesSummary,
  verifyCompletedLiveLifecycle, type LiveLifecycleCore } from './lib/presigned-live-lifecycle.js';
import { createDurableLifecycleJournal, DurableLifecycleJournal, privateJournalDirectory } from './lib/presigned-durable-journal.js';
import { acquirePersistentSignetOperationLocks, assertPersistentSignetIdentity, DEFAULT_SIGNET_GENESIS, persistentSignetRpc,
  readPersistentSignetControl, verifyReceivingWalletRecovery } from './lib/presigned-signet-host-state.js';

process.umask(0o077);
const [operation, filename, capitalArgument, coinArgument] = process.argv.slice(2);
assert(process.argv.length === (operation === 'init' ? 6 : 4) &&
  ['init', 'status', 'fund', 'advance', 'follow', 'verify'].includes(operation ?? '') && filename,
  'usage: tsx scripts/presigned-signet-lifecycle.mts init|status|fund|advance|follow|verify /absolute/persistent/host/control.json [init only: --capital-limit-sats=N --initial-outpoint=TXID:VOUT]');
const capitalMatch = /^--capital-limit-sats=([1-9][0-9]{0,6})$/u.exec(capitalArgument ?? '');
const coinMatch = /^--initial-outpoint=([0-9a-f]{64}):([0-9]{1,8})$/u.exec(coinArgument ?? '');
assert(operation !== 'init' || (capitalMatch && coinMatch), 'init requires the exact capital limit and confirmed initial outpoint');
const control = readPersistentSignetControl(filename);
const call = persistentSignetRpc(control);
const runDirectory = `${control.directory}/lifecycle-v2`;
const binding = { sourceDigest: control.sourceDigest, chain: 'default-Signet' as const, actualGenesisHash: DEFAULT_SIGNET_GENESIS };
// One stable HOST inode also excludes start/stop while a lifecycle operation is
// signing. A long-running follow holds it continuously; crash/reboot releases it.
const lock = operation === 'status' ? null : acquirePersistentSignetOperationLocks(control);
try {
  readPersistentSignetControl(filename);
  await assertPersistentSignetIdentity(control, operation !== 'status');
  verifyReceivingWalletRecovery(control);
  if (operation === 'status') {
    const balances = await call('getbalances', [], true);
    const initialized = existsSync(`${runDirectory}/run.json`);
    if (initialized) new DurableLifecycleJournal(runDirectory, control.journalBackupDirectory, control.journalAnchorDirectory, binding).assertCurrent();
    console.log(JSON.stringify({ initialized, chain: binding.chain,
      confirmedTestSats: Math.round(balances.mine.trusted * 1e8), pendingTestSats: Math.round(balances.mine.untrusted_pending * 1e8),
      ...(initialized ? lifecycleFilesSummary(runDirectory) : {}), publicListeners: false }));
  } else {
    if (operation === 'init' && !existsSync(runDirectory)) mkdirSync(runDirectory, { mode: 0o700 });
    privateJournalDirectory(runDirectory, true);
    const durableJournal = operation === 'init' && !existsSync(`${runDirectory}/.checkpoint-fences`)
      ? createDurableLifecycleJournal(runDirectory, control.journalBackupDirectory, control.journalAnchorDirectory, binding)
      : new DurableLifecycleJournal(runDirectory, control.journalBackupDirectory, control.journalAnchorDirectory, binding);
    const rpc: PresignedCoreRpc = async <T,>(method: string, params: unknown[] = []) => await call(method, params) as T;
    const backend = createPresignedCoreBackend({ network: 'signet', genesisHash: DEFAULT_SIGNET_GENESIS, rpc });
    await backend.getTip();
    const core: LiveLifecycleCore = { ...binding, durableJournal, restorationParent: control.restorationParent,
      nativeWalletBackup: { binary: control.binaryPath, binarySha256: control.binarySha256, parentDirectory: control.nativeWalletBackupParent },
      rpc: async (method, params) => {
        assert(['getblockchaininfo', 'getblockhash', 'getblockheader', 'getmempoolentry', 'getrawtransaction', 'gettxout',
          'sendrawtransaction', 'submitpackage', 'testmempoolaccept'].includes(method), 'unexpected isolated lifecycle RPC');
        return call(method, params);
      },
      walletRpc: async (method, params = []) => {
        assert(['getnewaddress', 'getaddressinfo', 'getbalances', 'walletprocesspsbt', 'backupwallet'].includes(method), 'unexpected isolated wallet RPC');
        if (method === 'backupwallet') {
          const path = params[0]; assert(params.length === 1 && typeof path === 'string' && basename(path) === 'wallet.dat' &&
            dirname(dirname(path)) === control.nativeWalletBackupParent && /^wallet-restore-proof\.[A-Za-z0-9]{6}$/u.test(basename(dirname(path))));
          privateJournalDirectory(dirname(path), true); assert(!existsSync(path));
        }
        return call(method, params, true);
      }, observeCoin: outpoint => backend.observeConfirmedCoin(outpoint) };
    if (operation === 'verify') console.log(JSON.stringify(await verifyCompletedLiveLifecycle(core, runDirectory)));
    else if (operation === 'init') console.log(JSON.stringify({ ...await initializeLiveLifecycle(core, runDirectory, {
      capitalLimitSats: Number(capitalMatch![1]), initialOutpoint: { txid: coinMatch![1]!, vout: Number(coinMatch![2]) } }), evidence: runDirectory }));
    else if (operation === 'fund') console.log(JSON.stringify({ ...await fundLiveLifecycle(core, runDirectory), evidence: runDirectory }));
    else {
      let stopping = false; process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
      do {
        // Source/identity changes or transport failures stop this same writer;
        // they do not create another process or reinterpret a submitted intent.
        readPersistentSignetControl(filename); await assertPersistentSignetIdentity(control, true);
        const result = await advanceLiveLifecycle(core, runDirectory);
        console.log(JSON.stringify({ ...result, evidence: runDirectory }));
        if (operation !== 'follow' || result.complete || stopping) break;
        await pause(30_000);
      } while (!stopping);
    }
  }
} finally { lock?.release(); }
