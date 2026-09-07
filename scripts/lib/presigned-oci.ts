/** Verify a single-platform OCI directory without extracting a filesystem. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, createReadStream, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const CONFIG = 'application/vnd.oci.image.config.v1+json';
const LAYER = 'application/vnd.oci.image.layer.v1.tar';
interface Descriptor { mediaType: string; digest: string; size: number }
export interface VerifiedOciImage {
  manifestDigest: string;
  configDigest: string;
  layerDigests: string[];
  rootfsDiffIds: string[];
  architecture: string;
  os: 'linux';
  network: 'signet' | 'mainnet';
  user: 'node';
  workingDirectory: '/app';
  command: ['node', 'scripts/start-production.mjs'];
}
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function descriptor(value: unknown, maximumBytes: number): Descriptor {
  const item = value as Descriptor;
  assert(item && typeof item.mediaType === 'string' && /^sha256:[0-9a-f]{64}$/u.test(item.digest) &&
    Number.isSafeInteger(item.size) && item.size > 0 && item.size <= maximumBytes, 'invalid or oversized OCI descriptor');
  return item;
}
function openRegular(filename: string, maximumBytes: number) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid?.() && stat.size > 0 && stat.size <= maximumBytes,
      'OCI evidence must contain bounded, owned, regular files');
    return { fd, size: stat.size };
  } catch (error) { closeSync(fd); throw error; }
}
function readRegular(filename: string, maximumBytes: number) {
  const { fd } = openRegular(filename, maximumBytes);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
function json(bytes: Buffer): any {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('OCI metadata is not valid JSON; no raw contents logged'); }
}
export async function verifyOciDirectory(directory: string): Promise<VerifiedOciImage> {
  directory = resolve(directory);
  const root = lstatSync(directory);
  assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o077) === 0,
    'OCI evidence root must be a private owned directory');
  for (const relative of ['blobs', 'blobs/sha256']) {
    const stat = lstatSync(join(directory, relative));
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.(), 'OCI blobs cannot traverse a symbolic link');
  }
  assert.deepEqual(json(readRegular(join(directory, 'oci-layout'), 1024)), { imageLayoutVersion: '1.0.0' });
  const index = json(readRegular(join(directory, 'index.json'), 1024 * 1024));
  assert(index.schemaVersion === 2 && Array.isArray(index.manifests) && index.manifests.length === 1,
    'acceptance requires one exact platform manifest, not a mutable tag or untested multi-platform index');
  const manifestDescriptor = descriptor(index.manifests[0], 4 * 1024 * 1024);
  assert.equal(manifestDescriptor.mediaType, MANIFEST);
  const blobPath = (item: Descriptor) => join(directory, 'blobs', 'sha256', item.digest.slice('sha256:'.length));
  const readBlob = (item: Descriptor) => {
    const bytes = readRegular(blobPath(item), item.size);
    assert(bytes.length === item.size && digest(bytes) === item.digest, 'OCI metadata blob digest or size differs');
    return json(bytes);
  };
  const manifest = readBlob(manifestDescriptor);
  assert(manifest.schemaVersion === 2 && manifest.mediaType === MANIFEST && Array.isArray(manifest.layers) &&
    manifest.layers.length > 0 && manifest.layers.length <= 128);
  const configDescriptor = descriptor(manifest.config, 4 * 1024 * 1024); assert.equal(configDescriptor.mediaType, CONFIG);
  const config = readBlob(configDescriptor);
  assert(config.os === 'linux' && ['amd64', 'arm64'].includes(config.architecture));
  assert(config.rootfs?.type === 'layers' && Array.isArray(config.rootfs.diff_ids) && config.rootfs.diff_ids.length === manifest.layers.length);
  assert(config.config?.User === 'node' && config.config.WorkingDir === '/app');
  assert.deepEqual(config.config.Cmd, ['node', 'scripts/start-production.mjs']);
  assert(!config.config.Entrypoint || config.config.Entrypoint.length === 0 ||
    JSON.stringify(config.config.Entrypoint) === JSON.stringify(['docker-entrypoint.sh']), 'unexpected image entrypoint');
  assert(Array.isArray(config.config.Env) && config.config.Env.every((item: unknown) => typeof item === 'string'));
  const environments = config.config.Env as string[];
  const value = (key: string) => {
    const entries = environments.filter(item => item.startsWith(`${key}=`));
    assert.equal(entries.length, 1, `OCI image needs one unambiguous ${key} build profile`);
    return entries[0]!.slice(key.length + 1);
  };
  const network = value('VAULT_NETWORK');
  assert((network === 'signet' || network === 'mainnet') && value('NEXT_PUBLIC_VAULT_NETWORK') === network);
  const layerDigests: string[] = []; let decodedTotal = 0;
  for (const [index, raw] of manifest.layers.entries()) {
    const item = descriptor(raw, 2 * 1024 * 1024 * 1024);
    assert(item.mediaType === LAYER || item.mediaType === `${LAYER}+gzip`, 'only reviewed gzip or uncompressed OCI layers are supported');
    assert(/^sha256:[0-9a-f]{64}$/u.test(config.rootfs.diff_ids[index]), 'invalid uncompressed layer digest');
    const file = openRegular(blobPath(item), item.size);
    if (file.size !== item.size) { closeSync(file.fd); throw new Error('OCI layer size differs from its descriptor'); }
    const encoded = createHash('sha256'); const decoded = createHash('sha256');
    const stream = createReadStream(blobPath(item), { fd: file.fd, autoClose: true });
    stream.on('data', chunk => encoded.update(chunk));
    const sink = new Writable({ write(chunk: Buffer, _encoding, next) {
      decodedTotal += chunk.length;
      if (decodedTotal > 8 * 1024 * 1024 * 1024) { next(new Error('decoded OCI image exceeds its acceptance bound')); return; }
      decoded.update(chunk); next();
    } });
    if (item.mediaType.endsWith('+gzip')) await pipeline(stream, createGunzip(), sink);
    else await pipeline(stream, sink);
    assert.equal(`sha256:${encoded.digest('hex')}`, item.digest, 'OCI encoded layer changed');
    assert.equal(`sha256:${decoded.digest('hex')}`, config.rootfs.diff_ids[index], 'OCI filesystem layer changed');
    layerDigests.push(item.digest);
  }
  return { manifestDigest: manifestDescriptor.digest, configDigest: configDescriptor.digest, layerDigests,
    rootfsDiffIds: config.rootfs.diff_ids, architecture: config.architecture, os: 'linux', network,
    user: 'node', workingDirectory: '/app', command: ['node', 'scripts/start-production.mjs'] };
}

/** A Docker/Podman config ID is NOT an OCI manifest digest. The exported
 * manifest, config bytes and every decoded filesystem layer are all checked
 * before connecting an executed local image ID to a deployable OCI artifact. */
export function assertOciRuntimeImage(image: VerifiedOciImage, inspected: any) {
  assert(inspected && typeof inspected === 'object');
  const id = inspected.Id ?? inspected.ID;
  assert(typeof id === 'string' && `sha256:${id.replace(/^sha256:/u, '')}` === image.configDigest,
    'executed image config differs from the verified OCI manifest');
  assert(inspected.Os === image.os && inspected.Architecture === image.architecture);
  assert.deepEqual(inspected.RootFS?.Layers, image.rootfsDiffIds, 'executed filesystem layers differ from the OCI artifact');
  assert(inspected.Config?.User === image.user && inspected.Config?.WorkingDir === image.workingDirectory);
  assert.deepEqual(inspected.Config.Cmd, image.command);
}
