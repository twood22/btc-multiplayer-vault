# Manual hosted LOCAL78 evidence preparation

Preparation only: no commit, push, dispatch, candidate acceptance, native process, or upload was performed by this adaptation. The original retention and private LOCAL78 snapshots remain untouched. This is a new detached tooling worktree based on `749ba3dffd65912b62cdfd13dd0e3d200d5e2fdd`, not a change to the application candidate.

## Fixed scope

- Candidate: `94dc1046a29d2b027fc8186baa5932c1b1ab236a`.
- Source: `83e9001523b7029a0da6e945be5e6258d5f50ed6f4f529cab9e70413cf7127bc`.
- Entire unchanged local acceptance plan: 78 commands, 171 exact archive members. No filtering, shortened command timeout, image rerun, or partial-success publication.
- Existing test-only release draft: ID `392238195`, tag `presigned-v3-test-evidence-83e90015-20260919`, target candidate above, draft=true and prerelease=true. This tooling never publishes the draft.
- Existing registered workflow remains manual-only. Select `operation=local` on `codex/presigned-v3-test-evidence`; the image/deployment jobs remain unselected and unchanged. Standard `ubuntu-24.04`, existing 330-minute job bound, no caches, Actions artifact storage, larger runner, registry push, or new paid service.

Three new additive draft asset names are `presigned-v3-local78-test-evidence.tar.gz`, `presigned-v3-local78-retention.json`, and `presigned-v3-local78-content-review.json`. Existing assets may not be replaced. Before and after the single upload request, the exact draft is checked; afterward, each new size/SHA-256 and each pre-existing asset's ID/name/size/digest are checked. An exclusive upload-intent marker precedes the request. Lost response or partial upload remains uncertain/failed and is not automatically retried, overwritten, or cleaned up. A rerun with any of the three names already present refuses.

## Reuse and boundaries

The new hosted runner adapts the reviewed legacy manual LOCAL runner and uses the unchanged candidate `scripts/presigned-ci.mts local`, not a new acceptance framework. The separate current LOCAL78 output profile, archive inspector, and private transport helper are copied byte-for-byte from the reviewed private snapshot. Only its `completedSource`, `writeExclusive`, and test helpers are used; private pack/review/roundtrip CLI phases are not workflow steps. Its private metadata writer remains private-only and is deliberately incompatible with the hosted envelope.

The hosted reviewer retains the complete LOCAL78 transcript/output checks, exact ordered command plan, strict JSON/duplicate-key rejection, all empty-stderr checks, exact artifact membership, source-grounded text allowlists, offline utility hash, candidate semantic revalidation, and canonical archive/whole-byte privacy inspection. No transcript is rewritten. All original hostile controls remain; the new tests additionally cover dispatch, current/offline tooling identity, hosted metadata, wrong draft, collisions, and canonical transport metadata. Archive and copy phases retain the 2-GiB free-space reserve with explicit forecasts. Metadata never claims universal secret absence, real Signet, physical passkeys, production authorization, or funding authority.

The following lower-boundary bytes remain unchanged and hard-pinned:

- `scripts/presigned-deployment-public-evidence.py`: `31d6a6eb1cce31c49e433b7c102b69ae2b472e748aec84286361f1cb0309fb9e`.
- `scripts/presigned-public-evidence.py`: `815b768c09085f859266479a3dfb4707273f925e4680760f224cae85e508b1fd`.
- `scripts/presigned-local-output-profile.mjs`: `52d51b25702c89cf091faf6103942a3e7b7d52bf3976cc969665110b94704b47`.

## Honest tooling identity, no self-hash cycle

`toolingBase` records historical `749ba3...` provenance, not the new commit. On GitHub, actual tooling HEAD must match the real `GITHUB_SHA`, repository, branch, and manual dispatch. All runtime tooling/boundary files and the local workflow must be tracked and unchanged from that HEAD. Before dispatch root must independently review the complete successor commit and read back its remote SHA; after the run root must read back the actual workflow head SHA/run ID. Do not substitute a fabricated environment for those observations. The retained `toolingCommit`, workflowRunId, and reviewer content digest bind the actual run. The reviewer digest is calculated from file bytes, not embedded as a circular future hash.

Outside GitHub, nonhistorical tooling HEAD requires `PRESIGNED_REVIEWED_TOOLING_COMMIT` set to the exact independently reviewed commit. It must match actual HEAD and retained toolingCommit, and all tracked runtime content/boundary checks still apply. No GitHub environment is spoofed. With no explicit pin, offline preparation is permitted only at historical HEAD `749ba3...`; neither offline mode permits hosted run/upload. The hosted branch refuses the offline pin.

## Validation status and proposed commands

Author validation is limited to syntax, whitespace, file scope, and byte/hash inspection. Full synthetic privacy/archive suites and candidate execution are deferred while root monitors the existing browser diagnostic. Syntax success is not privacy-suite or LOCAL78 success.

After independent source review and when root permits the lightweight synthetic suites, run from the real candidate checkout with its existing locked dependencies and exact Node 22.23.2:

```sh
/home/codex/.local/lib/nodejs/node-v22.23.2-linux-x64/bin/node --import tsx /tmp/presigned-v3-hosted-local78.FoihUUyR/source/scripts/test-presigned-local78-evidence.mjs
PYTHONDONTWRITEBYTECODE=1 python3 /tmp/presigned-v3-hosted-local78.FoihUUyR/source/scripts/test-presigned-local78-archive.py
```

The first command is a synthetic test suite, not the 78-command acceptance plan. It imports candidate validation helpers but runs no Core, browser, database, service, or upload. It creates only bounded synthetic temporary files and refusal subprocesses. After a future reviewed tooling commit, prefix its command with `PRESIGNED_REVIEWED_TOOLING_COMMIT=<actual independently reviewed commit>`; do not invent a future SHA or set GITHUB_ACTIONS for offline testing.

For an honest later download/readback, preserve the three assets; place exact archive+retention copies in a fresh private canonical directory, keep the downloaded review separately, and use the same reviewer with the independently read-back tooling commit pin, from the exact candidate checkout. It generates a fresh review without overwrite; compare its exact bytes with the downloaded review, and compare archive SHA/size and all 171 restored files through the unchanged candidate validator. Set `GITHUB_REPOSITORY_OWNER=twood22` for the same owner-privacy scan. The expected `published:false` field describes the captured test envelope and lack of release publication; uploading to a draft does not convert it into a release receipt or production authorization.

The main candidate source, old successful artifacts, historical legacy LOCAL75 files, image/deployment workflows, existing source snapshots, and downstream bootstrap/resume consumers are not edited. Root independently confirmed complete hosted restored LOCAL78 evidence can feed the existing unchanged downstream validator; no new downstream adapter is proposed here.
