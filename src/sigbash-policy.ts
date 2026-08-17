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
