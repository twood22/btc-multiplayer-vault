/** One fixed image execution plan shared by the producer and retained verifier. */
import assert from 'node:assert/strict';

export const IMAGE_EXECUTION_STAGES = ['rootless-preflight', 'build-image', 'inspect-image', 'export-oci',
  'runtime-identity', 'operator-runtime', 'browser-execution'] as const;
export type ImageExecutionStage = typeof IMAGE_EXECUTION_STAGES[number];
export function imageExecutionCommand(stage: ImageExecutionStage, network: 'signet' | 'mainnet', directory: string, imageId?: string) {
  assert((network === 'signet' || network === 'mainnet') && /^\/tmp\/btc-presigned-image\.[A-Za-z0-9]+$/u.test(directory));
  assert(IMAGE_EXECUTION_STAGES.includes(stage), 'unreviewed exact-image execution stage');
  const tag = `localhost/presigned-v2:acceptance-${network}-${directory.split('.').at(-1)!.toLowerCase()}`;
  const podman = (args: string[]) => ({ executable: 'podman' as const, args, environment: {} as Record<string, string> });
  if (stage === 'rootless-preflight') return podman(['info', '--format', 'json']);
  if (stage === 'build-image') return podman(['build', '--format', 'oci', '--ignorefile', '.dockerignore', '--pull=missing',
    '--authfile', `${directory}/empty-registry-auth.json`, '--build-arg', `VAULT_NETWORK=${network}`, '--tag', tag, '.']);
  if (stage === 'inspect-image') return podman(['image', 'inspect', tag]);
  assert(typeof imageId === 'string' && /^sha256:[0-9a-f]{64}$/u.test(imageId), 'actual immutable image config ID is required');
  if (stage === 'export-oci') return podman(['save', '--format', 'oci-dir', '--uncompressed', '--output', `${directory}/oci`, imageId]);
  if (stage === 'browser-execution') return { executable: 'bash' as const, args: ['scripts/run-presigned-browser-acceptance.sh'],
    environment: { PRESIGNED_BROWSER_NETWORK: network, PRESIGNED_BROWSER_CONTAINER_IMAGE_ID: imageId,
      BROWSER_TEST_BUILD_IDENTITY: `${directory}/build-identity.json` } };
  const lockedRun = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--entrypoint', 'node', imageId];
  if (stage === 'operator-runtime') return podman([...lockedRun, 'scripts/check-operator-runtime.mjs']);
  const identityProgram = `const fs=require('node:fs'),crypto=require('node:crypto');
    const build=JSON.parse(fs.readFileSync('vault-presigned-build.json','utf8'));
    const network=JSON.parse(fs.readFileSync('vault-build-network.json','utf8'));
    const utilityDigest=crypto.createHash('sha256').update(fs.readFileSync('public/offline/presigned-recovery.html')).digest('hex');
    console.log(JSON.stringify({build,network,utilityDigest,nodeVersion:process.versions.node,uid:process.getuid()}));`;
  return podman([...lockedRun, '-e', identityProgram]);
}
