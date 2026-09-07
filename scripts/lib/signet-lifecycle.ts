/** Private acceptance-driver utilities, not application custody or public fixtures. */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { asSats } from '../../src/types.js';
import { derivePresignedParticipantKeys, clearPresignedParticipantKeys } from '../../src/presigned/roster.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedRoster } from '../../src/presigned/types.js';
import { canonicalJson, networkParameters } from '../../src/presigned/validation.js';

export const SIGNET_CONTROL = '/tmp/btc-presigned-signet-GTIE40/control.json';
export const SIGNET_GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';
export const SIGNET_FIRST_BLOCK = '00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53';
export const CSV_BLOCKS = 3;
export const FUNDING_INPUT_SATS = 12_000;
export const SPONSOR_INPUT_SATS = 10_000;
export const DISTRIBUTION_FEE_CAP_SATS = 10_000;
export const MINIMUM_TEST_SATS = 19 * (3 * FUNDING_INPUT_SATS + SPONSOR_INPUT_SATS) + DISTRIBUTION_FEE_CAP_SATS;

export interface ScenarioDefinition {
  id: string;
  kind: 'solo' | 'cooperative' | 'recovery';
  order: ParticipantId[];
  recoverySigners: ParticipantId[];
}

export function scenarioDefinitions(): ScenarioDefinition[] {
  const cases: ScenarioDefinition[] = [];
  for (const first of PARTICIPANT_IDS) for (const second of PARTICIPANT_IDS.filter(id => id !== first)) {
    const last = PARTICIPANT_IDS.find(id => id !== first && id !== second)!;
    cases.push({ id: `solo-${first}-${second}-${last}`, kind: 'solo', order: [first, second, last], recoverySigners: [] });
  }
  cases.push({ id: 'cooperative-abc', kind: 'cooperative', order: [], recoverySigners: [] });
  for (const first of PARTICIPANT_IDS) cases.push({ id: `cooperative-after-${first}`, kind: 'cooperative', order: [first], recoverySigners: [] });
  for (const absent of PARTICIPANT_IDS) cases.push({ id: `recovery-abc-without-${absent}`, kind: 'recovery', order: [], recoverySigners: PARTICIPANT_IDS.filter(id => id !== absent) });
  for (const first of PARTICIPANT_IDS) for (const signer of PARTICIPANT_IDS.filter(id => id !== first))
    cases.push({ id: `recovery-after-${first}-signed-${signer}`, kind: 'recovery', order: [first], recoverySigners: [signer] });
  assert.equal(cases.length, 19);
  return cases;
}

export interface LocalWallet {
  kind: 'p2tr' | 'p2wpkh';
  /** Only serialized within authenticated encryption, never public state or logs. */
  privateKeyHex: string;
  publicKeyHex: string;
  scriptPubKeyHex: string;
}
export interface ScenarioMaterial {
  vaultId: string;
  epochId: string;
  participantSecrets: Record<ParticipantId, string>;
  wallets: Record<ParticipantId, LocalWallet>;
  sponsor: LocalWallet;
}
export interface RunMaterial { version: 1; runId: string; mode: 'offline' | 'live'; scenarios: Record<string, ScenarioMaterial> }

export function generateRunMaterial(runId: string, mode: RunMaterial['mode']): RunMaterial {
  return { version: 1, runId, mode, scenarios: Object.fromEntries(scenarioDefinitions().map((scenario, index) => [scenario.id, {
    vaultId: randomUUID(), epochId: randomUUID(),
    participantSecrets: Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomBytes(32).toString('base64url')])),
    wallets: Object.fromEntries(PARTICIPANT_IDS.map((id, position) => [id, randomWallet((index + position) % 2 ? 'p2wpkh' : 'p2tr')])),
    sponsor: randomWallet(index % 2 ? 'p2wpkh' : 'p2tr'),
  }])) as Record<string, ScenarioMaterial> };
}

function randomWallet(kind: LocalWallet['kind']): LocalWallet {
  let privateKey = randomBytes(32);
  while (!ecc.isPrivate(privateKey)) { privateKey.fill(0); privateKey = randomBytes(32); }
  try {
    const publicKey = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
    const script = kind === 'p2tr' ? bitcoin.payments.p2tr({ internalPubkey: publicKey.subarray(1), network: networkParameters('signet') }).output!
      : bitcoin.payments.p2wpkh({ pubkey: publicKey, network: networkParameters('signet') }).output!;
    return { kind, privateKeyHex: privateKey.toString('hex'), publicKeyHex: publicKey.toString('hex'), scriptPubKeyHex: Buffer.from(script).toString('hex') };
  } finally { privateKey.fill(0); }
}

export function scenarioRoster(material: ScenarioMaterial): PresignedRoster {
  const participants = PARTICIPANT_IDS.map(id => {
    const derived = derivePresignedParticipantKeys(material.participantSecrets[id], id, material.vaultId);
    try { return derived.publicIdentity; } finally { clearPresignedParticipantKeys(derived.keys); }
  });
  return { version: 2, protocol: PRESIGNED_PROTOCOL, vaultId: material.vaultId, network: 'signet', genesisHash: SIGNET_GENESIS,
    economics: { depositSatsPerParticipant: asSats(10_000), firstWithdrawalSats: asSats(9_500), secondWithdrawalSats: asSats(10_250),
      soloWithdrawalFeeSats: asSats(300), soloFeeBudgetSats: asSats(2_000), cooperativeFeeSats: asSats(300),
      recoveryFeeSats: asSats(500), finalSweepFeeSats: asSats(300), recoveryDelayBlocks: CSV_BLOCKS },
    feePolicy: { kind: 'confirmed-truc-payout-cpfp-v1', maxChildFeeSats: 10_000 }, participants };
}

/** Locally simulated independent external wallet, with fresh real keys on Signet. */
export function signLocalWalletPsbt(base64: string, index: number, wallet: LocalWallet): string {
  const psbt = bitcoin.Psbt.fromBase64(base64, { network: networkParameters('signet') });
  const expected = psbt.data.inputs[index]?.witnessUtxo;
  assert(expected && Buffer.from(expected.script).toString('hex') === wallet.scriptPubKeyHex, 'local wallet does not own the requested input');
  const secret = Buffer.from(wallet.privateKeyHex, 'hex');
  const publicKey = Buffer.from(wallet.publicKeyHex, 'hex');
  let adjusted: Buffer | undefined;
  let tweaked: Buffer | undefined;
  try {
    assert(ecc.isPrivate(secret) && Buffer.from(ecc.pointFromScalar(secret, true)!).equals(publicKey), 'encrypted local wallet key is inconsistent');
    if (wallet.kind === 'p2wpkh') psbt.signInput(index, { publicKey, sign: hash => ecc.sign(hash, secret) });
    else {
      psbt.updateInput(index, { tapInternalKey: publicKey.subarray(1) });
      adjusted = Buffer.from(publicKey[0] === 3 ? ecc.privateNegate(secret) : secret);
      tweaked = Buffer.from(ecc.privateAdd(adjusted, bitcoin.crypto.taggedHash('TapTweak', publicKey.subarray(1)))!);
      psbt.signInput(index, { publicKey: Buffer.from(ecc.pointFromScalar(tweaked, true)!),
        sign: () => { throw new Error('Taproot local wallet cannot produce an ECDSA signature'); }, signSchnorr: hash => ecc.signSchnorr(hash, tweaked!) });
    }
    return psbt.toBase64();
  } finally { secret.fill(0); adjusted?.fill(0); tweaked?.fill(0); }
}

export function privateDirectory(path: string): string {
  assert(isAbsolute(path) && resolve(path) === path && path !== '/' && !path.startsWith('/home/codex/btc-multiplayer-vault/'), 'private acceptance artifacts require an absolute directory outside the repository');
  const info = lstatSync(path);
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid!() && (info.mode & 0o077) === 0, 'acceptance directory must be owner-only and not a symlink');
  return path;
}

export function readPrivate(path: string): Buffer {
  privateDirectory(dirname(path));
  const info = lstatSync(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid!() && (info.mode & 0o077) === 0, 'acceptance file must be an owner-only regular file');
  return readFileSync(path);
}

export function writePrivate(path: string, bytes: string | Uint8Array): void {
  privateDirectory(dirname(path));
  if (existsSync(path)) readPrivate(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function newPrivateDirectories() {
  return { stateDirectory: mkdtempSync('/tmp/btc-presigned-signet-lifecycle-state-'),
    secretsDirectory: mkdtempSync('/tmp/btc-presigned-signet-lifecycle-credentials-') };
}

export function encryptMaterial(material: RunMaterial, key: Buffer): string {
  assert.equal(key.length, 32);
  const header = { version: 1, format: 'private-signet-lifecycle-material-v1', runId: material.runId, mode: material.mode, network: 'signet', genesisHash: SIGNET_GENESIS };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(canonicalJson(header)));
  const plaintext = Buffer.from(canonicalJson(material));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({ ...header, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
  } finally { plaintext.fill(0); }
}

export function decryptMaterial(serialized: string, key: Buffer, runId: string, mode: RunMaterial['mode']): RunMaterial {
  assert(serialized.length < 1_000_000 && key.length === 32);
  const { iv, ciphertext, tag, ...header } = JSON.parse(serialized);
  assert.equal(canonicalJson(header), canonicalJson({ version: 1, format: 'private-signet-lifecycle-material-v1', runId, mode, network: 'signet', genesisHash: SIGNET_GENESIS }));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(canonicalJson(header)));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
  try {
    const material = JSON.parse(plaintext.toString('utf8')) as RunMaterial;
    assert(material.version === 1 && material.runId === runId && material.mode === mode);
    assert.deepEqual(Object.keys(material.scenarios).sort(), scenarioDefinitions().map(item => item.id).sort());
    return material;
  } finally { plaintext.fill(0); }
}

interface SignetControl { version: number; network: string; genesisHash: string; rpcUrl: string; cookiePath: string; walletName: string; directory: string; coreVersion: number; existingWalletsUsed: boolean; publicListeners: boolean }

export class SignetRpc {
  readonly control: SignetControl;
  constructor(controlPath: string) {
    assert.equal(controlPath, SIGNET_CONTROL, 'this acceptance run is pinned to the explicitly assigned fresh Signet host');
    this.control = JSON.parse(readPrivate(controlPath).toString('utf8')) as SignetControl;
    const control = this.control;
    assert(control.version === 2 && control.network === 'signet' && control.genesisHash === SIGNET_GENESIS && control.coreVersion === 310100);
    assert(control.existingWalletsUsed === false && control.publicListeners === false);
    assert.equal(control.directory, dirname(controlPath));
    assert.equal(control.cookiePath, `${control.directory}/core/signet/.cookie`);
    assert.equal(control.walletName, 'presigned-v2-signet-acceptance');
    const url = new URL(control.rpcUrl);
    assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
      'Signet acceptance RPC must be the pinned loopback endpoint');
  }

  async call(method: string, params: unknown[] = [], wallet = false): Promise<any> {
    // Cookie is a transport credential. Never return it, record headers, or
    // include arbitrary transport exception details in evidence or console.
    const cookie = readFileSync(this.control.cookiePath, 'utf8').trim();
    let response: Response;
    try {
      response = await fetch(`${this.control.rpcUrl}${wallet ? `/wallet/${this.control.walletName}` : '/'}`, {
        method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'private-signet-lifecycle', method, params }),
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch { throw new Error(`assigned loopback Signet RPC transport failed during ${method}`); }
    const body = await response.json() as { result: any; error?: { code: number; message: string } };
    if (body.error) throw Object.assign(new Error(`assigned Signet RPC ${method} rejected request (code ${body.error.code})`), { rpcCode: body.error.code });
    return body.result;
  }

  async verify() {
    const [chain, network, indexes, wallets] = await Promise.all([this.call('getblockchaininfo'), this.call('getnetworkinfo'), this.call('getindexinfo'), this.call('listwallets')]);
    assert(chain.chain === 'signet' && chain.pruned === false && chain.initialblockdownload === false && chain.blocks === chain.headers, 'assigned default-Signet node must be fully synced and non-pruned');
    assert(network.version === 310100 && network.networkactive === true && network.connections > 0, 'assigned Signet Core must have the reviewed version and live peers');
    assert(indexes.txindex?.synced === true && indexes.txindex.best_block_height === chain.blocks, 'Signet txindex must be synced');
    assert.deepEqual(wallets, [this.control.walletName], 'acceptance host must contain only the assigned fresh wallet');
    assert.equal(await this.call('getblockhash', [0]), SIGNET_GENESIS);
    assert.equal(await this.call('getblockhash', [1]), SIGNET_FIRST_BLOCK);
    const wallet = await this.call('getwalletinfo', [], true);
    assert(wallet.walletname === this.control.walletName && wallet.descriptors === true && wallet.private_keys_enabled === true);
    return { height: chain.blocks as number, blockHash: chain.bestblockhash as string, coreVersion: network.version as number, peers: network.connections as number };
  }
}
