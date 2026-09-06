import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const profilePath = () => resolve('vault-build-network.json');
function explicitNetwork() {
  const network = process.env.VAULT_NETWORK;
  if (!['mainnet', 'signet'].includes(network) || process.env.NEXT_PUBLIC_VAULT_NETWORK !== network) {
    throw new Error('production build/start requires explicit matching VAULT_NETWORK and NEXT_PUBLIC_VAULT_NETWORK');
  }
  return network;
}

/** Next.js embeds NEXT_PUBLIC values at build time; runtime env cannot switch it. */
export function assertBuildNetwork() {
  const network = explicitNetwork();
  const profile = JSON.parse(readFileSync(profilePath(), 'utf8'));
  if (profile.version !== 1 || profile.network !== network || Object.keys(profile).sort().join(',') !== 'network,version') {
    throw new Error('production runtime network differs from its immutable browser build profile');
  }
  return network;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--record' && process.argv.length === 3) {
    const network = explicitNetwork();
    writeFileSync(profilePath(), `${JSON.stringify({ version: 1, network })}\n`, { mode: 0o644 });
    console.log(`Recorded explicit ${network} browser build profile`);
  } else if (process.argv.length === 2) {
    console.log(`Verified ${assertBuildNetwork()} browser/runtime network binding`);
  } else throw new Error('usage: node scripts/check-build-network.mjs [--record]');
}
