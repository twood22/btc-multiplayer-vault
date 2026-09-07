'use client';
import { assert, hexBytes } from '../../../src/presigned/validation';
import { PRESIGNED_PROTOCOL } from '../../../src/presigned/types';

async function boundedFile(path: string, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  assert(response.ok && response.body, 'offline recovery utility is unavailable; retain all existing backups');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length; assert(size <= maximum, 'offline recovery download is oversized'); chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Integrity relative to the manifest, NOT independent trust in a compromised coordinator. */
export async function downloadVerifiedPresignedUtility() {
  const rawManifest = await boundedFile('/offline/presigned-recovery.manifest.json', 256 * 1024);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawManifest));
  assert(manifest.version === 2 && manifest.protocol === PRESIGNED_PROTOCOL && manifest.format === 'presigned-offline-utility-v1' &&
    manifest.artifact === 'presigned-recovery.html' && manifest.networkRequests === false && manifest.persistentSecretStorage === false,
    'offline utility manifest changed format or security properties');
  hexBytes(manifest.sha256, 32, 'offline utility SHA-256'); hexBytes(manifest.inputDigest, 32, 'offline utility input digest');
  const bytes = await boundedFile('/offline/presigned-recovery.html', 5 * 1024 * 1024);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  assert(bytes.length === manifest.byteLength && digest === manifest.sha256, 'offline utility bytes differ from the manifest');
  return { bytes, sha256: digest, inputDigest: manifest.inputDigest as string };
}
