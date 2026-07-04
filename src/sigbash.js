import { assertNonDefaultSeed } from './config.js';

export async function createSigbashAdapter() {
  if (process.env.SIGBASH_MODE === 'live') {
    return LiveSigbashAdapter.create();
  }
  return new LocalSigbashAdapter();
}

export class LocalSigbashAdapter {
  async verifyPSBT(tx, policy) {
    const failures = evaluatePolicy(tx, policy);
    return {
      success: failures.length === 0,
      failures,
      mode: 'local',
    };
  }

  async signPSBT(tx, policy) {
    const verified = await this.verifyPSBT(tx, policy);
    if (!verified.success) {
      return {
        success: false,
        error: verified.failures.join('; '),
        mode: 'local',
      };
    }
    return {
      success: true,
      psbt: { ...tx, sigbashSignature: `local-sigbash-ok:${policy.id}` },
      mode: 'local',
    };
  }
}

class LiveSigbashAdapter {
  static async create() {
    const { sdk, client } = await createLiveSigbashClient();
    return new LiveSigbashAdapter(sdk, client);
  }

  constructor(sdk, client) {
    this.sdk = sdk;
    this.client = client;
  }

  toPoetPolicy(policy) {
    return this.sdk.conditionConfigToPoetPolicy(toConditionConfig(policy));
  }

  async createKey(policy, keyIndex) {
    return this.client.createKey({
      policy: this.toPoetPolicy(policy),
      network: 'signet',
      require2FA: false,
      keyIndex,
      verbose: true,
    });
  }

  async updatePolicy(keyId, policy) {
    const poetPolicy = this.toPoetPolicy(policy);
    return this.client.updatePolicy({
      keyId,
      newPolicyJson: JSON.stringify(poetPolicy),
    });
  }

  async verifyPSBT(tx, policy) {
    if (!tx.psbtBase64 || !policy.keyId) {
      throw new Error('live verification requires tx.psbtBase64 and policy.keyId to fetch kmcJSON');
    }
    const { kmcJSON } = await this.client.getKey(policy.keyId, { verbose: true });
    return this.client.verifyPSBT({
      psbtBase64: tx.psbtBase64,
      kmcJSON,
      network: 'signet',
    });
  }

  async signPSBT(tx, policy) {
    if (!tx.psbtBase64 || !policy.keyId) {
      throw new Error('live signing requires tx.psbtBase64 and policy.keyId');
    }
    const { kmcJSON } = await this.client.getKey(policy.keyId, { verbose: true });
    return this.client.signPSBT({
      keyId: policy.keyId,
      psbtBase64: tx.psbtBase64,
      kmcJSON,
      network: 'signet',
    });
  }
}

export async function createLiveSigbashClient({ participantId, musig2PrivateKey } = {}) {
  // Live Sigbash keys must never be bound to client shares derived from the
  // public default demo seed — anyone could reproduce the "browser half".
  assertNonDefaultSeed();
  let sdk;
  try {
    sdk = await import('@sigbash/sdk');
  } catch (error) {
    throw new Error(
      `SIGBASH_MODE=live requires @sigbash/sdk to be installed: ${error.message}`,
    );
  }

  const wasmUrl = process.env.SIGBASH_WASM_URL || 'https://www.sigbash.com/sigbash.wasm';
  await sdk.loadWasm({ wasmUrl });
  const client = new sdk.SigbashClient({
    serverUrl: process.env.SIGBASH_SERVER_URL || 'https://www.sigbash.com',
    apiKey: participantEnv('SIGBASH_API_KEY', participantId),
    userKey: participantEnv('SIGBASH_USER_KEY', participantId),
    userSecretKey: participantEnv('SIGBASH_SECRET_KEY', participantId),
    ...(musig2PrivateKey ? { musig2PrivateKey } : {}),
  });
  return { sdk, client };
}

// Each participant should hold their own Sigbash credential triplet
// (SIGBASH_API_KEY_ALICE etc.). A shared triplet without suffix is accepted
// for single-operator demo runs, with the trust caveat noted in the README.
function participantEnv(name, participantId) {
  if (participantId) {
    const scoped = process.env[`${name}_${participantId.toUpperCase()}`];
    if (scoped) return scoped;
  }
  return requiredEnv(name);
}

export function toPoetPolicy(sdk, policy) {
  return sdk.conditionConfigToPoetPolicy(toConditionConfig(policy));
}

export function evaluatePolicy(tx, policy) {
  return evaluateNode(tx, policy);
}

function evaluateNode(tx, node) {
  if (node.logic) {
    const childResults = node.conditions.map((condition) => evaluateNode(tx, condition));
    if (node.logic === 'AND') {
      return childResults.flat();
    }
    if (node.logic === 'OR') {
      const passing = childResults.find((failures) => failures.length === 0);
      if (passing) return [];
      return childResults.map((failures, index) => `branch ${index} failed: ${failures.join(', ')}`);
    }
    throw new Error(`unsupported policy logic ${node.logic}`);
  }

  const failures = [];
  if (node.type === 'OUTPUT_VALUE') {
    const output = tx.outputs[node.selector.index];
    if (!output) {
      failures.push(`missing output ${node.selector.index}`);
    } else if (!compare(output.value, node.operator, node.value)) {
      failures.push(
        `output ${node.selector.index} value ${output.value} failed ${node.operator} ${node.value}`,
      );
    }
  } else if (node.type === 'OUTPUT_DEST_IS_IN_SETS') {
    const output = tx.outputs[node.selector.index];
    if (!output) {
      failures.push(`missing output ${node.selector.index}`);
    } else if (!node.addresses.includes(output.address)) {
      failures.push(`output ${node.selector.index} address is not allowed`);
    }
  } else if (node.type === 'TX_OUTPUT_COUNT') {
    if (!compare(tx.outputs.length, node.operator, node.value)) {
      failures.push(`output count ${tx.outputs.length} failed ${node.operator} ${node.value}`);
    }
  } else if (node.type === 'TX_INPUT_COUNT') {
    const inputCount = tx.inputCount ?? (tx.input ? 1 : 0);
    if (!compare(inputCount, node.operator, node.value)) {
      failures.push(`input count ${inputCount} failed ${node.operator} ${node.value}`);
    }
  } else if (node.type === 'REQKEY') {
    const expectedKey = node.local_key_identifier || node.key_identifier;
    if (tx.sigbashLeafKey !== expectedKey) {
      failures.push('required Sigbash tapscript key is missing');
    }
  } else {
    failures.push(`unsupported condition ${node.type}`);
  }
  return failures;
}

// Convert the repo's policy objects into the SDK's condition-config shorthand.
// Fields that only exist for the local policy model (ids, round metadata, the
// local REQKEY key material) are stripped so Sigbash receives a clean policy.
function toConditionConfig(policy) {
  if (policy.logic) {
    return {
      logic: policy.logic,
      conditions: policy.conditions.map((condition) => toConditionConfig(condition)),
    };
  }
  const { id, leaverId, roundIds, local_key_identifier, ...condition } = policy;
  return condition;
}

function compare(actual, operator, expected) {
  switch (operator) {
    case 'EQ':
      return actual === expected;
    case 'GTE':
      return actual >= expected;
    case 'LTE':
      return actual <= expected;
    case 'GT':
      return actual > expected;
    case 'LT':
      return actual < expected;
    case 'NEQ':
      return actual !== expected;
    default:
      throw new Error(`unsupported operator ${operator}`);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in SIGBASH_MODE=live`);
  return value;
}
