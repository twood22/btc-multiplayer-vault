#!/usr/bin/env python3
"""Exact local envelope/import, with complete byte scan before private extraction.
The Node reviewer subsequently checks every producer and candidate semantics.
No custody paths, uploads, arbitrary extraction or code execution are allowed.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tarfile

sys.dont_write_bytecode = True
for name, expected in (
    ('presigned-deployment-public-evidence.py', '31d6a6eb1cce31c49e433b7c102b69ae2b472e748aec84286361f1cb0309fb9e'),
    ('presigned-public-evidence.py', '815b768c09085f859266479a3dfb4707273f925e4680760f224cae85e508b1fd')):
    if hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() != expected:
        raise RuntimeError('frozen boundary changed')
spec = importlib.util.spec_from_file_location('boundary', Path(__file__).with_name('presigned-deployment-public-evidence.py'))
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
require = boundary.require
MAX_MEMBER = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024


def inspect(archive, names, expected_sha256):
    boundary.owned_file(archive, MAX_TOTAL)
    require(isinstance(names, list) and len(names) == 171 and len(set(names)) == 171 and
            all(isinstance(name, str) and '/' not in name and boundary.image_review.member_name(name, outer=True) == name for name in names),
            'exact flat 171-file local allowlist required')
    require(boundary.byte_hash(archive) == expected_sha256, 'archive hash differs')
    require(boundary.image_review.inspect_outer_envelope(archive) == 171, 'wrong local envelope membership')
    seen, total = set(), 0
    owner = os.environ.get('GITHUB_REPOSITORY_OWNER', '')
    forbidden = (owner.encode(),) if owner else ()
    with tarfile.open(archive, mode='r|gz') as outer:
        for member in outer:
            require(member.name in names and member.name not in seen and member.isreg() and not member.pax_headers and
                    0 <= member.size <= MAX_MEMBER, 'unapproved local member')
            total += member.size
            require(total <= MAX_TOTAL, 'local decoded bytes exceed bound')
            boundary.image_review.scan_path(member.name)
            data = outer.extractfile(member).read()
            require(len(data) == member.size, 'truncated local member')
            boundary.image_review.scan_bytes(data, forbidden)
            if member.name != 'offline-recovery.html':
                data.decode('utf-8', errors='strict')
            seen.add(member.name)
    require(seen == set(names) and boundary.byte_hash(archive) == expected_sha256, 'local archive changed')
    return total


def main():
    os.umask(0o077)
    require(len(sys.argv) == 6 and sys.argv[1] == 'import', 'exact local import arguments required')
    archive, allowlist, destination = map(Path, sys.argv[2:5])
    names = boundary.read_json(allowlist)
    total = inspect(archive, names, sys.argv[5])
    fs = os.statvfs(destination.parent)
    require(fs.f_bavail * fs.f_frsize >= 2 * 1024 ** 3 + total + len(names) * 8192 + 1024 * 1024,
            'two GiB reserve would be violated')
    boundary.extract_verified_archive(archive, destination, set(names), sys.argv[5])
    fs = os.statvfs(destination.parent)
    require(fs.f_bavail * fs.f_frsize >= 2 * 1024 ** 3, 'two GiB reserve was violated')
    print(json.dumps({'privateExactImport': True, 'members': 171, 'bytes': total, 'contentPrivacyReviewComplete': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'passed': False, 'localArchiveAccepted': False, 'reason': 'local archive boundary refused; private contents omitted'}), file=sys.stderr)
        sys.exit(1)
