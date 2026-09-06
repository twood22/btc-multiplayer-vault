import type {
  SigbashClient, SigbashClientOptions, GetKeyResult, KeySummary, KeyListItem,
  CreateKeyOptions, CreateKeyResult, SignPSBTOptions, VerifyPSBTOptions,
  SignPSBTResult, VerifyPSBTResult,
} from '@sigbash/sdk';
import type { SigbashRecoveryKit } from './sigbash.js';
import { Buffer } from 'buffer';
import { BITCOIN_NETWORK_NAME } from './network.js';
import { assertCompiledSigbashPolicy, assertNoRequestedListIds } from './sigbash-policy.js';

export type VaultSigbashClient = Pick<SigbashClient,
  'listKeys' | 'getKey' | 'createKey' | 'verifyPSBT' | 'signPSBT' |
  'exportRecoveryKit' | 'disconnect' | 'dispose'> & {
    assertCompiledPolicy(requested: unknown, compiled: unknown): Promise<void>;
  };
type Runtime = { SDK_VERSION?: string; SigbashClient: new (options: SigbashClientOptions) => SigbashClient };
type Binding = { keyId: string; keyIndex: number; network: string; policyRoot: string; bip328Xpub: string; poetJSON: object };

// The pinned SDK also mutates realm-global WASM/socket/fetch state. Hold this
// lock through transport cleanup, not just until a signing request is sent.
let sdkTail: Promise<void> = Promise.resolve();
async function exclusive<T>(action: () => Promise<T>): Promise<T> {
  const predecessor = sdkTail;
  let release!: () => void;
  sdkTail = new Promise<void>(resolve => { release = resolve; });
  await predecessor;
  try { return await action(); } finally { release(); }
}

/** Compare actual decrypted material, not the SDK's echoed keyId argument. */
export function assertSigbashKeyBinding(key: GetKeyResult, expected: Omit<Binding, 'poetJSON'> & { poetJSON: unknown }): void {
  const actual = bindingFromKey(key);
  if (actual.keyId !== expected.keyId || actual.keyIndex !== expected.keyIndex ||
      actual.network !== expected.network || actual.policyRoot !== expected.policyRoot ||
      actual.bip328Xpub !== expected.bip328Xpub || canonical(actual.poetJSON) !== canonical(expected.poetJSON)) {
    throw new Error('Sigbash decrypted key material differs from the expected key, network, or immutable policy');
  }
}

/**
 * SDK 0.8.0 adapter. Every KMC-family request owns a fresh native client/socket;
 * no failed or completed retrieval socket is reused for another retrieval.
 * This is a transport boundary, not a substitute signer or policy evaluator.
 */
export function createGuardedSigbashClient(
  sdk: Runtime,
  supplied: SigbashClientOptions,
  signTransport: <T>(action: () => Promise<T>) => Promise<T>,
): VaultSigbashClient {
  if (sdk.SDK_VERSION !== '0.8.0') throw new Error('Sigbash client guard requires the reviewed SDK 0.8.0 contract');
  const options: SigbashClientOptions = {
    ...supplied,
    ...(supplied.musig2PrivateKey ? {
      musig2PrivateKey: typeof supplied.musig2PrivateKey === 'string'
        ? Buffer.from(supplied.musig2PrivateKey, 'hex') : Uint8Array.from(supplied.musig2PrivateKey),
    } : {}),
  };
  const bindings = new Map<string, Binding>();
  const active = new Set<SigbashClient>();
  let disposed = false;
  const ensureOpen = () => { if (disposed) throw new Error('Sigbash vault client is disposed'); };
  const run = <T>(action: () => Promise<T>) => exclusive(async () => { ensureOpen(); return action(); });
  const native = async <T>(action: (client: SigbashClient) => Promise<T>): Promise<T> => {
    ensureOpen();
    const client = new sdk.SigbashClient(options);
    active.add(client);
    try {
      const result = await action(client);
      ensureOpen();
      return result;
    } finally {
      try { client.disconnect(); } finally {
        try { client.dispose(); } finally { active.delete(client); }
      }
    }
  };
  const remember = (key: GetKeyResult, checkShare = true): Binding => {
    const binding = bindingFromKey(key);
    const prior = bindings.get(binding.keyId);
    if (prior) assertSigbashKeyBinding(key, prior);
    if (checkShare) assertClientShare(key.kmcJSON, options.musig2PrivateKey);
    bindings.set(binding.keyId, structuredClone(binding));
    return binding;
  };
  const fetchKey = async (keyId: string, keyIndex?: number, checkShare = true): Promise<GetKeyResult> => {
    const index = checkedIndex(keyId, keyIndex);
    const key = await native<GetKeyResult>(client => client.getKey(keyId, { verbose: true, keyIndex: index }));
    if (key.keyId !== keyId || key.keyIndex !== index) throw new Error('Sigbash returned a different key index');
    // verbose getKey drops updateable metadata in SDK 0.8.0. Read its public
    // summary independently and reject reported mutability or policy history.
    // SDK 0.8.0 defaults omitted updateable to false and network to Signet:
    // this is not a provider-signed immutability/network attestation.
    const metadata = await native<KeySummary>(client => client.getKey(keyId, { keyIndex: index }));
    const actual = bindingFromKey(key);
    if (metadata.updateable !== false || (metadata.policyUpdateCount ?? 0) !== 0 ||
        metadata.policyLastUpdated !== undefined || metadata.keyId !== keyId || metadata.keyIndex !== index ||
        metadata.policyRoot !== actual.policyRoot || metadata.bip328Xpub !== actual.bip328Xpub ||
        canonical(metadata.poetJSON) !== canonical(actual.poetJSON)) {
      throw new Error('Sigbash key is mutable or its independent public summary does not match');
    }
    remember(key, checkShare);
    return key;
  };
  const checkKnownKmc = (kmcJSON: string): Binding => {
    const kmc = parseKmc(kmcJSON);
    const binding = [...bindings.values()].find(item =>
      item.bip328Xpub === kmc.bip328_xpub && canonical(item.poetJSON) === canonical(kmcPolicy(kmc)));
    if (!binding) throw new Error('Sigbash signing material was not retrieved and bound by this client');
    assertClientShare(kmcJSON, options.musig2PrivateKey);
    return binding;
  };

  const facade = {
    listKeys: () => run(async (): Promise<KeyListItem[]> => {
      const fetched = new Map<string, Binding>();
      const listed = await native(async client => {
        // Keep the SDK's authenticated REST enumeration. Redirect its PUBLIC
        // getKey method to sequential, isolated native clients so Promise.all
        // cannot fan out requests onto the enumerator's uncorrelated socket.
        let tail: Promise<unknown> = Promise.resolve();
        let failed = false;
        let count = 0;
        client.getKey = ((keyId: string) => {
          const task = tail.then(async () => {
            if (failed || ++count > 64 || fetched.has(keyId)) throw new Error('invalid or incomplete Sigbash key enumeration');
            const key = await fetchKey(keyId, undefined, false);
            const binding = bindingFromKey(key);
            fetched.set(keyId, binding);
            return keySummary(key);
          });
          tail = task.catch(() => { failed = true; });
          return task;
        }) as SigbashClient['getKey'];
        try { return await client.listKeys(); } finally { await tail; }
      });
      if (listed.length !== fetched.size) throw new Error('Sigbash key list contains repeated or missing identities');
      for (const item of listed) {
        const key = fetched.get(item.keyId);
        if (!key || item.network !== key.network || item.policyRoot !== key.policyRoot ||
            item.require2FA !== false || item.bip328Xpub !== key.bip328Xpub ||
            canonical(item.poetJSON) !== canonical(key.poetJSON)) {
          throw new Error('Sigbash key list metadata differs from independently retrieved key material');
        }
      }
      return listed;
    }),
    getKey: (keyId: string, opts?: { verbose?: boolean; keyIndex?: number }) => run(async () => {
      const key = await fetchKey(keyId, opts?.keyIndex);
      return opts?.verbose ? key : keySummary(key);
    }),
    assertCompiledPolicy: (requested: unknown, compiled: unknown) => run(async () => {
      assertCompiledSigbashPolicy(requested, compiled);
      if (canonical(compileExpectedPolicy(requested)) !== canonical(compiled)) {
        throw new Error('Sigbash stored policy differs from the pinned compiler output');
      }
    }),
    createKey: (suppliedInput: CreateKeyOptions) => {
      // The native SDK mutates its input policy during normalization. Snapshot
      // the user's intent before queuing, then pass the SDK a separate copy.
      const input = { ...suppliedInput, policy: structuredClone(suppliedInput.policy) };
      return run(async () => {
        if (input.network !== BITCOIN_NETWORK_NAME || input.require2FA !== false || input.updateable === true || !input.policy) {
          throw new Error('vault provisioning requires an immutable, non-TOTP policy on the configured network');
        }
        const index = checkedIndex(String(input.keyIndex ?? 0), input.keyIndex);
        // Detect deterministic address-list aliasing BEFORE creating an immutable
        // key. Never change a payout address or advance the slot to conceal it.
        const expectedPolicy = compileExpectedPolicy(input.policy);
        const created = await native<CreateKeyResult>(client => client.createKey({
          ...input, policy: structuredClone(input.policy), updateable: false, keyIndex: index, verbose: true,
        }));
        if (created.keyIndex !== index || created.keyId !== String(index) || created.network !== BITCOIN_NETWORK_NAME) {
          throw new Error('Sigbash created a different key identity');
        }
        const key = await fetchKey(created.keyId, index);
        const binding = bindingFromKey(key);
        if (binding.bip328Xpub !== created.bip328Xpub || binding.policyRoot !== created.policyRoot ||
            canonical(binding.poetJSON) !== canonical(expectedPolicy)) {
          throw new Error('Sigbash created key material that differs from the requested immutable policy');
        }
        return input.verbose ? created : keySummary(key);
      });
    },
    verifyPSBT: (input: VerifyPSBTOptions) => run(async () => {
      if (input.network !== BITCOIN_NETWORK_NAME) throw new Error('Sigbash verification network mismatch');
      checkKnownKmc(input.kmcJSON);
      return native<VerifyPSBTResult>(client => client.verifyPSBT(input));
    }),
    signPSBT: (input: SignPSBTOptions) => run(async () => {
      if (input.network !== BITCOIN_NETWORK_NAME) throw new Error('Sigbash signing network mismatch');
      const binding = checkKnownKmc(input.kmcJSON);
      if (binding.keyId !== input.keyId) throw new Error('Sigbash signing key differs from supplied key material');
      return native<SignPSBTResult>(async client => {
        // One getKey on this new signing client restores ONLY this round's
        // share for CLI callers without BYO keys. Never sign after a mismatch.
        const key = await client.getKey(binding.keyId, { verbose: true, keyIndex: binding.keyIndex });
        assertSigbashKeyBinding(key, binding);
        assertClientShare(key.kmcJSON, options.musig2PrivateKey);
        return signTransport(() => client.signPSBT({ ...input, kmcJSON: key.kmcJSON }));
      });
    }),
    exportRecoveryKit: (keyId: string, opts?: { keyIndex?: number }) => run(async () => {
      const index = checkedIndex(keyId, opts?.keyIndex);
      const key = await fetchKey(keyId, index);
      const binding = bindingFromKey(key);
      const kit = await native<SigbashRecoveryKit>(client => client.exportRecoveryKit(keyId, { keyIndex: index }));
      if (kit.version !== 'sdk-recovery-v1' || kit.keyId !== keyId || kit.network !== binding.network ||
          kit.apiKey !== options.apiKey || kit.userKey !== options.userKey) {
        throw new Error('Sigbash recovery kit differs from the requested key or credential owner');
      }
      // Supported SDK recovery uses the current server envelope, preferring
      // its recovery wrapping over the kit snapshot. This proves that path;
      // it is not a claim to have exercised loss of the server-side wrapping.
      const recovered = await native<GetKeyResult>(client => client.recoverFromKit(kit));
      assertSigbashKeyBinding(recovered, binding);
      assertClientShare(recovered.kmcJSON, options.musig2PrivateKey);
      return kit;
    }),
    disconnect: () => dispose(),
    dispose: () => dispose(),
  };
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    let failure: unknown;
    try {
      for (const client of active) {
        try { try { client.disconnect(); } finally { client.dispose(); } }
        catch (error) { failure ??= error; }
      }
    } finally {
      active.clear();
      bindings.clear();
      if (options.musig2PrivateKey instanceof Uint8Array) options.musig2PrivateKey.fill(0);
      options.apiKey = ''; options.userKey = ''; options.userSecretKey = '';
    }
    if (failure) throw failure;
  }
  return facade as VaultSigbashClient;
}

function checkedIndex(keyId: string, supplied?: number): number {
  const index = Number(keyId);
  if (!Number.isSafeInteger(index) || index < 0 || index > 63 || String(index) !== keyId ||
      (supplied !== undefined && supplied !== index)) throw new Error('Sigbash key ID/index is not canonical');
  return index;
}

/** Call only inside the realm-wide SDK lock, after verified runtime loading. */
function compileExpectedPolicy(requested: unknown): object {
  assertNoRequestedListIds(requested);
  const compiler = (globalThis as Record<string, unknown>).SigbashWASM_CompilePOETPolicy;
  if (typeof compiler !== 'function') throw new Error('pinned Sigbash policy compiler is not loaded');
  // For these vault conditions, compiled_policy_json is seed-independent;
  // policy_root is NOT. This public comparison seed is never used to create a
  // key, sign, or validate a policy root. The SDK uses its own credential salt.
  const result = JSON.parse(compiler(JSON.stringify({ policy: JSON.stringify(requested),
    network: BITCOIN_NETWORK_NAME, seed_hex: '99'.repeat(32) })) as string);
  if (result.error || typeof result.compiled_policy_json !== 'string') throw new Error('Sigbash policy comparison compilation failed');
  const compiled: unknown = JSON.parse(result.compiled_policy_json);
  assertCompiledSigbashPolicy(requested, compiled);
  if (!compiled || typeof compiled !== 'object' || Array.isArray(compiled)) throw new Error('Sigbash compiled policy is invalid');
  return compiled;
}
function parseKmc(value: string): Record<string, unknown> {
  let result: unknown;
  try { result = JSON.parse(value); } catch { throw new Error('Sigbash returned invalid key material'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Sigbash returned invalid key material');
  return result as Record<string, unknown>;
}
function kmcPolicy(kmc: Record<string, unknown>): object {
  let policy = kmc.poet_policy_json;
  if (typeof policy === 'string') {
    try { policy = JSON.parse(policy); } catch { throw new Error('Sigbash key material contains invalid policy JSON'); }
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Sigbash key material lacks its immutable policy');
  return policy;
}
function bindingFromKey(key: GetKeyResult): Binding {
  const kmc = parseKmc(key.kmcJSON);
  if (key.keyIndex !== checkedIndex(key.keyId, key.keyIndex)) throw new Error('Sigbash key material lacks its key index');
  if (key.network !== BITCOIN_NETWORK_NAME || key.require2FA !== false ||
      !/^[0-9a-f]{64}$/u.test(key.policyRoot) || typeof kmc.bip328_xpub !== 'string' || !kmc.bip328_xpub) {
    throw new Error('Sigbash returned incomplete or wrong-network key material');
  }
  return { keyId: key.keyId, keyIndex: key.keyIndex, network: key.network,
    policyRoot: key.policyRoot, bip328Xpub: kmc.bip328_xpub, poetJSON: kmcPolicy(kmc) };
}
function keySummary(key: GetKeyResult): KeySummary {
  const binding = bindingFromKey(key);
  return { keyId: binding.keyId, keyIndex: binding.keyIndex, policyRoot: binding.policyRoot,
    bip328Xpub: binding.bip328Xpub, poetJSON: binding.poetJSON, updateable: false };
}
function assertClientShare(kmcJSON: string, expected?: string | Uint8Array): void {
  if (!expected) return;
  const participants = parseKmc(kmcJSON).participants;
  const clients = Array.isArray(participants) ? participants.filter(item => item?.source === 'client') : [];
  const wanted = typeof expected === 'string' ? expected.toLowerCase() : Buffer.from(expected).toString('hex');
  if (clients.length !== 1 || clients[0].private_key_hex?.toLowerCase() !== wanted) {
    throw new Error('Sigbash key material contains a different participant signing share');
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
