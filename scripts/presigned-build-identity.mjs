import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const protocol = 'presigned-graph-v2';
const roots = ['app', 'src', 'web', 'db', 'scripts', 'offline', '.github'];
const files = ['package.json', 'package-lock.json', '.node-version', '.npmrc', 'next.config.ts', 'proxy.ts', 'instrumentation.ts',
  'tsconfig.json', 'tsconfig.web.json', 'tsconfig.offline.json', 'tsconfig.scripts.json', 'Dockerfile', '.dockerignore', 'playwright.config.ts'];
export function presignedSourceDigest(repository = process.cwd()) {
  const entries = [];
  function add(relative) {
    const absolute = resolve(repository, relative);
    if (!existsSync(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('source identity does not follow symbolic links');
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) add(`${relative}/${child}`);
    } else if (/\.(?:[cm]?[jt]sx?|sql|sh|json|css|html|ya?ml)$/u.test(relative) || files.includes(relative)) {
      entries.push({ path: relative, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') });
    }
  }
  for (const item of [...roots, ...files]) add(item);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return createHash('sha256').update(JSON.stringify({ protocol, entries })).digest('hex');
}
export function recordPresignedBuildIdentity() {
  const network = process.env.VAULT_NETWORK;
  if (!['mainnet', 'signet'].includes(network) || process.env.NEXT_PUBLIC_VAULT_NETWORK !== network)
    throw new Error('presigned build needs explicit matching browser/runtime networks');
  const profile = { version: 2, protocol, network, sourceDigest: presignedSourceDigest() };
  writeFileSync('vault-presigned-build.json', `${JSON.stringify(profile)}\n`, { mode: 0o644 });
  return profile;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('usage: node scripts/presigned-build-identity.mjs');
  console.log(JSON.stringify(recordPresignedBuildIdentity()));
}
