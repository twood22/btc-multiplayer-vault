import type { PolicyCondition, PolicyNode, SoloPolicy } from './types.js';

/**
 * Convert the authoritative vault policy into the exact SDK condition-config
 * shape. Local-only key identifiers are deliberately removed: Sigbash binds
 * REQKEY through its own BIP-328 descriptor during key creation.
 */
export function sigbashConditionConfig(policy: PolicyNode | SoloPolicy): unknown {
  if ('logic' in policy) {
    return {
      logic: policy.logic,
      conditions: policy.conditions.map((condition) => sigbashConditionConfig(condition)),
    };
  }
  const { local_key_identifier: _local, ...condition } = policy as PolicyCondition & {
    local_key_identifier?: string;
  };
  return condition;
}

/**
 * SDK 0.8.0's pinned compiler adds policy_embedded_NNN identifiers to inline
 * output address sets. These are lookup keys, NOT arbitrary ignorable metadata.
 * Preserve every condition/address and reject identifier aliasing. This pure
 * server/browser check is not an attestation of a hosted key or its policy root.
 */
export function assertCompiledSigbashPolicy(requested: unknown, compiled: unknown): void {
  assertNoRequestedListIds(requested);
  const idToSet = new Map<string, string>();
  const setToId = new Map<string, string>();
  let inlineSets = 0;
  let identifiers = 0;
  let visited = 0;
  function normalize(value: unknown, depth = 0): unknown {
    if (++visited > 4096 || depth > 32) throw new Error('Sigbash policy is too complex');
    if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, 'list_id')) throw new Error('Sigbash list identifier is outside an inline output address set');
    const result = { ...node };
    const params = node.conditionParams;
    if (node.type === 'condition' && node.conditionType === 'OUTPUT_DEST_IS_IN_SETS' &&
        params && typeof params === 'object' && !Array.isArray(params)) {
      const fields = params as Record<string, unknown>;
      if (Array.isArray(fields.addresses) && fields.addresses.length > 0 &&
          fields.addresses.every(address => typeof address === 'string') &&
          !Object.hasOwn(fields, 'use_descriptor')) {
        inlineSets += 1;
        if (Object.hasOwn(fields, 'list_id')) {
          const id = fields.list_id;
          if (typeof id !== 'string' || !/^policy_embedded_[0-9]{3}$/u.test(id)) {
            throw new Error('Sigbash compiled policy has an unsupported address-list identifier');
          }
          const set = canonicalPolicy(fields.addresses);
          if ((idToSet.has(id) && idToSet.get(id) !== set) ||
              (setToId.has(set) && setToId.get(set) !== id)) {
            throw new Error('Sigbash compiled address-list identifiers collide or disagree; do not create or fund this key');
          }
          idToSet.set(id, set); setToId.set(set, id); identifiers += 1;
          const { list_id: _identifier, ...rest } = fields;
          result.conditionParams = rest;
        }
      }
    }
    return Object.fromEntries(Object.entries(result).map(([name, item]) => [name, normalize(item, depth + 1)]));
  }
  const normalized = normalize(compiled);
  if (identifiers !== 0 && identifiers !== inlineSets) throw new Error('Sigbash compiled policy has incomplete address-list identifiers');
  if (canonicalPolicy(requested) !== canonicalPolicy(normalized)) {
    throw new Error('Sigbash compiled policy differs from the exact canonical vault policy');
  }
}

export function sigbashCompiledPolicyMatches(requested: unknown, compiled: unknown): boolean {
  try { assertCompiledSigbashPolicy(requested, compiled); return true; } catch { return false; }
}

export function assertNoRequestedListIds(policy: unknown): void {
  let visited = 0;
  function walk(value: unknown, depth = 0): void {
    if (++visited > 4096 || depth > 32) throw new Error('Sigbash policy is too complex');
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'list_id')) throw new Error('canonical Sigbash policy must not preselect address-list identifiers');
    for (const item of Object.values(value)) walk(item, depth + 1);
  }
  walk(policy);
}

export function canonicalPolicy(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPolicy).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, item]) => `${JSON.stringify(name)}:${canonicalPolicy(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
