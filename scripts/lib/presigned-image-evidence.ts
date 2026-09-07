/** Revalidate retained execution and OCI content before assembling a receipt. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { assertOciRuntimeImage, verifyOciDirectory } from './presigned-oci.js';
import { parseAcceptanceJson, readPrivateAcceptanceFile, validateBrowserAcceptance } from './presigned-acceptance-run.js';
import { IMAGE_EXECUTION_STAGES, imageExecutionCommand } from './presigned-image-commands.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function validateRetainedImageEvidence(directory: string, sourceDigest: string, network: 'signet' | 'mainnet') {
  const receipt = parseAcceptanceJson(readPrivateAcceptanceFile(`${directory}/image-acceptance.json`)) as any;
  const { receiptDigest, ...body } = receipt;
  assert(receipt.version === 2 && receipt.protocol === 'presigned-graph-v2' && receipt.kind === 'presigned-v2-exact-oci-execution' &&
    receipt.sourceDigest === sourceDigest && receipt.network === network && receipt.actualRootlessContainerExecution === true &&
    receipt.codeMounts === false && receipt.readonlyRootFilesystem === true && receipt.realDefaultSignetVerified === false &&
    receipt.physicalPasskeysVerified === false && receipt.imagePublished === false && receipt.fundingAuthorized === false);
  assert.equal(commitmentDigest('vault/presigned-graph-v2/exact-oci-execution', body), receiptDigest, 'retained image execution receipt changed');
  const image = await verifyOciDirectory(`${directory}/oci`);
  assert.deepEqual(image, receipt.image);
  assert(receipt.testedImageManifestDigest === image.manifestDigest && receipt.executedImageConfigDigest === image.configDigest);
  assert(Array.isArray(receipt.commands));
  assert.deepEqual(receipt.commands.map((command: any) => command.stage), [...IMAGE_EXECUTION_STAGES], 'missing exact-image execution stage');
  const outputs = new Map<string, Buffer>();
  for (const command of receipt.commands) {
    const expected = imageExecutionCommand(command.stage, network, receipt.executionDirectory, image.configDigest);
    assert.deepEqual(command.command, expected, 'retained image evidence substituted an execution command or environment');
    assert.equal(command.commandDigest, commitmentDigest('vault/presigned-graph-v2/image-command', expected));
    assert(command.exitCode === 0 && Date.parse(command.startedAt) >= Date.parse(receipt.createdAt) &&
      Date.parse(command.completedAt) >= Date.parse(command.startedAt) && Date.parse(command.completedAt) <= Date.parse(receipt.completedAt),
    'retained image stage lacks an actual successful bounded execution');
    for (const channel of ['stdout', 'stderr'] as const) {
      const bytes = readPrivateAcceptanceFile(`${directory}/${command.stage}.${channel}.log`, 32 * 1024 * 1024);
      assert.equal(sha256(bytes), command[channel === 'stdout' ? 'stdoutSha256' : 'stderrSha256'], 'image command transcript changed');
      if (channel === 'stdout') outputs.set(command.stage, bytes);
    }
  }
  const info = parseAcceptanceJson(outputs.get('rootless-preflight')!) as any;
  assert(info.host?.security?.rootless === true);
  const inspected = parseAcceptanceJson(outputs.get('inspect-image')!) as any[];
  assert(Array.isArray(inspected) && inspected.length === 1); assertOciRuntimeImage(image, inspected[0]);
  const identity = parseAcceptanceJson(outputs.get('runtime-identity')!) as any;
  assert(identity.build?.sourceDigest === sourceDigest && identity.build.network === network && identity.build.protocol === 'presigned-graph-v2' &&
    identity.build.version === 2 && identity.network?.version === 1 && identity.network.network === network &&
    identity.nodeVersion === readFileSync('.node-version', 'utf8').trim() && identity.uid > 0 && identity.utilityDigest === receipt.offlineUtilityDigest);
  const operator = parseAcceptanceJson(outputs.get('operator-runtime')!) as any;
  assert(operator.passed === true && operator.mutationBoundaryReached === false && operator.externalServiceAccessRequired === false &&
    operator.postArgumentImportsVerified === true);
  assert.deepEqual(operator.expectedFailures, [['web:broadcast-funding', '--vault-id is required'],
    ['presigned:release-status', '--vault-id is required'], ['presigned:verify-database-restore', 'invalid restore vault']]);
  assert.deepEqual(operator.postArgumentFailures, [
    ['presigned:release-status', 'PRESIGNED_V2_ACCEPTANCE_RECEIPT is required for v2 funding release'],
    ['presigned:verify-database-restore', 'both exact database endpoints must use non-local verified TLS'],
  ]);
  const browserBytes = readPrivateAcceptanceFile(`${directory}/browser.json`);
  const runtimeBytes = readPrivateAcceptanceFile(`${directory}/runtime.json`);
  assert(sha256(browserBytes) === receipt.browserDigest && sha256(runtimeBytes) === receipt.runtimeDigest);
  const browser = parseAcceptanceJson(browserBytes) as any; const runtime = parseAcceptanceJson(runtimeBytes) as any;
  validateBrowserAcceptance(browser, sourceDigest, network);
  assert(typeof runtime.image === 'string' && `sha256:${runtime.image.replace(/^sha256:/u, '')}` === image.configDigest &&
    runtime.running === true && runtime.readOnly === true && runtime.networkMode === 'host');
  assert(Array.isArray(runtime.mounts) && runtime.mounts.every((mount: any) =>
    mount.Type === 'tmpfs' && ['/tmp', '/run', '/var/tmp'].includes(mount.Destination)));
  return { receiptDigest: receipt.receiptDigest as string, sourceDigest, network, testedImageManifestDigest: image.manifestDigest,
    offlineUtilityDigest: receipt.offlineUtilityDigest as string, browserDigest: receipt.browserDigest as string,
    runtimeDigest: receipt.runtimeDigest as string };
}
