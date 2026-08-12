import { pollVaultChain } from '../lib/server/vault-runtime-store';

const result = await pollVaultChain();
console.log(JSON.stringify({ ok: true, ...result }));
