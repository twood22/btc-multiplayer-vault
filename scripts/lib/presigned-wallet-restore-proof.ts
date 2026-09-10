/** Actual native test-wallet backup/restore in a fresh network-disabled Core.
 * Synthetic, impossible-parent signatures prove every reserved native key is
 * present after restoration; no proof transaction can be broadcast or mined.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import * as bitcoin from 'bitcoinjs-lib';
import { nativeWalletWitnessFromPsbt, verifyNativeWalletWitness } from '../../src/presigned/wallet.js';
import { privateJournalDirectory, readPrivateJournalBytes, parsePrivateJournalJson, writePrivateJournalBytes } from './presigned-durable-journal.js';

export interface RestoredWalletTarget { address: string; scriptPubKeyHex: string }
interface WalletRestoreProof {
  version: 2; kind: 'isolated-native-wallet-all-targets-restored'; chain: 'signet' | 'regtest'; bindingDigest: string;
  binarySha256: string; backupSha256: string; coreVersion: 310100; targets: RestoredWalletTarget[];
  syntheticParentTransactionHex: string; syntheticSignedTransactionHex: string; checkedAt: string; challengeHex: string;
  networkingDisabled: true; publicConnections: 0; walletBroadcastDisabled: true; onlyRestoredTestWalletLoaded: true;
  actualRestoredNativeSignatures: number; proofTransactionsSent: 0; participantKeysImported: false; restoreNodeStopped: true;
  stopRpcAccepted: true; restoreExitCode: 0; restoreExitSignal: null;
}
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function restorationCommitment(proof: Pick<WalletRestoreProof,
  'chain' | 'bindingDigest' | 'binarySha256' | 'backupSha256' | 'targets' | 'checkedAt' | 'challengeHex'>) {
  assert(/^[0-9a-f]{64}$/u.test(proof.challengeHex) && Number.isFinite(Date.parse(proof.checkedAt)) &&
    [proof.bindingDigest, proof.binarySha256, proof.backupSha256].every(value => /^[0-9a-f]{64}$/u.test(value)));
  return hash(JSON.stringify({ domain: 'presigned-v2/native-wallet-restoration-challenge-v2', chain: proof.chain,
    bindingDigest: proof.bindingDigest, binarySha256: proof.binarySha256, backupSha256: proof.backupSha256,
    targets: proof.targets, checkedAt: proof.checkedAt, challengeHex: proof.challengeHex }));
}
function restorationParent(proof: Parameters<typeof restorationCommitment>[0]) {
  const parent = new bitcoin.Transaction(); parent.version = 2;
  parent.addInput(Buffer.alloc(32), 0xfffffffe, 0xfffffffe);
  for (const target of proof.targets) parent.addOutput(Buffer.from(target.scriptPubKeyHex, 'hex'), 10_000n);
  parent.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(restorationCommitment(proof), 'hex')]), 0n);
  return parent;
}
function checkedTargets(targets: RestoredWalletTarget[], chain: 'signet' | 'regtest') {
  assert(targets.length >= 1 && targets.length <= 128 && new Set(targets.map(item => item.scriptPubKeyHex)).size === targets.length,
    'native wallet recovery needs unique exact target scripts');
  for (const target of targets) {
    assert(/^(?:0014[0-9a-f]{40}|5120[0-9a-f]{64})$/u.test(target.scriptPubKeyHex), 'wallet target must be native');
    assert.equal(bitcoin.address.fromOutputScript(Buffer.from(target.scriptPubKeyHex, 'hex'),
      chain === 'signet' ? bitcoin.networks.testnet : bitcoin.networks.regtest), target.address, 'wallet target network/address binding changed');
  }
}
export function verifyNativeWalletRestoreProof(directory: string, expected: {
  chain: 'signet' | 'regtest'; bindingDigest: string; binarySha256: string; targets: RestoredWalletTarget[];
}) {
  assert(expected.chain === 'signet' || expected.chain === 'regtest', 'native restore proof never accepts a production network');
  privateJournalDirectory(directory, expected.chain === 'signet');
  const proofBytes = readPrivateJournalBytes(`${directory}/restore-proof.json`);
  const proof = parsePrivateJournalJson<WalletRestoreProof>(proofBytes);
  assert(proof.version === 2 && proof.kind === 'isolated-native-wallet-all-targets-restored' &&
    proof.chain === expected.chain && proof.bindingDigest === expected.bindingDigest && proof.binarySha256 === expected.binarySha256 &&
    proof.coreVersion === 310100 && JSON.stringify(proof.targets) === JSON.stringify(expected.targets), 'native wallet restoration binding changed');
  checkedTargets(proof.targets, proof.chain);
  assert(hash(readPrivateJournalBytes(`${directory}/wallet.dat`)) === proof.backupSha256, 'native wallet backup bytes changed');
  assert(proof.networkingDisabled && proof.publicConnections === 0 && proof.walletBroadcastDisabled && proof.onlyRestoredTestWalletLoaded &&
    proof.actualRestoredNativeSignatures === proof.targets.length && proof.proofTransactionsSent === 0 &&
    proof.participantKeysImported === false && proof.restoreNodeStopped === true && proof.stopRpcAccepted === true &&
    proof.restoreExitCode === 0 && proof.restoreExitSignal === null, 'native restore did not complete its isolated custody proof');
  const parent = bitcoin.Transaction.fromHex(proof.syntheticParentTransactionHex);
  assert.equal(parent.toHex(), restorationParent(proof).toHex(), 'native restoration signatures do not bind the exact backup, run and fresh challenge');
  const signed = bitcoin.Transaction.fromHex(proof.syntheticSignedTransactionHex);
  assert(signed.version === 2 && signed.locktime === 0 && signed.ins.length === proof.targets.length && parent.outs.length === proof.targets.length + 1);
  const coins = proof.targets.map((target, index) => {
    assert(parent.outs[index]!.value === 10_000n && Buffer.from(parent.outs[index]!.script).toString('hex') === target.scriptPubKeyHex);
    const input = signed.ins[index]!;
    assert(Buffer.from(input.hash).reverse().toString('hex') === parent.getId() && input.index === index && input.sequence === 0xfffffffe);
    return { scriptPubKeyHex: target.scriptPubKeyHex, valueSats: 10_000 };
  });
  assert(signed.outs.length === 1 && signed.outs[0]!.value === BigInt(proof.targets.length * 10_000 - 1000) &&
    Buffer.from(signed.outs[0]!.script).toString('hex') === proof.targets[0]!.scriptPubKeyHex);
  signed.ins.forEach((input, index) => verifyNativeWalletWitness(signed, index, coins, input.witness));
  return { actualRestoredNativeSignatures: proof.targets.length, backupSha256: proof.backupSha256, proofSha256: hash(proofBytes) };
}

export async function createNativeWalletRestoreProof(options: {
  parentDirectory: string; chain: 'signet' | 'regtest'; binary: string; binarySha256: string;
  bindingDigest: string; targets: RestoredWalletTarget[];
  sourceWalletRpc: (method: string, params?: unknown[]) => Promise<any>;
}) {
  assert(options.chain === 'signet' || options.chain === 'regtest', 'native restore proof never accepts a production network');
  privateJournalDirectory(options.parentDirectory, options.chain === 'signet');
  assert(/^[0-9a-f]{64}$/u.test(options.bindingDigest) && /^[0-9a-f]{64}$/u.test(options.binarySha256));
  const binary = lstatSync(options.binary);
  assert(options.binary.startsWith('/') && realpathSync(options.binary) === options.binary && binary.isFile() &&
    !binary.isSymbolicLink() && binary.uid === process.getuid?.() && binary.nlink === 1 && (binary.mode & 0o022) === 0,
    'native restore needs the exact owned reviewed executable');
  assert.equal(hash(readFileSync(options.binary)), options.binarySha256, 'restore Core executable changed');
  checkedTargets(options.targets, options.chain);
  const directory = mkdtempSync(`${options.parentDirectory}/wallet-restore-proof.`);
  const parentFd = openSync(options.parentDirectory, 'r'); try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  const backup = `${directory}/wallet.dat`;
  await options.sourceWalletRpc('backupwallet', [backup]);
  const backupSha256 = hash(readPrivateJournalBytes(backup));
  const backupFd = openSync(backup, 'r'); try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
  const rootFd = openSync(directory, 'r'); try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
  const datadir = `${directory}/restore-core`; const walletdir = `${directory}/restored-wallets`;
  mkdirSync(datadir, { mode: 0o700 }); mkdirSync(walletdir, { mode: 0o700 });
  writePrivateJournalBytes(`${directory}/empty.conf`, Buffer.alloc(0));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const args = [`-${options.chain}`, `-datadir=${datadir}`, `-walletdir=${walletdir}`, `-conf=${directory}/empty.conf`,
    '-nosettings', '-server=1', '-listen=0', '-discover=0', '-networkactive=0', '-dnsseed=0',
    '-walletbroadcast=0', '-persistmempool=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`, '-printtoconsole=0'];
  const child = spawn(options.binary, args, { stdio: 'ignore' });
  let exited = false; let spawnFailed = false; let exitCode: number | null = null; let exitSignal: NodeJS.Signals | null = null;
  child.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
  child.once('error', () => { spawnFailed = true; });
  const cookiePath = `${datadir}/${options.chain}/.cookie`;
  const walletName = 'isolated-native-restore-proof';
  const rpc = async (method: string, params: unknown[] = [], wallet = false): Promise<any> => {
    assert(['getnetworkinfo', 'getblockchaininfo', 'getblockhash', 'listwallets', 'restorewallet', 'getwalletinfo',
      'getaddressinfo', 'walletprocesspsbt', 'stop'].includes(method), 'unexpected restore-proof RPC');
    const cookie = readPrivateJournalBytes(cookiePath, 512).toString().trim();
    const response = await fetch(`http://127.0.0.1:${port}/${wallet ? `wallet/${walletName}` : ''}`, {
      method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'isolated-wallet-restore', method, params }),
      signal: AbortSignal.timeout(45_000), redirect: 'error' });
    const body = await response.json() as { result: any; error?: unknown };
    assert(response.ok && !body.error, `native wallet restore ${method} refused; private response omitted`);
    return body.result;
  };
  let proof: Omit<WalletRestoreProof, 'restoreNodeStopped' | 'stopRpcAccepted' | 'restoreExitCode' | 'restoreExitSignal'> | undefined;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt++) {
      assert(!exited && !spawnFailed, 'native restore node exited before readiness');
      if (existsSync(cookiePath)) { try { ready = (await rpc('getblockchaininfo')).chain === options.chain; } catch { /* startup only */ } }
      if (!ready) await pause(100);
    }
    assert(ready && child.pid, 'native restore node did not become ready');
    const actualArgs = readFileSync(`/proc/${child.pid}/cmdline`).toString().split('\0').filter(Boolean);
    assert.deepEqual(actualArgs, [options.binary, ...args], 'native restore process arguments changed');
    const sockets = execFileSync('ss', ['-H', '-ltnp'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`pid=${child.pid},`));
    assert(sockets.length === 1 && sockets[0]!.trim().split(/\s+/)[3] === `127.0.0.1:${port}`, 'native restore exposed an unexpected listener');
    const network = await rpc('getnetworkinfo');
    assert(network.version === 310100 && network.networkactive === false && network.connections === 0);
    assert.equal(await rpc('getblockhash', [0]), options.chain === 'signet'
      ? '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6'
      : '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206');
    assert.deepEqual(await rpc('listwallets'), [], 'native proof node loaded a prior wallet');
    await rpc('restorewallet', [walletName, backup, false]);
    assert.deepEqual(await rpc('listwallets'), [walletName]);
    const wallet = await rpc('getwalletinfo', [], true);
    assert(wallet.private_keys_enabled === true && wallet.descriptors === true && wallet.scanning === false);
    for (const target of options.targets) {
      const info = await rpc('getaddressinfo', [target.address], true);
      assert(info.ismine === true && info.solvable === true && info.scriptPubKey === target.scriptPubKeyHex,
        'restored native wallet cannot solve an exact reserved target');
    }
    const context = { chain: options.chain, bindingDigest: options.bindingDigest, binarySha256: options.binarySha256,
      backupSha256, targets: options.targets, checkedAt: new Date().toISOString(), challengeHex: randomBytes(32).toString('hex') };
    const parent = restorationParent(context);
    const psbt = new bitcoin.Psbt({ network: options.chain === 'signet' ? bitcoin.networks.testnet : bitcoin.networks.regtest });
    psbt.setVersion(2); psbt.setLocktime(0);
    for (const [index, target] of options.targets.entries()) psbt.addInput({ hash: parent.getId(), index, sequence: 0xfffffffe,
      witnessUtxo: { script: Buffer.from(target.scriptPubKeyHex, 'hex'), value: 10_000n }, nonWitnessUtxo: parent.toBuffer() });
    psbt.addOutput({ script: Buffer.from(options.targets[0]!.scriptPubKeyHex, 'hex'), value: BigInt(options.targets.length * 10_000 - 1000) });
    const response = await rpc('walletprocesspsbt', [psbt.toBase64(), true, 'ALL', true, false], true);
    const signedPsbt = bitcoin.Psbt.fromBase64(response.psbt);
    assert(Buffer.from(signedPsbt.data.globalMap.unsignedTx.toBuffer()).equals(Buffer.from(psbt.data.globalMap.unsignedTx.toBuffer())),
      'restored native wallet changed the synthetic proof template');
    const signed = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
    signedPsbt.data.inputs.forEach((input, index) => signed.setWitness(index, nativeWalletWitnessFromPsbt(input)));
    const after = await rpc('getnetworkinfo');
    assert(after.networkactive === false && after.connections === 0);
    proof = { version: 2, kind: 'isolated-native-wallet-all-targets-restored', ...context, coreVersion: 310100,
      syntheticParentTransactionHex: parent.toHex(), syntheticSignedTransactionHex: signed.toHex(),
      networkingDisabled: true, publicConnections: 0, walletBroadcastDisabled: true, onlyRestoredTestWalletLoaded: true,
      actualRestoredNativeSignatures: options.targets.length, proofTransactionsSent: 0, participantKeysImported: false };
  } finally {
    let stopRpcAccepted = false;
    try { if (!exited && !spawnFailed) { await rpc('stop'); stopRpcAccepted = true; } } catch { child.kill('SIGTERM'); }
    for (let attempt = 0; attempt < 600 && !exited && !spawnFailed; attempt++) await pause(100);
    assert(!spawnFailed && exited && stopRpcAccepted && exitCode === 0 && exitSignal === null,
      'native restore clean shutdown was not proved; retain and inspect the same process');
  }
  assert(proof && hash(readPrivateJournalBytes(backup)) === backupSha256, 'native restore proof is incomplete or altered its original backup');
  writePrivateJournalBytes(`${directory}/restore-proof.json`, Buffer.from(`${JSON.stringify({ ...proof,
    restoreNodeStopped: true, stopRpcAccepted: true, restoreExitCode: 0, restoreExitSignal: null })}\n`));
  return { directory, ...verifyNativeWalletRestoreProof(directory, options) };
}
