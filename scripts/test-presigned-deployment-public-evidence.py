#!/usr/bin/env python3
"""Synthetic parser/transport tests only; never deploy, load images or use RPC."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zlib

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('boundary', Path(__file__).with_name('presigned-deployment-public-evidence.py'))
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
os.umask(0o077)


def gzip_bytes(raw):
    compressor = zlib.compressobj(level=6, wbits=-15)
    return b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03' + compressor.compress(raw) + compressor.flush() + struct.pack('<II', zlib.crc32(raw), len(raw))


def archive_bytes(members):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, data, kind, link in members:
            info = tarfile.TarInfo(name)
            info.mode = 0o600
            info.uid = info.gid = info.mtime = 0
            info.type = kind
            info.linkname = link
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return out.getvalue()


class DeploymentEvidenceBoundaryTests(unittest.TestCase):
    def test_reusable_workflow_preserves_manual_public_branch_guard(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/presigned-v3-deployment-evidence.yml').read_text()
        # Exact source assertions, not a substitute YAML parser. No dependency
        # installation is needed to detect an extra trigger or relaxed guard.
        triggers = workflow.split('\non:\n', 1)[1].split('\npermissions:\n', 1)[0]
        self.assertEqual(triggers.strip(), 'workflow_dispatch:\n  workflow_call:')
        guards = [line.strip() for line in workflow.splitlines() if line.startswith('    if:')]
        self.assertEqual(guards, ["if: github.event_name == 'workflow_dispatch' && github.event.repository.private == false && "
                                 "github.repository == 'twood22/btc-multiplayer-vault' && "
                                 "github.ref == 'refs/heads/codex/presigned-v3-test-evidence'"])
        self.assertIn('\n    runs-on: ubuntu-24.04\n', workflow)
        self.assertIn('\n    timeout-minutes: 60\n', workflow)
        self.assertIn('\n  group: presigned-v3-post-assembly-deployment\n  cancel-in-progress: false\n', workflow)

    def test_reusable_workflow_accepts_no_inputs_or_inherited_secrets(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/presigned-v3-deployment-evidence.yml').read_text()
        self.assertNotIn('secrets:', workflow)
        self.assertNotIn('${{ secrets.', workflow)
        self.assertEqual(workflow.count('GH_TOKEN: ${{ github.token }}'), 2)
        self.assertEqual(workflow.count('persist-credentials: false'), 2)
        self.assertIn('PRESIGNED_ACCEPTANCE_PROTOCOL: presigned-graph-v3', workflow)
        self.assertIn('PRESIGNED_BUILD_PROTOCOL: presigned-graph-v3', workflow)
        pins_check = workflow.index('run: node scripts/presigned-deployment-ci.mjs check-pins')
        self.assertLess(pins_check, workflow.index('ref: ${{ steps.pins.outputs.candidate }}'))
        self.assertLess(pins_check, workflow.index('run: npm ci'))

    def fixture(self, root, raw=None):
        source = root / 'input.tar.gz'
        source.write_bytes(gzip_bytes(raw if raw is not None else archive_bytes([
            ('browser.json', b'{}', tarfile.REGTYPE, ''), ('oci/oci-layout', b'public', tarfile.REGTYPE, '')])))
        source.chmod(0o600)
        return source, root / 'imported', {'browser.json', 'oci/oci-layout'}

    def test_exact_regular_import_is_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest, names = self.fixture(Path(tmp))
            boundary.extract_verified_archive(source, dest, names, boundary.byte_hash(source))
            self.assertEqual((dest / 'browser.json').read_bytes(), b'{}')
            self.assertEqual((dest / 'oci/oci-layout').read_bytes(), b'public')
            self.assertEqual(dest.stat().st_mode & 0o777, 0o700)
            self.assertEqual((dest / 'oci').stat().st_mode & 0o777, 0o700)
            self.assertEqual((dest / 'browser.json').stat().st_mode & 0o777, 0o600)

    def test_exact_copy_requires_pinned_bytes_and_new_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'public-input'
            source.write_bytes(b'public synthetic bytes')
            target = root / 'copy'
            boundary.copy_pinned_file(source, target, source.stat().st_size, boundary.byte_hash(source))
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                boundary.copy_pinned_file(source, target, source.stat().st_size, boundary.byte_hash(source))

    def test_copy_bounds_hash_and_alias_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'public-input'
            source.write_bytes(b'public synthetic bytes')
            for index, (size, digest) in enumerate([(1, boundary.byte_hash(source)), (source.stat().st_size, '0' * 64),
                                                   (boundary.image_review.MAX_ARCHIVE + 1, '0' * 64)]):
                with self.subTest(size=size), self.assertRaises(boundary.ReviewError):
                    boundary.copy_pinned_file(source, root / f'out-{index}', size, digest)
            alias = root / 'alias'
            alias.symlink_to(source)
            with self.assertRaises(boundary.ReviewError):
                boundary.copy_pinned_file(alias, root / 'out-alias', source.stat().st_size, boundary.byte_hash(source))

    def test_missing_hash_and_existing_output_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest, names = self.fixture(Path(tmp))
            with self.assertRaises(boundary.ReviewError):
                boundary.extract_verified_archive(source, dest, names, '0' * 64)
            self.assertFalse(dest.exists())
            dest.mkdir(mode=0o700)
            (dest / 'retained').write_bytes(b'keep')
            with self.assertRaises(FileExistsError):
                boundary.extract_verified_archive(source, dest, names, boundary.byte_hash(source))
            self.assertEqual((dest / 'retained').read_bytes(), b'keep')

    def test_links_special_files_and_traversal_refused(self):
        for name, kind, link in [('browser.json', tarfile.SYMTYPE, '../outside'),
                                 ('browser.json', tarfile.LNKTYPE, '../outside'),
                                 ('browser.json', tarfile.FIFOTYPE, ''),
                                 ('../outside', tarfile.REGTYPE, ''),
                                 ('/outside', tarfile.REGTYPE, '')]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source, dest, _ = self.fixture(root, archive_bytes([(name, b'', kind, link)]))
                with self.assertRaises(boundary.ReviewError):
                    boundary.extract_verified_archive(source, dest, {'browser.json'}, boundary.byte_hash(source))
                self.assertFalse(dest.exists())

    def test_duplicate_and_unexpected_members_refused(self):
        for entries in [[('browser.json', b'1', tarfile.REGTYPE, '')] * 2,
                        [('unexpected.json', b'1', tarfile.REGTYPE, '')]]:
            with self.subTest(entries=len(entries)), tempfile.TemporaryDirectory() as tmp:
                source, dest, _ = self.fixture(Path(tmp), archive_bytes(entries))
                with self.assertRaises(boundary.ReviewError):
                    boundary.extract_verified_archive(source, dest, {'browser.json'}, boundary.byte_hash(source))
                self.assertFalse((dest / 'unexpected.json').exists())

    def test_gzip_members_trailers_and_tar_padding_refused(self):
        base = archive_bytes([('browser.json', b'{}', tarfile.REGTYPE, '')])
        padding = bytearray(base)
        padding[514] = 1
        inputs = [gzip_bytes(base) + gzip_bytes(b'ignored'), gzip_bytes(base) + b'ignored',
                  gzip_bytes(base + b'nonzero trailer'), gzip_bytes(bytes(padding))]
        for data in inputs:
            with self.subTest(size=len(data)), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = root / 'input.tar.gz'
                source.write_bytes(data)
                with self.assertRaises(boundary.ReviewError):
                    boundary.extract_verified_archive(source, root / 'out', {'browser.json'}, boundary.byte_hash(source))
                self.assertFalse((root / 'out').exists())

    def test_oversized_declaration_refused_without_allocating_body(self):
        info = tarfile.TarInfo('browser.json')
        info.mode = 0o600
        info.size = boundary.image_review.MAX_ARCHIVE + 1
        with tempfile.TemporaryDirectory() as tmp:
            source, dest, _ = self.fixture(Path(tmp), info.tobuf(format=tarfile.USTAR_FORMAT) + bytes(10240))
            with self.assertRaises(boundary.ReviewError):
                boundary.extract_verified_archive(source, dest, {'browser.json'}, boundary.byte_hash(source))
            self.assertFalse(dest.exists())

    def test_overlapping_and_aliased_paths_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, dest, _ = self.fixture(root)
            for names in [{'a', 'a/b'}, {'../outside'}, {'./browser.json'}, {'a//b'}]:
                with self.subTest(names=names), self.assertRaises(boundary.ReviewError):
                    boundary.extract_verified_archive(source, dest, names, boundary.byte_hash(source))
            alias = root / 'alias'
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaises(boundary.ReviewError):
                boundary.extract_verified_archive(source, alias / 'out', {'browser.json', 'oci/oci-layout'}, boundary.byte_hash(source))

    def test_hardlinked_input_and_unsafe_permissions_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, dest, names = self.fixture(root)
            os.link(source, root / 'same-inode')
            with self.assertRaises(boundary.ReviewError):
                boundary.extract_verified_archive(source, dest, names, boundary.byte_hash(source))
        with tempfile.TemporaryDirectory() as tmp:
            source, dest, names = self.fixture(Path(tmp))
            source.chmod(0o644)
            with self.assertRaises(boundary.ReviewError):
                boundary.extract_verified_archive(source, dest, names, boundary.byte_hash(source))

    def test_private_or_duplicate_metadata_never_passes(self):
        for body in [b'{"createdAt":"2026-09-14T00:00:00.000Z","cookie":"__cookie__:' + b'x' * 32 + b'"}',
                     b'{"passed":false,"passed":true}', b'{"createdAt":"2026-09-14 (private note)"}']:
            with self.subTest(body_length=len(body)), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'proof.json'
                path.write_bytes(body)
                with self.assertRaises(Exception):
                    boundary.scan_public_json(path)

    def metadata_fixture(self):
        pins = {'candidateCommit': '1' * 40, 'sourceDigest': '2' * 64, 'imageToolingCommit': '3' * 40,
                'imageWorkflowRunId': '123', 'imageReceiptDigest': '4' * 64, 'imageScannerSha256': '5' * 64,
                'imageManifestDigest': 'sha256:' + '6' * 64, 'imageConfigDigest': 'sha256:' + '7' * 64,
                'offlineUtilityDigest': '8' * 64, 'inputs': [{'sha256': '9' * 64, 'bytes': 123}]}
        retention = {'version': 1, 'protocol': 'presigned-graph-v3', 'kind': 'presigned-v3-public-test-evidence', 'network': 'signet',
                'sourceCommit': pins['candidateCommit'], 'sourceDigest': pins['sourceDigest'], 'toolingCommit': pins['imageToolingCommit'],
                'workflowRunId': pins['imageWorkflowRunId'], 'assetName': boundary.INPUT_NAMES[0], 'archiveSha256': '9' * 64,
                'archiveBytes': 123, 'evidenceDigest': pins['imageReceiptDigest'], 'files': 25, 'restoredBytesRevalidated': True,
                'syntheticOnly': True, 'productionUsePermitted': False, 'realDefaultSignetVerified': False,
                'physicalPasskeysVerified': False, 'releaseReceiptProduced': False, 'fundingAuthorized': False}
        review = {key: retention[key] for key in ('sourceCommit', 'sourceDigest', 'toolingCommit', 'workflowRunId', 'network',
                                                 'archiveSha256', 'archiveBytes', 'syntheticOnly', 'productionUsePermitted',
                                                 'realDefaultSignetVerified', 'physicalPasskeysVerified', 'releaseReceiptProduced', 'fundingAuthorized')}
        review.update(version=1, protocol='presigned-graph-v3', kind='presigned-v3-test-archive-content-review', passed=True,
                      scannerSha256=pins['imageScannerSha256'], historicalLayersInspected=True, exactArchiveMembersInspected=True,
                      canonicalOuterEnvelopeVerified=True)
        receipt = {'version': 3, 'protocol': 'presigned-graph-v3', 'kind': 'presigned-v3-executable-acceptance',
                   'createdAt': '2026-09-14T00:00:00.000Z', 'sourceDigest': pins['sourceDigest'],
                   'testedImageManifestDigest': pins['imageManifestDigest'], 'offlineUtilityDigest': pins['offlineUtilityDigest'],
                   'physicalPasskeys': 'deferred-to-friends-onboarding',
                   'evidence': [{'check': check, 'artifactDigest': 'a' * 64} for check in boundary.FINAL_CHECKS],
                   'liveSignetReceiptDigest': 'b' * 64}
        receipt['receiptDigest'] = hashlib.sha256(('vault/presigned-graph-v3/executable-acceptance\n' +
            json.dumps(receipt, sort_keys=True, separators=(',', ':'))).encode()).hexdigest()
        pins['acceptanceReceiptDigest'] = receipt['receiptDigest']
        return pins, retention, review, receipt

    def test_synthetic_metadata_binding_fixture(self):
        boundary.validate_input_metadata(*self.metadata_fixture())

    def test_wrong_protocol_receipt_source_and_scanner_refused(self):
        for target, field, value in [(1, 'protocol', 'presigned-graph-v2'), (1, 'sourceDigest', 'e' * 64),
                                     (2, 'scannerSha256', 'e' * 64), (2, 'realDefaultSignetVerified', True),
                                     (3, 'version', 2), (3, 'testedImageManifestDigest', 'sha256:' + 'e' * 64),
                                     (3, 'physicalPasskeys', 'verified'), (3, 'evidence', []),
                                     (3, 'privatePath', '/private/operational/custody')]:
            with self.subTest(field=field):
                data = self.metadata_fixture()
                data[target][field] = value
                with self.assertRaises(boundary.ReviewError):
                    boundary.validate_input_metadata(*data)

    def test_unset_cli_refuses_before_any_external_operation(self):
        # Pins intentionally remain UNSET until the root has genuine evidence.
        # Test the pure validator below rather than requiring mutable defaults.
        module = Path(__file__).with_name('presigned-deployment-ci.mjs').resolve().as_uri()
        program = '''import assert from 'node:assert/strict';
import {PINS,INPUT_NAMES,OUTPUT_NAMES,validatePins,validatePublicProof,validateTransport} from MODULE;
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const {createHash}=await import('node:crypto');const hash=s=>createHash('sha256').update(s).digest('hex');
const pins={candidateCommit:'1'.repeat(40),sourceDigest:'2'.repeat(64),draftTag:'presigned-v3-test-evidence-22222222-20260914',
 imageManifestDigest:'sha256:'+'3'.repeat(64),imageConfigDigest:'sha256:'+'4'.repeat(64),offlineUtilityDigest:'5'.repeat(64),
 acceptanceReceiptDigest:'6'.repeat(64),imageReceiptDigest:'7'.repeat(64),imageToolingCommit:'8'.repeat(40),
 imageWorkflowRunId:'123',imageScannerSha256:'9'.repeat(64),migrationCount:23,
 inputs:INPUT_NAMES.map(name=>({name,sha256:'a'.repeat(64),bytes:123}))};
validatePins(pins);let refusals=0;const denied=fn=>{assert.throws(fn);refusals++;};
for(const field of Object.keys(pins)){const value=structuredClone(pins);value[field]=field==='inputs'?[]:'UNSET_REQUIRED_PIN';denied(()=>validatePins(value));}
for(const field of ['name','sha256','bytes']){const value=structuredClone(pins);value.inputs[0][field]=field==='bytes'?2147483648:'../unapproved';denied(()=>validatePins(value));}
const proof={version:1,protocol:'presigned-graph-v3',kind:'actual-private-loopback-deployment-rollback',createdAt:'2026-09-14T00:00:00.000Z',
 sourceDigest:pins.sourceDigest,imageManifestDigest:pins.imageManifestDigest,imageConfigDigest:pins.imageConfigDigest,
 offlineUtilityDigest:pins.offlineUtilityDigest,acceptanceReceiptDigest:pins.acceptanceReceiptDigest,
 firstPlanDigest:'b'.repeat(64),upgradePlanDigest:'c'.repeat(64),journalDigest:'d'.repeat(64),nativeRestoreReceiptDigest:'e'.repeat(64),nativeDumpSha256:'f'.repeat(64),
 actualRootlessContainerExecution:true,actualNativePostgresqlRestore:true,actualCoreChain:'isolated-regtest',coreVersion:310100,
 successfulInstallations:2,successfulExactPreviousContainerRollbacks:1,idempotentInstallReconciliations:1,idempotentRollbackReconciliations:1,
 successfulWatcherHealthIterations:2,databaseInstanceSubstitutionRefusals:3,schemaSubstitutionRefusals:2,migrationCount:23,databaseHistoryPreserved:true,
 sameCompatibleImageAcrossReleases:true,databaseDowngraded:false,historicalContainersDeleted:false,codeMounts:false,readonlyRootFilesystem:true,listener:'127.0.0.1',
 operationalDatabaseAccess:false,publicNetworkBroadcasts:0,publicListener:false,realDefaultSignetVerified:false,productionDeploymentClaimed:false,
 fundingAuthorized:false,cleanServiceShutdownVerified:true};
proof.receiptDigest=hash('vault/presigned-graph-v3/deployment-rollback-acceptance\\n'+canonical(proof));validatePublicProof(proof,pins);
for(const field of Object.keys(proof)){const mutated={...proof,[field]:typeof proof[field]==='boolean'?!proof[field]:typeof proof[field]==='number'?proof[field]+1:'UNAPPROVED'};denied(()=>validatePublicProof(mutated,pins));}
denied(()=>validatePublicProof({...proof,privatePath:'/private/custody'},pins));
const ctx={toolingCommit:'1'.repeat(40),workflowRunId:'456',runnerSha256:'2'.repeat(64),boundaryHelperSha256:'3'.repeat(64)};
const record={version:1,protocol:'presigned-graph-v3',kind:'presigned-v3-public-deployment-test-retention',createdAt:proof.createdAt,
 candidateCommit:pins.candidateCommit,sourceDigest:pins.sourceDigest,toolingCommit:ctx.toolingCommit,workflowRunId:ctx.workflowRunId,inputs:pins.inputs,
 proof:{name:OUTPUT_NAMES[0],sha256:'4'.repeat(64),bytes:123,receiptDigest:proof.receiptDigest},
 imageManifestDigest:pins.imageManifestDigest,imageConfigDigest:pins.imageConfigDigest,offlineUtilityDigest:pins.offlineUtilityDigest,
 acceptanceReceiptDigest:pins.acceptanceReceiptDigest,runnerSha256:ctx.runnerSha256,boundaryHelperSha256:ctx.boundaryHelperSha256,imageScannerSha256:pins.imageScannerSha256,
 actualDrillCompleted:true,cleanServiceShutdownVerified:true,scope:'isolated-regtest-same-image-rollback',privateDirectoryUploads:false,
 productionDeploymentClaimed:false,fundingAuthorized:false};validateTransport(record,pins,ctx);
for(const field of Object.keys(record)){const value=structuredClone(record);value[field]=typeof value[field]==='boolean'?!value[field]:typeof value[field]==='number'?value[field]+1:'UNAPPROVED';denied(()=>validateTransport(value,pins,ctx));}
denied(()=>validateTransport({...record,privatePath:'/private/custody'},pins,ctx));
assert(refusals>=80);console.log(JSON.stringify({passed:true,refusals,syntheticParserFixturesOnly:true,actualDeploymentExecuted:false}));
'''.replace('MODULE', json.dumps(module))
        result = subprocess.run(['node', '--input-type=module', '-'], input=program, text=True, capture_output=True, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, 'pure synthetic Node validation controls failed')
        output = json.loads(result.stdout)
        self.assertTrue(output['passed'])
        self.assertGreaterEqual(output['refusals'], 80)
        self.assertTrue(output['syntheticParserFixturesOnly'])
        self.assertFalse(output['actualDeploymentExecuted'])


if __name__ == '__main__':
    unittest.main()
