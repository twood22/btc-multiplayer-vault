/** Package complete retained evidence locally; never upload it. */
import assert from 'node:assert/strict';
import { assertReviewedNodeRuntime } from '../src/runtime-version.js';
import { packPresignedEvidence, type EvidenceArchiveKind } from './lib/presigned-evidence-archive.js';
import { PRESIGNED_PROTOCOL_V3, isPresignedProtocol } from '../src/presigned/types.js';

process.umask(0o077);
try {
  assertReviewedNodeRuntime();
  assert(process.argv.length === 5, 'usage: presigned:pack-evidence local|signet-image|mainnet-image /absolute/evidence /private/output.tar.gz');
  const [kind, directory, output] = process.argv.slice(2);
  const protocol = process.env.PRESIGNED_BUILD_PROTOCOL ?? PRESIGNED_PROTOCOL_V3;
  assert(isPresignedProtocol(protocol));
  console.log(JSON.stringify(await packPresignedEvidence(kind as EvidenceArchiveKind, directory!, output!, protocol)));
} catch {
  console.error(JSON.stringify({ passed: false, archiveAccepted: false, published: false, fundingAuthorized: false,
    reason: 'evidence packaging refused; requires complete current-source evidence, an exact supported kind and a new private output path; raw errors omitted' }));
  process.exitCode = 1;
}
