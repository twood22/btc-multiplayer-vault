// SDK integration-boundary tests. Actual SDK listKeys()/socket request code,
// isolated event emitters and synthetic credentials; no service/WASM/signatures.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SigbashClient, SigbashSocket, SDK_VERSION, conditionConfigToPoetPolicy } from '@sigbash/sdk';
import type { GetKeyResult, SigbashClientOptions, CreateKeyOptions, SignPSBTOptions } from '@sigbash/sdk';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { assertSigbashKeyBinding, createGuardedSigbashClient } from '../../src/sigbash-client-guard.js';
import { readProvisioningKeys } from '../../src/sigbash-provisioning-client.js';

const options = { serverUrl: 'https://sigbash.invalid', apiKey: '11'.repeat(32),
  userKey: '22'.repeat(32), userSecretKey: '33'.repeat(32), privateLogs: true };
const keys = new Map<number, { policy: object; mutable: boolean; policyUpdateCount?: number }>();
for (const index of [0, 1, 2]) keys.set(index, { policy: { version: 'test', policy: { index } }, mutable: false });
const instances: TestClient[] = [];
const globals = globalThis as Record<string, unknown>;
const originalCompiler = globals.SigbashWASM_CompilePOETPolicy;
let compilerCollision = false;
globals.SigbashWASM_CompilePOETPolicy = (input: string) => {
  const policy = JSON.parse(JSON.parse(input).policy);
  let index = 0;
  for (const child of policy.policy.children || []) {
    if (child.conditionType === 'OUTPUT_DEST_IS_IN_SETS') {
      child.conditionParams.list_id = `policy_embedded_${(compilerCollision ? 0 : index++).toString().padStart(3, '0')}`;
    }
  }
  return JSON.stringify({ compiled_policy_json: JSON.stringify(policy), policy_root: 'not-a-root-attestation' });
};
let fault: 'timeout' | 'wrong-key' | 'wrong-share' | 'wrong-kit' | 'wrong-recovery' | null = null;
let createLostAcknowledgement = false;
let createdCount = 0;
let signatureCount = 0;
let transportCount = 0;
const policyRoot = (index: number) => index.toString(16).padStart(64, '0');
const share = (index: number) => (index + 1).toString(16).padStart(64, '0');
function getResult(index: number): GetKeyResult {
  const entry = keys.get(index);
  if (!entry) throw new Error('controlled missing key');
  const keyMaterial = { bip328_xpub: `synthetic-xpub-${index}`,
    poet_policy_json: JSON.stringify(entry.policy),
    participants: [{ source: 'client', private_key_hex: share(index) }] };
  return { keyId: String(index), keyIndex: index, network: BITCOIN_NETWORK_NAME,
    policyRoot: policyRoot(index), require2FA: false, keyMaterial, kmcJSON: JSON.stringify(keyMaterial) };
}
const summary = (index: number) => ({ keyId: String(index), keyIndex: index,
  policyRoot: policyRoot(index), bip328Xpub: `synthetic-xpub-${index}`,
  poetJSON: keys.get(index)!.policy, updateable: keys.get(index)!.mutable,
  policyUpdateCount: keys.get(index)!.policyUpdateCount });

class TestClient extends SigbashClient {
  readonly emitter = new EventEmitter();
  requests = 0;
  closed = false;
  signingIndex: number | undefined;
  constructor(input: SigbashClientOptions) {
    // Do not initialize real WASM for the synthetic BYO-key tests.
    super({ ...input, musig2PrivateKey: undefined });
    instances.push(this);
    Object.defineProperty(this, '_authedFetch', { value: async () => new Response(JSON.stringify({
      success: true, keys: [...keys.keys()].map(index => ({ keyId: String(index), network: BITCOIN_NETWORK_NAME,
        policyRoot: policyRoot(index), require2FA: false, createdAt: null })),
    }), { status: 200 }) });
    Object.defineProperty(this, 'getKey', { writable: true, value: async (id: string, opts?: { verbose?: boolean; keyIndex?: number }) => {
      const index = Number(id);
      assert.equal(opts?.keyIndex, index, 'guard must not silently request slot zero');
      const injected = fault === 'timeout' || fault === 'wrong-key' || fault === 'wrong-share' ? fault : null;
      if (injected) fault = null;
      const reply = await this.request(index, injected === 'timeout');
      this.signingIndex ??= reply;
      if (!opts?.verbose) return summary(reply);
      const result = getResult(reply);
      if (injected === 'wrong-key') {
        // Echoed ID/index and even root look correct; decrypted contents do not.
        result.kmcJSON = getResult(index === 0 ? 1 : 0).kmcJSON;
      }
      if (injected === 'wrong-share') {
        const kmc = JSON.parse(result.kmcJSON);
        kmc.participants[0].private_key_hex = share(20);
        result.kmcJSON = JSON.stringify(kmc);
      }
      return result;
    } });
    Object.defineProperty(this, 'createKey', { value: async (input: CreateKeyOptions) => {
      assert.equal(input.updateable, false, 'immutability must be explicit at creation');
      const index = input.keyIndex!;
      if (keys.has(index)) throw new Error('controlled duplicate key index');
      const compiled = (globals.SigbashWASM_CompilePOETPolicy as (input: string) => string)(JSON.stringify({ policy: JSON.stringify(input.policy) }));
      keys.set(index, { policy: JSON.parse(JSON.parse(compiled).compiled_policy_json), mutable: false });
      createdCount += 1;
      if (createLostAcknowledgement) {
        createLostAcknowledgement = false;
        throw new Error('controlled create response lost after commit');
      }
      return { keyId: String(index), keyIndex: index, network: BITCOIN_NETWORK_NAME,
        require2FA: false, policyRoot: policyRoot(index), bip328Xpub: summary(index).bip328Xpub };
    } });
    Object.defineProperty(this, 'exportRecoveryKit', { value: async (id: string, opts: { keyIndex: number }) => {
      assert.equal(opts.keyIndex, Number(id));
      await this.request(Number(id));
      const wrong = fault === 'wrong-kit';
      if (wrong) fault = null;
      return { version: 'sdk-recovery-v1', keyId: wrong ? '0' : id, network: BITCOIN_NETWORK_NAME,
        apiKey: options.apiKey, userKey: options.userKey, recoveryKEK: '44'.repeat(32),
        cekCiphertext: '55'.repeat(48), cekNonce: '66'.repeat(12), createdAt: 1 };
    } });
    Object.defineProperty(this, 'recoverFromKit', { value: async (kit: { keyId: string }) => {
      await this.request(Number(kit.keyId));
      if (fault === 'wrong-recovery') { fault = null; return getResult(0); }
      return getResult(Number(kit.keyId));
    } });
    Object.defineProperty(this, 'verifyPSBT', { value: async () => ({ passed: true }) });
    Object.defineProperty(this, 'signPSBT', { value: async (input: SignPSBTOptions) => {
      assert.equal(this.signingIndex, Number(input.keyId), 'signing share must be restored only from the requested key');
      assert.equal(JSON.parse(input.kmcJSON).bip328_xpub, summary(this.signingIndex!).bip328Xpub);
      signatureCount += 1;
      return { success: true }; // Boundary result only, never consensus evidence.
    } });
  }
  async request(index: number, timeout = false): Promise<number> {
    assert.equal(this.closed, false);
    assert.equal(++this.requests, 1, 'a native client must never handle two KMC-family requests');
    const pending = SigbashSocket.prototype.request.call(
      { _socket: this.emitter } as unknown as SigbashSocket,
      'get_encrypted_kmc', { key_index: index }, 15,
    ) as Promise<{ index: number }>;
    if (timeout) setTimeout(() => this.emitter.emit('get_encrypted_kmc_response', { index }), 40);
    else queueMicrotask(() => this.emitter.emit('get_encrypted_kmc_response', { index }));
    return (await pending).index;
  }
  override disconnect(): void { this.closed = true; super.disconnect(); }
}
const transport = async <T>(fn: () => Promise<T>): Promise<T> => { transportCount += 1; return fn(); };
const runtime = { SDK_VERSION, SigbashClient: TestClient };
const client = createGuardedSigbashClient(runtime, options, transport);
const checks: string[] = [];
try {
  const listed = await client.listKeys();
  assert.deepEqual(listed.map(key => key.bip328Xpub), [0, 1, 2].map(index => summary(index).bip328Xpub));
  assert(instances.every(instance => instance.requests <= 1 && instance.closed));
  checks.push('actual SDK Promise.all enumeration returns independently bound keys on isolated transports');

  const key = await client.getKey('2', { verbose: true });
  assert.equal(key.keyIndex, 2);
  await client.signPSBT({ keyId: '2', kmcJSON: key.kmcJSON, psbtBase64: 'synthetic', network: BITCOIN_NETWORK_NAME });
  assert.equal(signatureCount, 1);
  assert.equal(transportCount, 1);
  checks.push('listing other keys cannot seed the subsequent signing client with the wrong share');

  fault = 'timeout';
  await assert.rejects(client.getKey('2', { verbose: true }), /timed out|timeout/iu);
  assert.equal((await client.getKey('2', { verbose: true })).keyIndex, 2);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await client.getKey('1', { verbose: true })).keyIndex, 1);
  checks.push('timeout and late reply cannot contaminate a retry or another key');

  fault = 'wrong-key';
  await assert.rejects(client.getKey('2', { verbose: true }), /summary does not match|expected key/u);
  const wrong = { ...getResult(2), kmcJSON: getResult(0).kmcJSON };
  assert.throws(() => assertSigbashKeyBinding(wrong, { ...summary(2), network: BITCOIN_NETWORK_NAME }), /decrypted key material/u);
  keys.get(1)!.mutable = true;
  await assert.rejects(client.getKey('1', { verbose: true }), /mutable/u);
  keys.get(1)!.mutable = false;
  keys.get(1)!.policyUpdateCount = 1;
  await assert.rejects(client.getKey('1', { verbose: true }), /mutable/u);
  delete keys.get(1)!.policyUpdateCount;
  checks.push('echoed identity, substituted KMC, and mutable existing keys cannot bypass binding');

  const privateKey = Uint8Array.from(Buffer.from(share(2), 'hex'));
  const byo = createGuardedSigbashClient(runtime, { ...options, musig2PrivateKey: privateKey }, transport);
  privateKey.fill(0);
  try {
    await byo.getKey('2', { verbose: true });
    fault = 'wrong-share';
    await assert.rejects(byo.getKey('2', { verbose: true }), /different participant signing share/u);
  } finally { byo.dispose(); }
  checks.push('BYO share is copied before caller erasure and checked against the decrypted round share');

  await client.exportRecoveryKit('2', { keyIndex: 2 });
  fault = 'wrong-kit';
  await assert.rejects(client.exportRecoveryKit('2'), /recovery kit differs/u);
  fault = 'wrong-recovery';
  await assert.rejects(client.exportRecoveryKit('2'), /decrypted key material/u);
  checks.push('fresh recovery-kit export and separate recovery round-trip reject wrong-key material');

  const policy = conditionConfigToPoetPolicy({ type: 'OUTPUT_VALUE', selector: 'ALL', operator: 'LTE', value: 10_000 });
  createLostAcknowledgement = true;
  await assert.rejects(client.createKey({ policy, keyIndex: 3, network: BITCOIN_NETWORK_NAME,
    require2FA: false, verbose: true }), /response lost/u);
  const resumed = (await client.listKeys()).find(item => item.keyId === '3');
  assert(resumed);
  assert.deepEqual(resumed.poetJSON, policy);
  await client.exportRecoveryKit('3');
  assert.equal(createdCount, 1);
  checks.push('creation with a lost acknowledgement is discovered and recoverable without another creation');

  const addressPolicy = conditionConfigToPoetPolicy({ logic: 'AND', conditions: [
    { type: 'OUTPUT_DEST_IS_IN_SETS', addresses: ['synthetic-address-a'], selector: { type: 'INDEX', index: 0 } },
    { type: 'OUTPUT_DEST_IS_IN_SETS', addresses: ['synthetic-address-b'], selector: { type: 'INDEX', index: 1 } },
  ] } as never);
  compilerCollision = true;
  await assert.rejects(client.createKey({ policy: addressPolicy, keyIndex: 4, network: BITCOIN_NETWORK_NAME,
    require2FA: false }), /collide/u);
  assert.equal(createdCount, 1, 'collision must be rejected before any native creation');
  compilerCollision = false;
  await client.createKey({ policy: addressPolicy, keyIndex: 4, network: BITCOIN_NETWORK_NAME, require2FA: false });
  assert.equal(createdCount, 2);
  await client.assertCompiledPolicy(addressPolicy, keys.get(4)!.policy);
  const substituted = structuredClone(keys.get(4)!.policy) as { policy: { children: Array<{ conditionParams: { list_id: string } }> } };
  substituted.policy.children[0]!.conditionParams.list_id = 'policy_embedded_999';
  await assert.rejects(client.assertCompiledPolicy(addressPolicy, substituted), /pinned compiler output/u);
  checks.push('compiler-shaped policies are validated, collisions abort before creation, and arbitrary ID substitution fails exact recompilation');

  const failedList = (message: string) => ({ listKeys: async (): Promise<never[]> => { throw new Error(message); } });
  assert.deepEqual(await readProvisioningKeys(failedList('request signature missing or invalid'), true), []);
  await assert.rejects(readProvisioningKeys(failedList('request signature missing or invalid'), false));
  for (const message of ['request timed out', 'internal server error', 'policy mismatch']) {
    await assert.rejects(readProvisioningKeys(failedList(message), true));
  }
  checks.push('only explicitly new organization setup recognizes the known pre-registration authentication response');

  const concurrent = createGuardedSigbashClient(runtime, options, transport);
  try {
    const [listedAgain, fetchedAgain] = await Promise.all([client.listKeys(), concurrent.getKey('2', { verbose: true })]);
    assert.equal(listedAgain.length, 5);
    assert.equal(fetchedAgain.keyIndex, 2);
    assert(instances.every(instance => instance.closed));
  } finally { concurrent.dispose(); }
  checks.push('concurrent logical clients finish with isolated key material and closed native transports');
} finally {
  client.dispose();
  if (originalCompiler === undefined) delete globals.SigbashWASM_CompilePOETPolicy;
  else globals.SigbashWASM_CompilePOETPolicy = originalCompiler;
}
await assert.rejects(client.getKey('0'), /disposed/u);
assert(instances.every(instance => instance.closed && instance.requests <= 1));
console.log(JSON.stringify({ network: BITCOIN_NETWORK_NAME, passed: true, liveProviderCalls: 0,
  realSignatures: 0, checks }, null, 2));
