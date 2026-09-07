/** Synthetic metadata/hash regressions, never a claim that a container ran. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { assertOciRuntimeImage, protectOwnedOciExport, verifyOciDirectory } from './lib/presigned-oci.js';

process.umask(0o077);
let negatives = 0;
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const parent = mkdtempSync('/tmp/btc-presigned-oci-boundary.');
const root = `${parent}/oci`;
mkdirSync(`${root}/blobs/sha256`, { recursive: true, mode: 0o700 });
const blob = (bytes: Buffer, mediaType: string) => {
  const digest = sha256(bytes);
  writeFileSync(`${root}/blobs/sha256/${digest.slice(7)}`, bytes, { mode: 0o600 });
  return { digest, size: bytes.length, mediaType };
};
const raw = Buffer.from('synthetic hashing payload: deliberately not a runnable tar layer');
const layer = blob(gzipSync(raw), 'application/vnd.oci.image.layer.v1.tar+gzip');
const configBody = { os: 'linux', architecture: 'amd64', rootfs: { type: 'layers', diff_ids: [sha256(raw)] },
  config: { User: 'node', WorkingDir: '/app', Cmd: ['node', 'scripts/start-production.mjs'],
    Env: ['VAULT_NETWORK=signet', 'NEXT_PUBLIC_VAULT_NETWORK=signet'] } };
const config = blob(Buffer.from(JSON.stringify(configBody)), 'application/vnd.oci.image.config.v1+json');
const manifest = blob(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config, layers: [layer] })), 'application/vnd.oci.image.manifest.v1+json');
writeFileSync(`${root}/oci-layout`, '{"imageLayoutVersion":"1.0.0"}', { mode: 0o600 });
const index = { schemaVersion: 2, manifests: [manifest] };
writeFileSync(`${root}/index.json`, JSON.stringify(index), { mode: 0o600 });
const checked = await verifyOciDirectory(root);
assert.equal(checked.manifestDigest, manifest.digest); assert.notEqual(checked.manifestDigest, checked.configDigest);
const inspected = { Id: config.digest.slice(7), Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [sha256(raw)] }, Config: configBody.config };
assertOciRuntimeImage(checked, inspected);
for (const altered of [
  { ...inspected, Id: manifest.digest }, { ...inspected, Architecture: 'arm64' },
  { ...inspected, RootFS: { Layers: [] } }, { ...inspected, Config: { ...inspected.Config, User: 'root' } },
  { ...inspected, Config: { ...inspected.Config, Cmd: ['node', 'another-app.js'] } },
]) { assert.throws(() => assertOciRuntimeImage(checked, altered)); negatives++; }
for (const changedIndex of [{ ...index, manifests: [] }, { ...index, manifests: [manifest, manifest] },
  { ...index, manifests: [{ ...manifest, digest: config.digest }] },
  { ...index, manifests: [{ ...manifest, size: manifest.size + 1 }] }]) {
  writeFileSync(`${root}/index.json`, JSON.stringify(changedIndex), { mode: 0o600 });
  await assert.rejects(() => verifyOciDirectory(root)); negatives++;
}
writeFileSync(`${root}/index.json`, JSON.stringify(index), { mode: 0o600 });
const path = `${root}/blobs/sha256/${layer.digest.slice(7)}`; const original = readFileSync(path);
writeFileSync(path, original.subarray(0, original.length - 1), { mode: 0o600 });
await assert.rejects(() => verifyOciDirectory(root)); negatives++;
writeFileSync(path, Buffer.alloc(original.length), { mode: 0o600 });
await assert.rejects(() => verifyOciDirectory(root)); negatives++;
writeFileSync(path, original, { mode: 0o600 });
chmodSync(root, 0o755); await assert.rejects(() => verifyOciDirectory(root)); negatives++;
symlinkSync(root, `${root}-link`); await assert.rejects(() => verifyOciDirectory(`${root}-link`)); negatives++;
assert.throws(() => protectOwnedOciExport(`${root}-link`)); negatives++;
assert.equal(lstatSync(root).mode & 0o777, 0o755, 'symlink rejection must not chmod its target');
chmodSync(parent, 0o755); assert.throws(() => protectOwnedOciExport(root)); negatives++; chmodSync(parent, 0o700);
writeFileSync(`${parent}/not-a-directory`, 'synthetic', { mode: 0o600 });
assert.throws(() => protectOwnedOciExport(`${parent}/not-a-directory`)); negatives++;
protectOwnedOciExport(root);
assert.equal(lstatSync(root).mode & 0o777, 0o700);
assert.equal((await verifyOciDirectory(root)).manifestDigest, manifest.digest);
console.log(JSON.stringify({ passed: true, negativeBoundaries: negatives, verifiedEncodedAndDecodedLayerHashes: true,
  manifestNotConfigDigest: true, privateExportPermissionsRestored: true, symlinkPermissionChangeRejected: true,
  syntheticNonRunnablePayload: true, actualContainerExecution: false, releaseReceiptProduced: false }));
