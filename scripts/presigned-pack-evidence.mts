/** Package complete retained evidence locally; never upload it. */
import assert from 'node:assert/strict';
import { assertReviewedNodeRuntime } from '../src/runtime-version.js';
import { packPresignedEvidence, type EvidenceArchiveKind } from './lib/presigned-evidence-archive.js';

process.umask(0o077);
try {
  assertReviewedNodeRuntime();
  assert(process.argv.length === 5, 'usage: presigned:pack-evidence local|signet-image|mainnet-image /absolute/evidence /private/output.tar.gz');
  const [kind, directory, output] = process.argv.slice(2);
  console.log(JSON.stringify(await packPresignedEvidence(kind as EvidenceArchiveKind, directory!, output!)));
} catch {
  console.error(JSON.stringify({ passed: false, archiveAccepted: false, published: false, fundingAuthorized: false,
    reason: 'evidence packaging refused; requires complete current-source evidence, an exact supported kind and a new private output path; raw errors omitted' }));
  process.exitCode = 1;
}
