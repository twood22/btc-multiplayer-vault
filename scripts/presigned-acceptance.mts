/** Execute the entire fixed local matrix. This deliberately cannot grant release. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { assertReviewedNodeRuntime } from '../src/runtime-version.js';
import { commitmentDigest, presignedDomain, presignedVersion } from '../src/presigned/validation.js';
import { isPresignedProtocol, PRESIGNED_PROTOCOL_V3, type PresignedProtocol } from '../src/presigned/types.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { acceptancePlan, executeAcceptanceCommand, validateLocalAcceptanceRun, writeAcceptanceJson,
  type AcceptanceMode, type LocalAcceptanceRun } from './lib/presigned-acceptance-run.js';

process.umask(0o077); assertReviewedNodeRuntime();
const mode = process.argv[2] as AcceptanceMode;
const selectedProtocol = process.env.PRESIGNED_ACCEPTANCE_PROTOCOL ?? PRESIGNED_PROTOCOL_V3;
assert(isPresignedProtocol(selectedProtocol), 'unknown acceptance protocol');
const protocol: PresignedProtocol = selectedProtocol;
assert(process.argv.length === 3 && ['pure', 'local'].includes(mode), 'usage: tsx scripts/presigned-acceptance.mts pure|local');
for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local'])
  assert(!existsSync(filename), 'acceptance must not run beside operational dotenv files');
const directory = mkdtempSync('/tmp/btc-presigned-acceptance.');
const sourceDigest = presignedSourceDigest(); const createdAt = new Date().toISOString();
console.log(JSON.stringify({ stage: 'fixed-acceptance-plan', mode, protocol, evidence: directory, sourceDigest,
  commands: acceptancePlan(mode, protocol).length, realSignetVerified: false, exactImageVerified: false, fundingAuthorized: false }));
const commands = [];
try {
  for (const command of acceptancePlan(mode, protocol)) {
    console.log(JSON.stringify({ stage: 'started', command: command.id }));
    commands.push(await executeAcceptanceCommand(command, directory, sourceDigest, protocol));
    console.log(JSON.stringify({ stage: 'passed', command: command.id, completed: commands.length }));
  }
  const body: Omit<LocalAcceptanceRun, 'runDigest'> = { version: presignedVersion(protocol), protocol,
    kind: protocol === PRESIGNED_PROTOCOL_V3 ? 'presigned-v3-local-executable-run' : 'presigned-v2-local-executable-run', mode, sourceDigest, createdAt, completedAt: new Date().toISOString(),
    reviewedNodeVersion: readFileSync('.node-version', 'utf8').trim(), commands,
    offlineUtilityDigest: mode === 'local' ? createHash('sha256').update(readFileSync('public/offline/presigned-recovery.html')).digest('hex') : null,
    physicalPasskeysVerified: false, realSignetVerified: false, exactImageVerified: false, fundingAuthorized: false };
  const run = { ...body, runDigest: commitmentDigest(presignedDomain(protocol, 'local-executable-run'), body) };
  writeAcceptanceJson(`${directory}/run.json`, run); validateLocalAcceptanceRun(directory, sourceDigest, mode, protocol);
  console.log(JSON.stringify({ passed: true, mode, protocol, sourceDigest, completed: commands.length, runDigest: run.runDigest,
    evidence: directory, realSignetVerified: false, exactImageVerified: false, fundingAuthorized: false }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, evidence: directory, completed: commands.length,
    reason: error instanceof Error ? error.message.split('\n')[0]?.slice(0, 350) : 'acceptance failed; no release receipt created' }));
  process.exitCode = 1;
}
