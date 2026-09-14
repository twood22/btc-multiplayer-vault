#!/usr/bin/env python3
"""Synthetic envelope-only local tests; no candidate proof, keys or network."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import struct
import sys
import tarfile
import tempfile
import unittest
import zlib

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('local', Path(__file__).with_name('presigned-local-archive.py'))
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)
os.umask(0o077)


def encode(members):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for name, data, kind, link in members:
            info = tarfile.TarInfo(name)
            info.mode, info.uid, info.gid, info.mtime = 0o600, 0, 0, 0
            info.type, info.linkname, info.size = kind, link, len(data)
            tar.addfile(info, io.BytesIO(data))
    data = raw.getvalue()
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
    return b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03' + compressor.compress(data) + compressor.flush() + struct.pack('<II', zlib.crc32(data), len(data))


class LocalArchiveTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='synthetic-local-public-')
        self.root = Path(self.scratch.name)
        self.names = ['run.json', 'offline-recovery.html'] + [f'synthetic-{n:03}.stdout.log' for n in range(163)]
        self.members = [(n, b'{"synthetic":true}\n', tarfile.REGTYPE, '') for n in self.names]

    def tearDown(self):
        self.scratch.cleanup()

    def inspect(self, members=None, change=lambda data: data, names=None):
        data = change(encode(self.members if members is None else members))
        archive = self.root / 'evidence.tar.gz'
        archive.write_bytes(data)
        archive.chmod(0o600)
        return local.inspect(archive, self.names if names is None else names, hashlib.sha256(data).hexdigest())

    def test_exact_private_envelope_and_extract(self):
        self.assertGreater(self.inspect(), 0)
        archive = self.root / 'evidence.tar.gz'
        destination = self.root / 'restored'
        local.boundary.extract_verified_archive(archive, destination, set(self.names), local.boundary.byte_hash(archive))
        self.assertEqual(len(list(destination.iterdir())), 165)
        for path in destination.iterdir():
            self.assertEqual(path.read_bytes(), b'{"synthetic":true}\n')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
        with self.assertRaises(Exception):
            local.boundary.extract_verified_archive(archive, destination, set(self.names), local.boundary.byte_hash(archive))

    def test_membership_and_paths(self):
        variants = [self.members[:-1], self.members + [self.members[0]], [self.members[0], *self.members[:-1]]]
        for name in ['../wallet.dat', '/private', 'wallet.dat', '.cookie', '.env.local', 'database.dump', 'a/b.json']:
            variants.append([(name, b'{}', tarfile.REGTYPE, ''), *self.members[1:]])
        for members in variants:
            with self.subTest(kind='member refusal'), self.assertRaises(Exception):
                self.inspect(members)

    def test_link_and_special_types(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE]:
            with self.subTest(kind=kind), self.assertRaises(Exception):
                self.inspect([(self.names[0], b'', kind, 'wallet.dat'), *self.members[1:]])

    def test_all_bytes_scanned_for_credentials(self):
        values = [b'__cookie__:' + b'a' * 64, b'ghp_' + b'a' * 40,
                  b'{"privateKeyHex":"' + b'a' * 64 + b'"}', b'authorization: bearer ' + b'a' * 40,
                  b'rpcpassword=' + b'a' * 40, b'/home/codex/.codex/private']
        for data in values:
            for index in [0, 1, 164]:
                members = list(self.members)
                members[index] = (self.names[index], data, tarfile.REGTYPE, '')
                with self.subTest(member=index), self.assertRaises(Exception):
                    self.inspect(members)

    def test_gzip_trailers_and_truncation(self):
        for change in [lambda b: b + b'private', lambda b: b + b, lambda b: b[:-1], lambda b: b[:-8], lambda b: b'private' + b]:
            with self.subTest(kind='compressed refusal'), self.assertRaises(Exception):
                self.inspect(change=change)

    def test_utf8_hash_permissions_and_allowlist(self):
        with self.assertRaises(Exception):
            self.inspect([(self.names[0], b'\xff', tarfile.REGTYPE, ''), *self.members[1:]])
        with self.assertRaises(Exception):
            self.inspect(names=self.names[:-1] + [self.names[0]])
        self.inspect()
        archive = self.root / 'evidence.tar.gz'
        with self.assertRaises(Exception):
            local.inspect(archive, self.names, '0' * 64)
        archive.chmod(0o644)
        with self.assertRaises(Exception):
            local.inspect(archive, self.names, local.boundary.byte_hash(archive))


if __name__ == '__main__':
    unittest.main()
