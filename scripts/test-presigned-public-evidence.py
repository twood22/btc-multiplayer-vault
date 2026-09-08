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

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('review', Path(__file__).with_name('presigned-public-evidence.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ContentReviewTests(unittest.TestCase):
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
