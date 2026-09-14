#!/usr/bin/env python3
"""Synthetic privacy-boundary tests; no real wallet or credential inputs."""
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest
import sys
import tempfile
import zlib
import struct
import hashlib
import json
import subprocess

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('review', Path(__file__).with_name('presigned-public-evidence.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ContentReviewTests(unittest.TestCase):
    def test_browser_failure_metadata_never_copies_private_fields(self):
        module = Path(__file__).with_name('presigned-ci-retain.mjs').resolve().as_uri()
        program = '''import assert from 'node:assert/strict';
import {publicBrowserFailureMetadata} from MODULE;
const privateValue='synthetic-private-value-never-publish';
const location={file:'presigned-v2.spec.ts',line:167,column:108,secret:privateValue};
const diagnostic={actor:'alice',pageErrors:0,crashes:0,credentialAssertions:14,primaryAssertions:12,recoveryAssertions:2,
  selectedAuthenticator:'recovery',unlockRequestedAuthenticator:'recovery',secret:privateValue,
  recentApi:[{endpoint:'/api/passkeys/unlock/options',status:200,body:privateValue},
    {endpoint:'/'+privateValue,status:500},{endpoint:'/api/passkeys/unlock/finish',status:privateValue}]};
const raw=JSON.stringify({stage:privateValue,assertionLocations:[location,{file:privateValue,line:1,column:1}],
  browserDiagnostics:[diagnostic,{actor:privateValue,pageErrors:1}],error:privateValue});
const safe=publicBrowserFailureMetadata(raw);const serialized=JSON.stringify(safe);
assert.equal(safe.records[0].failureKind,'other');
for(const failureKind of ['timeout','strict-locator','closed-page','other'])
  assert.equal(publicBrowserFailureMetadata(JSON.stringify({assertionLocations:[location],failureKind})).records[0].failureKind,failureKind);
assert.equal(publicBrowserFailureMetadata(JSON.stringify({assertionLocations:[location],failureKind:privateValue})).records[0].failureKind,'other');
assert(!serialized.includes(privateValue));assert(!serialized.includes('secret'));assert(!serialized.includes('body'));
assert.deepEqual(safe.records[0].locations,[{file:'presigned-v2.spec.ts',line:167,column:108}]);
assert.equal(safe.records[0].diagnostics.length,1);assert.equal(safe.records[0].diagnostics[0].recoveryAssertions,2);
assert.deepEqual(safe.records[0].diagnostics[0].recentApi,[{endpoint:'/api/passkeys/unlock/options',status:200}]);
assert.equal(publicBrowserFailureMetadata(JSON.stringify({actor:'bob',assertionLocations:[location],diagnostics:diagnostic})).records[0].diagnostics[0].actor,'bob');
assert.deepEqual(publicBrowserFailureMetadata(privateValue+'\\n{invalid\\nnull'),{records:[]});
assert.equal(publicBrowserFailureMetadata(Array(20).fill(raw).join('\\n')).records.length,8);
assert.deepEqual(publicBrowserFailureMetadata('{'+privateValue.repeat(6000)+'}'),{records:[]});
assert.throws(()=>publicBrowserFailureMetadata('x'.repeat(1024*1024+1)));
console.log(JSON.stringify({passed:true,privateValuesCopied:0}));
'''.replace('MODULE', json.dumps(module))
        result = subprocess.run(['node', '--input-type=module', '-'], input=program, text=True,
                                capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, 'safe browser diagnostic controls failed')
        self.assertEqual(json.loads(result.stdout), {'passed': True, 'privateValuesCopied': 0})

    def retention_fixture(self):
        return {'version': 1, 'protocol': 'presigned-graph-v3', 'kind': 'presigned-v3-public-test-evidence',
                'network': 'signet', 'sourceCommit': '1' * 40, 'sourceDigest': '2' * 64, 'toolingCommit': '3' * 40,
                'workflowRunId': '123', 'assetName': 'presigned-v3-signet-test-evidence.tar.gz',
                'archiveSha256': '4' * 64, 'archiveBytes': 123, 'evidenceDigest': '5' * 64, 'files': 25,
                'restoredBytesRevalidated': True, 'syntheticOnly': True, 'productionUsePermitted': False,
                'realDefaultSignetVerified': False, 'physicalPasskeysVerified': False,
                'releaseReceiptProduced': False, 'fundingAuthorized': False}

    def receipt_fixture(self):
        retention = self.retention_fixture()
        return {'version': 3, 'protocol': 'presigned-graph-v3', 'kind': 'presigned-v3-exact-oci-execution',
                'sourceDigest': retention['sourceDigest'], 'receiptDigest': retention['evidenceDigest'], 'network': 'signet',
                'actualRootlessContainerExecution': True, 'readonlyRootFilesystem': True, 'codeMounts': False,
                'realDefaultSignetVerified': False, 'physicalPasskeysVerified': False, 'imagePublished': False,
                'fundingAuthorized': False}

    def test_v3_retention_schema_one_is_not_protocol_version(self):
        self.assertEqual(review.validate_retention_profile(self.retention_fixture()), 'signet')
        review.validate_image_receipt_profile(self.receipt_fixture(), self.retention_fixture())
        with self.assertRaises(review.ReviewError):
            review.validate_retention_profile({**self.retention_fixture(), 'version': 3})

    def test_v2_retention_cannot_be_relabelled_as_v3(self):
        for field, value in (('protocol', 'presigned-graph-v2'), ('kind', 'presigned-v2-public-test-evidence'),
                             ('assetName', 'presigned-v2-signet-test-evidence.tar.gz')):
            with self.subTest(field=field), self.assertRaises(review.ReviewError):
                review.validate_retention_profile({**self.retention_fixture(), field: value})

    def test_v2_image_receipt_cannot_be_relabelled_as_v3(self):
        for field, value in (('version', 2), ('protocol', 'presigned-graph-v2'), ('kind', 'presigned-v2-exact-oci-execution')):
            with self.subTest(field=field), self.assertRaises(review.ReviewError):
                review.validate_image_receipt_profile({**self.receipt_fixture(), field: value}, self.retention_fixture())

    def test_retention_identity_and_bounds_are_required(self):
        for field, value in (('sourceCommit', 'UNSET_FINAL_CANDIDATE_COMMIT'), ('sourceDigest', 'UNSET_FINAL_SOURCE_DIGEST'),
                             ('workflowRunId', 'unknown'), ('files', 513), ('archiveBytes', 0), ('version', True)):
            with self.subTest(field=field), self.assertRaises(review.ReviewError):
                review.validate_retention_profile({**self.retention_fixture(), field: value})
        with self.assertRaises(review.ReviewError):
            review.validate_retention_profile({**self.retention_fixture(), 'unexpected': True})

    def test_synthetic_retention_cannot_authorize_funding_or_claim_real_tests(self):
        for field in ('productionUsePermitted', 'realDefaultSignetVerified', 'physicalPasskeysVerified',
                      'releaseReceiptProduced', 'fundingAuthorized'):
            with self.subTest(field=field), self.assertRaises(review.ReviewError):
                review.validate_retention_profile({**self.retention_fixture(), field: True})

    def test_image_receipt_requires_matching_network_and_digests(self):
        for field, value in (('network', 'mainnet'), ('sourceDigest', '6' * 64), ('receiptDigest', '7' * 64)):
            with self.subTest(field=field), self.assertRaises(review.ReviewError):
                review.validate_image_receipt_profile({**self.receipt_fixture(), field: value}, self.retention_fixture())

    def test_image_receipt_cannot_claim_a_real_or_unisolated_execution(self):
        for field in ('codeMounts', 'realDefaultSignetVerified', 'physicalPasskeysVerified', 'imagePublished', 'fundingAuthorized'):
            with self.subTest(field=field), self.assertRaises(review.ReviewError):
                review.validate_image_receipt_profile({**self.receipt_fixture(), field: True}, self.retention_fixture())
        for field in ('actualRootlessContainerExecution', 'readonlyRootFilesystem'):
            with self.subTest(field=field), self.assertRaises(review.ReviewError):
                review.validate_image_receipt_profile({**self.receipt_fixture(), field: False}, self.retention_fixture())

    def test_node_retainer_v3_and_unset_pin_refusals(self):
        # Importing pure validation helpers never enters run/upload or reads
        # operational state; all identities below are synthetic constants.
        module = Path(__file__).with_name('presigned-ci-retain.mjs').resolve().as_uri()
        program = '''import assert from 'node:assert/strict';
import {validateFinalPins, assertV3ArchivePack, assertV3Retention, assertV3ContentReview} from MODULE;
const retention = RETENTION;
const pack={passed:true,protocol:'presigned-graph-v3',kind:'presigned-v3-local-evidence-archive',
  evidenceKind:'signet-image',sourceDigest:retention.sourceDigest,restoredBytesRevalidated:true,
  contentPrivacyReviewed:false,published:false,realDefaultSignetVerified:false,releaseReceiptProduced:false,fundingAuthorized:false};
const content={version:1,protocol:'presigned-graph-v3',kind:'presigned-v3-test-archive-content-review',passed:true,
  syntheticOnly:true,productionUsePermitted:false,realDefaultSignetVerified:false,physicalPasskeysVerified:false,
  releaseReceiptProduced:false,fundingAuthorized:false};
assertV3ArchivePack(pack,'signet',retention.sourceDigest);assertV3Retention(retention);assertV3ContentReview(content);
let refused=0;const reject=fn=>{assert.throws(fn);refused++;};
for(const [field,value] of [['protocol','presigned-graph-v2'],['kind','presigned-v2-local-evidence-archive'],
  ['realDefaultSignetVerified',true],['releaseReceiptProduced',true],['fundingAuthorized',true]])
  reject(()=>assertV3ArchivePack({...pack,[field]:value},'signet',retention.sourceDigest));
for(const [field,value] of [['version',3],['protocol','presigned-graph-v2'],['kind','presigned-v2-public-test-evidence'],
  ['physicalPasskeysVerified',true],['fundingAuthorized',true]]) reject(()=>assertV3Retention({...retention,[field]:value}));
for(const [field,value] of [['version',3],['protocol','presigned-graph-v2'],['kind','presigned-v2-test-archive-content-review'],
  ['realDefaultSignetVerified',true],['fundingAuthorized',true]]) reject(()=>assertV3ContentReview({...content,[field]:value}));
const candidate='1'.repeat(40),source='2'.repeat(64),tag='presigned-v3-test-evidence-22222222-20260914';
validateFinalPins(candidate,source,tag);
for(const pins of [['UNSET_FINAL_CANDIDATE_COMMIT',source,tag],[candidate,'UNSET_FINAL_SOURCE_DIGEST',tag],
  [candidate,source,'UNSET_PREAPPROVED_V3_TEST_DRAFT_TAG'],[candidate,source,'presigned-v2-test-evidence-22222222-20260914'],
  [candidate,source,'presigned-v3-test-evidence-33333333-20260914']]) reject(()=>validateFinalPins(...pins));
assert.equal(refused,20);console.log(JSON.stringify({passed:true,refusals:refused,externalOperations:0}));
'''.replace('MODULE', json.dumps(module)).replace('RETENTION', json.dumps(self.retention_fixture()))
        result = subprocess.run(['node', '--input-type=module', '-'], input=program, text=True,
                                capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, 'pure Node retention validator controls failed')
        self.assertEqual(json.loads(result.stdout), {'passed': True, 'refusals': 20, 'externalOperations': 0})

    def test_regular_public_source(self):
        review.scan_bytes(b'const key = process.env.BITCOIN_RPC_PASSWORD; const digest = "' + b'0' * 64 + b'";')
        review.scan_path('app/src/presigned/backup.ts')

    def test_names_are_not_extracted(self):
        for name in ('../wallet.dat', '/root/private', 'a/../../bad'):
            with self.assertRaises(review.ReviewError):
                review.member_name(name)

    def test_sensitive_paths(self):
        for name in ('app/.env', 'app/.env.production', 'app/.git/config', 'root/.ssh/id_rsa',
                     'app/wallets/test/wallet.dat', 'app/control.json', 'home/runner/private.txt'):
            with self.assertRaises(review.ReviewError):
                review.scan_path(name)

    def test_secret_shapes_without_echo(self):
        examples = [b'__cookie__:' + b'1' * 32, b'ghp_' + b'x' * 36,
                    b'{"privateKeyHex":"' + b'a' * 64 + b'"}',
                    b'rpcpassword=' + b'b' * 32,
                    b'-----BEGIN PRIVATE KEY-----\n' + b'c' * 32]
        for example in examples:
            with self.assertRaisesRegex(review.ReviewError, '^credential-like content$'):
                review.scan_bytes(example)

    def test_pem_documentation_without_payload(self):
        review.scan_bytes(b'-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----')

    def test_real_pem_shape_with_short_wrapped_lines(self):
        with self.assertRaises(review.ReviewError):
            review.scan_bytes(b'-----BEGIN PRIVATE KEY-----\n' + (b'A' * 8 + b'\n') * 8 + b'-----END PRIVATE KEY-----')

    def test_encrypted_pem_headers(self):
        with self.assertRaises(review.ReviewError):
            review.scan_bytes(b'-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,' +
                              b'0' * 32 + b'\n\n' + b'A' * 64 + b'\n-----END RSA PRIVATE KEY-----')

    def test_diagnostic_filename_never_echoed(self):
        filename = 'app/ghp_' + 'x' * 36
        review.location(filename)
        self.assertNotIn(filename, review.SCAN_LOCATION)
        self.assertTrue(review.SCAN_LOCATION.startswith('path-sha256:'))

    def test_public_pem_allowance_requires_exact_offset_and_hash(self):
        data = b'-----BEGIN PRIVATE KEY-----\n' + b'A' * 64 + b'\n-----END PRIVATE KEY-----'
        prefix = review.COMPILED[0].match(data)[0]
        permitted = {123: hashlib.sha256(prefix).hexdigest()}
        review.scan_bytes(data, (), permitted, 123)
        with self.assertRaises(review.ReviewError):
            review.scan_bytes(data, (), permitted, 124)
        with self.assertRaises(review.ReviewError):
            review.scan_bytes(data.replace(b'A' * 64, b'B' * 64), (), permitted, 123)
        with self.assertRaises(review.ReviewError):
            review.scan_bytes(data, ())
        with self.assertRaises(review.ReviewError):
            review.scan_bytes(data + b' __cookie__:' + b'x' * 32, (), permitted, 123)

    def test_identifier(self):
        with self.assertRaises(review.ReviewError):
            review.scan_bytes(b'https://example.invalid/private-person/project', (b'private-person',))

    def test_boundary_overlap(self):
        body = b'x' * (1024 * 1024 - 8) + b' __cookie__:' + b'a' * 32
        with self.assertRaises(review.ReviewError):
            review.scan_stream(io.BytesIO(body), len(body), ())

    def test_generated_key_requires_empty_maps(self):
        valid = b'{"node":{},"edge":{},"encryptionKey":"' + b'AA' * 21 + b'A="}'
        self.assertTrue(review.check_action_manifest('app/.next/server/server-reference-manifest.json', valid))
        with self.assertRaises(review.ReviewError):
            review.check_action_manifest('app/.next/server/server-reference-manifest.json',
                                         valid.replace(b'"node":{}', b'"node":{"action":{}}'))

    def test_duplicate_manifest_json(self):
        with self.assertRaises(review.ReviewError):
            review.strict_json('{"node":{},"node":{"hidden":{}}}')

    def test_generated_key_other_path(self):
        data = b'{"encryptionKey":"' + b'a' * 44 + b'"}'
        with self.assertRaises(review.ReviewError):
            review.scan_stream(io.BytesIO(data), len(data), ())

    def test_noncanonical_generated_key(self):
        with self.assertRaises(review.ReviewError):
            review.check_action_manifest('app/.next/server/server-reference-manifest.json',
                                         b'{"node":{},"edge":{},"encryptionKey":"bad"}')

    def test_unexpected_manifest_script(self):
        with self.assertRaises(review.ReviewError):
            review.check_action_manifest('app/.next/server/server-reference-manifest.js', b'eval("hidden")')

    def test_historical_layer_not_just_final_rootfs(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            info = tarfile.TarInfo('app/.cookie')
            info.size = 4
            archive.addfile(info, io.BytesIO(b'test'))
            archive.addfile(tarfile.TarInfo('app/.wh..cookie'))
        buffer.seek(0)
        with self.assertRaises(review.ReviewError):
            review.inspect_layer(buffer, (), {'layerMembers': 0, 'decodedBytes': 0, 'decodedTarBytes': 0,
                                              'unusedTestFrameworkKeys': 0, 'testPreviewManifests': 0})

    def test_secret_in_tar_padding(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            archive.addfile(tarfile.TarInfo('app/empty'))
        buffer.write(b'__cookie__:' + b'x' * 32)
        buffer.seek(0)
        with self.assertRaises(review.ReviewError):
            review.inspect_layer(buffer, (), {'layerMembers': 0, 'decodedBytes': 0, 'decodedTarBytes': 0,
                                              'unusedTestFrameworkKeys': 0, 'testPreviewManifests': 0})

    def test_secret_in_tar_owner_header(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            info = tarfile.TarInfo('app/public.txt')
            info.uname = '__cookie__:' + '1' * 20
            info.size = 4
            archive.addfile(info, io.BytesIO(b'test'))
        buffer.seek(0)
        with self.assertRaises(review.ReviewError):
            review.inspect_layer(buffer, (), {'layerMembers': 0, 'decodedBytes': 0, 'decodedTarBytes': 0,
                                              'unusedTestFrameworkKeys': 0, 'testPreviewManifests': 0})

    def test_complete_public_layer(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            info = tarfile.TarInfo('app/public.txt')
            info.size = 4
            archive.addfile(info, io.BytesIO(b'test'))
        buffer.seek(0)
        totals = {'layerMembers': 0, 'decodedBytes': 0, 'decodedTarBytes': 0,
                  'unusedTestFrameworkKeys': 0, 'testPreviewManifests': 0}
        review.inspect_layer(buffer, (), totals)
        self.assertEqual(totals['layerMembers'], 1)
        self.assertEqual(totals['decodedBytes'], 4)
        self.assertEqual(totals['decodedTarBytes'], len(buffer.getvalue()))

    def test_declared_public_layer_requires_actual_bytes(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            info = tarfile.TarInfo('app/public.txt')
            info.size = 4
            archive.addfile(info, io.BytesIO(b'test'))
        buffer.seek(0)
        totals = {'layerMembers': 0, 'decodedBytes': 0, 'decodedTarBytes': 0,
                  'unusedTestFrameworkKeys': 0, 'testPreviewManifests': 0}
        with self.assertRaisesRegex(review.ReviewError, 'raw layer digest changed'):
            review.inspect_layer(buffer, (), totals, review.PUBLIC_SELFTEST_LAYER)

    def outer_fixture(self, *, owner='', tail=b''):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            info = tarfile.TarInfo('browser.json')
            info.mode = 0o600
            info.uid = info.gid = info.mtime = 0
            info.uname = owner
            info.size = 2
            archive.addfile(info, io.BytesIO(b'{}'))
        raw = buffer.getvalue() + tail
        compressed = zlib.compressobj(level=6, wbits=-15)
        return b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03' + compressed.compress(raw) + compressed.flush() + struct.pack('<II', zlib.crc32(raw), len(raw))

    def test_canonical_outer_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.tar.gz'
            path.write_bytes(self.outer_fixture())
            self.assertEqual(review.inspect_outer_envelope(path), 1)

    def test_outer_header_and_tail_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.tar.gz'
            for data in (self.outer_fixture(owner='__cookie__:' + '1' * 20), self.outer_fixture(tail=b'not-zero')):
                path.write_bytes(data)
                with self.assertRaises(review.ReviewError):
                    review.inspect_outer_envelope(path)

    def test_extra_gzip_member_with_secret_comment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.tar.gz'
            empty = zlib.compressobj(level=6, wbits=-15)
            extra = b'\x1f\x8b\x08\x10\x00\x00\x00\x00\x00\x03' + b'__cookie__:' + b'x' * 32 + b'\x00' + empty.flush() + struct.pack('<II', 0, 0)
            path.write_bytes(self.outer_fixture() + extra)
            with self.assertRaises(review.ReviewError):
                review.inspect_outer_envelope(path)


if __name__ == '__main__':
    unittest.main()
