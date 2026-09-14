import assert from 'node:assert/strict';
import { preparePublicCacheRetention, reclaimPublicCacheRetention, restorePublicCacheRetention,
  verifyPublicCacheRetention } from './lib/presigned-public-cache-retention.js';
process.umask(0o077);
const [mode = 'verify', ...args] = process.argv.slice(2);
assert(['verify','prepare','reclaim','restore'].includes(mode), 'use verify, prepare, reclaim or restore');
if (mode === 'verify' || mode === 'prepare') assert(args.length === 0, 'this profile accepts no path override');
if (mode === 'verify') {
  const result = await verifyPublicCacheRetention();
  console.log(JSON.stringify({ verified: true, dryRun: true, manifestPersisted: false, changedCacheFiles: 0,
    files: result.entries.length, bytes: result.bytes, contentManifestSha256: result.contentManifestSha256 }, null, 2));
} else if (mode === 'prepare') console.log(JSON.stringify(await preparePublicCacheRetention(), null, 2));
else {
  assert(args.length === 2 && args[0]!.startsWith('--manifest=') && /^--approve=[0-9a-f]{64}$/u.test(args[1]!),
    'explicit --manifest=ABSOLUTE_PATH --approve=EXACT_MANIFEST_DIGEST required');
  const input = { manifestPath: args[0]!.slice('--manifest='.length), approvedDigest: args[1]!.slice('--approve='.length) };
  console.log(JSON.stringify(await (mode === 'reclaim' ? reclaimPublicCacheRetention(input) : restorePublicCacheRetention(input)), null, 2));
}
