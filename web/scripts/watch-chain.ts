import { pollVaultChain } from '../lib/server/vault-runtime-store';
import { assertReviewedNodeRuntime } from '../../src/runtime-version';

assertReviewedNodeRuntime();
const result = await pollVaultChain();
console.log(JSON.stringify({ ok: true, ...result }));
