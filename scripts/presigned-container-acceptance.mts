/** Build and actually exercise one private, rootless, exact OCI image. No push. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { assertReviewedNodeRuntime } from '../src/runtime-version.js';
import { commitmentDigest } from '../src/presigned/validation.js';
import { acceptanceEnvironment, parseAcceptanceJson, readPrivateAcceptanceFile, validateBrowserAcceptance, writeAcceptanceJson } from './lib/presigned-acceptance-run.js';
import { imageExecutionCommand, type ImageExecutionStage } from './lib/presigned-image-commands.js';
import { assertOciRuntimeImage, verifyOciDirectory } from './lib/presigned-oci.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';

process.umask(0o077); assertReviewedNodeRuntime();
const network = process.argv[2];
assert(process.argv.length === 3 && (network === 'signet' || network === 'mainnet'),
  'usage: tsx scripts/presigned-container-acceptance.mts signet|mainnet (format only; no public Bitcoin broadcast)');
assert(process.platform === 'linux' && process.getuid?.() !== 0, 'this runner requires local Linux rootless Podman');
for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local'])
  assert(!existsSync(filename), 'container acceptance must not run beside operational dotenv files');
if (existsSync('.npmrc')) assert(!/(?:_auth|token|password|secret)/iu.test(readFileSync('.npmrc', 'utf8')),
  'refusing a build context containing npm authentication configuration');
const directory = mkdtempSync('/tmp/btc-presigned-image.');
const sourceDigest = presignedSourceDigest(); const createdAt = new Date().toISOString();
const environment = acceptanceEnvironment(network);
// Public base-image downloads must not silently use an operational registry login.
writeAcceptanceJson(`${directory}/empty-registry-auth.json`, { auths: {} });
environment.REGISTRY_AUTH_FILE = `${directory}/empty-registry-auth.json`;
const commands: Array<{ stage: ImageExecutionStage; command: ReturnType<typeof imageExecutionCommand>; exitCode: 0;
  startedAt: string; completedAt: string; commandDigest: string; stdoutSha256: string; stderrSha256: string }> = [];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function run(stage: ImageExecutionStage, imageId?: string) {
  assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during exact-image acceptance');
  const command = imageExecutionCommand(stage, network as 'signet' | 'mainnet', directory, imageId);
  const startedAt = new Date().toISOString();
  console.log(JSON.stringify({ stage, network, evidence: directory }));
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let length = 0;
  const child = spawn(command.executable, command.args, { cwd: process.cwd(), env: { ...environment, ...command.environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) child.kill('SIGTERM'); else target.push(Buffer.from(chunk));
  };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new Error(`${stage}: local rootless Podman/acceptance executable is unavailable; no host policy was changed`)));
    child.once('close', resolve);
  });
  const out = Buffer.concat(stdout); const err = Buffer.concat(stderr);
  writeFileSync(`${directory}/${stage}.stdout.log`, out, { mode: 0o600, flag: 'wx' });
  writeFileSync(`${directory}/${stage}.stderr.log`, err, { mode: 0o600, flag: 'wx' });
  assert(code === 0 && length <= 32 * 1024 * 1024, `${stage} failed; inspect its protected log, not a fabricated success receipt`);
  assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during exact-image execution');
  commands.push({ stage, command, startedAt, completedAt: new Date().toISOString(), exitCode: 0,
    commandDigest: commitmentDigest('vault/presigned-graph-v2/image-command', command),
    stdoutSha256: sha256(out), stderrSha256: sha256(err) });
  return out;
}
try {
  const info = parseAcceptanceJson(await run('rootless-preflight')) as any;
  assert(info.host?.security?.rootless === true, 'rootless container isolation is required; do not weaken user-namespace or security policy');
  await run('build-image');
  const inspected = parseAcceptanceJson(await run('inspect-image')) as any[];
  assert(Array.isArray(inspected) && inspected.length === 1);
  const rawId = inspected[0].Id ?? inspected[0].ID;
  assert(typeof rawId === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/u.test(rawId));
  const imageId = `sha256:${rawId.replace(/^sha256:/u, '')}`;
  await run('export-oci', imageId);
  const image = await verifyOciDirectory(`${directory}/oci`);
  assert.equal(image.network, network); assertOciRuntimeImage(image, inspected[0]);
  assert.equal(image.architecture, process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : 'unsupported',
    'only actual native-platform image execution counts');
  const identity = parseAcceptanceJson(await run('runtime-identity', imageId)) as any;
  assert(identity.build?.version === 2 && identity.build.protocol === 'presigned-graph-v2' && identity.build.sourceDigest === sourceDigest &&
    identity.build.network === network && identity.network?.version === 1 && identity.network.network === network);
  assert(identity.nodeVersion === readFileSync('.node-version', 'utf8').trim() && identity.uid > 0 && /^[0-9a-f]{64}$/u.test(identity.utilityDigest));
  writeAcceptanceJson(`${directory}/build-identity.json`, identity.build);
  await run('operator-runtime', imageId);
  const output = (await run('browser-execution', imageId)).toString();
  const paths = [...output.matchAll(/Owner-only browser acceptance evidence: (\/tmp\/btc-presigned-browser\.[A-Za-z0-9]+)/gu)];
  assert.equal(paths.length, 1, 'exact image browser runner did not retain one private evidence directory');
  const browserBytes = readPrivateAcceptanceFile(`${paths[0]![1]}/presigned-browser-acceptance.json`);
  const browser = parseAcceptanceJson(browserBytes) as any;
  validateBrowserAcceptance(browser, sourceDigest, network);
  const runtimeBytes = readPrivateAcceptanceFile(`${paths[0]![1]}/container-runtime.json`);
  const runtime = parseAcceptanceJson(runtimeBytes) as any;
  assert(typeof runtime.image === 'string' && `sha256:${runtime.image.replace(/^sha256:/u, '')}` === imageId &&
    runtime.readOnly === true && runtime.running === true && runtime.networkMode === 'host');
  assert(Array.isArray(runtime.mounts) && runtime.mounts.every((mount: any) =>
    mount.Type === 'tmpfs' && ['/tmp', '/run', '/var/tmp'].includes(mount.Destination)), 'container mounted code or data over the tested image');
  writeFileSync(`${directory}/browser.json`, browserBytes, { mode: 0o600, flag: 'wx' });
  writeFileSync(`${directory}/runtime.json`, runtimeBytes, { mode: 0o600, flag: 'wx' });
  const body = { version: 2, protocol: 'presigned-graph-v2', kind: 'presigned-v2-exact-oci-execution',
    createdAt, completedAt: new Date().toISOString(), executionDirectory: directory, sourceDigest, network, image,
    testedImageManifestDigest: image.manifestDigest, executedImageConfigDigest: imageId,
    offlineUtilityDigest: identity.utilityDigest, browserDigest: sha256(browserBytes), runtimeDigest: sha256(runtimeBytes),
    commands, actualRootlessContainerExecution: true, codeMounts: false, readonlyRootFilesystem: true,
    realDefaultSignetVerified: false, physicalPasskeysVerified: false, imagePublished: false, fundingAuthorized: false };
  const receipt = { ...body, receiptDigest: commitmentDigest('vault/presigned-graph-v2/exact-oci-execution', body) };
  writeAcceptanceJson(`${directory}/image-acceptance.json`, receipt);
  console.log(JSON.stringify({ passed: true, network, sourceDigest, testedImageManifestDigest: image.manifestDigest,
    receiptDigest: receipt.receiptDigest, evidence: directory, imagePublished: false, fundingAuthorized: false }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, evidence: directory, actualContainerEvidenceProduced: false,
    reason: error instanceof Error ? error.message.split('\n')[0]?.slice(0, 350) : 'exact image acceptance failed',
    imagePublished: false, fundingAuthorized: false }));
  process.exitCode = 1;
}
