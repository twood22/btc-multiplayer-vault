#!/usr/bin/env python3
"""Bounded public input import; never extract OCI layers or upload private state.

Reuses the exact reviewed image scanner. A failed import retains its private
partial directory and cannot produce a deployment proof. No general extractor,
URL input, shell execution, permission bypass or recursive cleanup is provided.
"""
import contextlib
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('image_review', Path(__file__).with_name('presigned-public-evidence.py'))
image_review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image_review)
require = image_review.require
ReviewError = image_review.ReviewError
INPUT_NAMES = ('presigned-v3-signet-test-evidence.tar.gz', 'presigned-v3-signet-retention.json',
               'presigned-v3-signet-content-review.json', 'presigned-v3-signet-executable-acceptance.json')
OUTPUT_NAMES = ('presigned-v3-signet-deployment-acceptance.json', 'presigned-v3-signet-deployment-retention.json')
HEX = re.compile(r'[0-9a-f]{64}')
FINAL_CHECKS = ('exact-graph-and-nine-exits-both-network-formats',
    'core-six-exit-orders-cooperative-recovery-final-sweeps', 'core-hostile-witnesses-and-transaction-mutations',
    'core-real-rolling-fee-floor-truc-and-child-replacement', 'core-database-restart-reorganization-and-broadcast-races',
    'optimized-browser-three-participants-two-prf-passkeys', 'provider-free-offline-recovery-browser',
    'legacy-protocol-boundary-and-funding-intent-restart', 'real-default-signet-lifecycle',
    'fixed-refund-four-rounds-all-nine-trigger-quorums', 'fresh-colluder-signatures-no-unrestricted-tree-bypass',
    'twenty-one-setup-signatures-before-funding-and-restoration', 'v3-server-independent-missing-participant-recovery')


def owned_directory(path):
    require(path.is_absolute() and path.resolve() == path, 'canonical private directory required')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            'owned private directory required')


def owned_file(path, maximum):
    owned_directory(path.parent)
    require(path.resolve() == path, 'input path contains an alias')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and
            not info.st_mode & 0o077 and 0 < info.st_size <= maximum, 'bounded private single-link regular file required')
    return info


def byte_hash(path):
    return image_review.hash_file(path)


def read_json(path):
    owned_file(path, 1024 * 1024)
    return image_review.strict_json(path.read_bytes())


def canonical_timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value),
            'canonical public timestamp required')
    require(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat(timespec='milliseconds').replace('+00:00', 'Z') == value,
            'invalid public timestamp')


def scan_public_json(path):
    data = read_json(path)
    require(isinstance(data, dict), 'public metadata must be an object')
    owner = os.environ.get('GITHUB_REPOSITORY_OWNER', '')
    image_review.scan_bytes(path.read_bytes(), (owner.encode(),) if owner else ())
    if 'createdAt' in data:
        canonical_timestamp(data['createdAt'])
    return data


def validate_input_metadata(pins, retention, review, receipt):
    require(image_review.validate_retention_profile(retention) == 'signet', 'Signet image evidence required')
    require(retention['sourceCommit'] == pins['candidateCommit'] and retention['sourceDigest'] == pins['sourceDigest'] and
            retention['toolingCommit'] == pins['imageToolingCommit'] and retention['workflowRunId'] == pins['imageWorkflowRunId'] and
            retention['evidenceDigest'] == pins['imageReceiptDigest'] and
            retention['archiveSha256'] == pins['inputs'][0]['sha256'] and retention['archiveBytes'] == pins['inputs'][0]['bytes'],
            'retained image input differs from immutable pins')
    require(review.get('version') == 1 and review.get('protocol') == 'presigned-graph-v3' and
            review.get('kind') == 'presigned-v3-test-archive-content-review' and review.get('passed') is True and
            review.get('scannerSha256') == pins['imageScannerSha256'] and
            all(review.get(key) == retention[key] for key in ('sourceCommit', 'sourceDigest', 'toolingCommit', 'workflowRunId', 'network',
                                                              'archiveSha256', 'archiveBytes')) and
            review.get('historicalLayersInspected') is True and review.get('exactArchiveMembersInspected') is True and
            review.get('canonicalOuterEnvelopeVerified') is True and review.get('syntheticOnly') is True and
            all(review.get(key) is False for key in ('productionUsePermitted', 'realDefaultSignetVerified', 'physicalPasskeysVerified',
                                                    'releaseReceiptProduced', 'fundingAuthorized')), 'image privacy review differs from pinned evidence')
    require(isinstance(receipt, dict) and set(receipt) == {'version', 'protocol', 'kind', 'createdAt', 'sourceDigest',
            'testedImageManifestDigest', 'offlineUtilityDigest', 'physicalPasskeys', 'evidence', 'liveSignetReceiptDigest', 'receiptDigest'},
            'unexpected final acceptance metadata')
    require(receipt['version'] == 3 and receipt['protocol'] == 'presigned-graph-v3' and
            receipt['kind'] == 'presigned-v3-executable-acceptance' and receipt['physicalPasskeys'] == 'deferred-to-friends-onboarding' and
            receipt['sourceDigest'] == pins['sourceDigest'] and receipt['testedImageManifestDigest'] == pins['imageManifestDigest'] and
            receipt['offlineUtilityDigest'] == pins['offlineUtilityDigest'] and receipt['receiptDigest'] == pins['acceptanceReceiptDigest'],
            'final acceptance receipt differs from reviewed Signet image pins')
    canonical_timestamp(receipt['createdAt'])
    require(isinstance(receipt['evidence'], list) and len(receipt['evidence']) == len(FINAL_CHECKS) and
            all(isinstance(item, dict) and set(item) == {'check', 'artifactDigest'} and item['check'] in FINAL_CHECKS and
                isinstance(item['artifactDigest'], str) and HEX.fullmatch(item['artifactDigest']) for item in receipt['evidence']) and
            {item['check'] for item in receipt['evidence']} == set(FINAL_CHECKS), 'incomplete or non-public final evidence categories')
    require(isinstance(receipt['liveSignetReceiptDigest'], str) and HEX.fullmatch(receipt['liveSignetReceiptDigest']),
            'missing actual live-Signet receipt identity')
    body = {key: value for key, value in receipt.items() if key != 'receiptDigest'}
    committed = 'vault/presigned-graph-v3/executable-acceptance\n' + json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    require(hashlib.sha256(committed.encode()).hexdigest() == receipt['receiptDigest'], 'final acceptance commitment changed')


def expected_members(receipt):
    image = receipt['image']
    values = [image['manifestDigest'], image['configDigest'], *image['layerDigests']]
    require(0 < len(image['layerDigests']) <= 128 and all(re.fullmatch(r'sha256:[0-9a-f]{64}', value) for value in values),
            'invalid exact image member identities')
    names = {'image-acceptance.json', 'browser.json', 'runtime.json', 'oci/oci-layout', 'oci/index.json'}
    names.update(f'{stage}.{channel}.log' for stage in image_review.STAGES for channel in ('stdout', 'stderr'))
    names.update(f'oci/blobs/sha256/{value[7:]}' for value in values)
    return names


def copy_pinned_file(source, target, expected_size, expected_sha256):
    require(type(expected_size) is int and 0 < expected_size <= image_review.MAX_ARCHIVE and
            isinstance(expected_sha256, str) and HEX.fullmatch(expected_sha256), 'invalid exact copy bounds')
    before = owned_file(source, expected_size)
    require(before.st_size == expected_size, 'copy input size differs')
    owned_directory(target.parent)
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(source_fd)
        require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1 and
                (opened.st_dev, opened.st_ino, opened.st_size) == (before.st_dev, before.st_ino, before.st_size), 'copy input changed while opening')
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            total, digest = 0, hashlib.sha256()
            while True:
                chunk = os.read(source_fd, min(1024 * 1024, expected_size - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                require(total <= expected_size, 'copy input grew beyond its bound')
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    count = os.write(target_fd, view)
                    require(count > 0, 'copy made no progress')
                    view = view[count:]
            after = os.fstat(source_fd)
            require(total == expected_size and digest.hexdigest() == expected_sha256 and
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (before.st_size, before.st_mtime_ns, before.st_ctime_ns),
                    'exact copy input changed')
            os.fsync(target_fd)
        finally:
            os.close(target_fd)
    finally:
        os.close(source_fd)


def extract_verified_archive(archive, destination, names, expected_sha256):
    """Exact regular-file import only; callers must first run content review."""
    owned_file(archive, image_review.MAX_ARCHIVE)
    require(isinstance(names, set) and 0 < len(names) <= 512 and
            all(isinstance(name, str) and image_review.member_name(name, outer=True) == name and
                len(name) <= 100 and all(part not in ('', '.', '..') for part in name.split('/')) for name in names),
            'invalid exact import allowlist')
    require(not any('/'.join(name.split('/')[:i]) in names for name in names for i in range(1, len(name.split('/')))),
            'file and directory import targets overlap')
    require(byte_hash(archive) == expected_sha256, 'downloaded archive hash differs')
    require(image_review.inspect_outer_envelope(archive) == len(names), 'archive envelope membership differs')
    owned_directory(destination.parent)
    require(destination.is_absolute() and destination.parent.resolve() == destination.parent, 'private import destination required')
    destination.mkdir(mode=0o700)  # Never adopt or overwrite a partial import.
    seen, directories, total = set(), {destination}, 0
    with tarfile.open(archive, mode='r|gz') as outer:
        for member in outer:
            name = image_review.member_name(member.name, outer=True)
            require(member.name == name and name in names and name not in seen and member.isreg() and not member.pax_headers,
                    'unapproved, duplicate, linked or special archive member')
            require(0 <= member.size <= image_review.MAX_ARCHIVE, 'archive member exceeds bound')
            total += member.size
            require(total <= image_review.MAX_DECODED, 'import exceeds total byte bound')
            target = destination / name
            for parent in reversed(target.parents):
                if parent == destination or destination in parent.parents:
                    if parent not in directories:
                        parent.mkdir(mode=0o700)
                        directories.add(parent)
                    owned_directory(parent)
            body = outer.extractfile(member)
            require(body is not None, 'missing regular archive body')
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                remaining = member.size
                while remaining:
                    data = body.read(min(1024 * 1024, remaining))
                    require(bool(data) and len(data) <= remaining, 'truncated or oversized import body')
                    remaining -= len(data)
                    view = memoryview(data)
                    while view:
                        written = os.write(fd, view)
                        require(written > 0, 'import made no progress')
                        view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            seen.add(name)
    require(seen == names and byte_hash(archive) == expected_sha256, 'archive changed or exact import is incomplete')
    for directory in directories:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def prepare(root):
    owned_directory(root)
    pins = read_json(root / 'pins.json')
    downloads = root / 'downloads'
    owned_directory(downloads)
    require(set(path.name for path in downloads.iterdir()) == set(INPUT_NAMES), 'unexpected downloaded input')
    require([item['name'] for item in pins['inputs']] == list(INPUT_NAMES), 'unapproved input names')
    for item in pins['inputs']:
        path = downloads / item['name']
        info = owned_file(path, image_review.MAX_ARCHIVE if item['name'].endswith('.tar.gz') else 1024 * 1024)
        require(info.st_size == item['bytes'] and byte_hash(path) == item['sha256'], 'downloaded input changed')
    require(byte_hash(Path(__file__).with_name('presigned-public-evidence.py')) == pins['imageScannerSha256'],
            'image scanner differs from the exact pinned content reviewer')
    retention, review, receipt = [scan_public_json(downloads / name) for name in INPUT_NAMES[1:]]
    validate_input_metadata(pins, retention, review, receipt)
    scan = root / 'image-input-review'
    scan.mkdir(mode=0o700)
    for index, name in enumerate(INPUT_NAMES[:2]):
        # Exact public bytes only; copies remain single-link and exclusive.
        item = pins['inputs'][index]
        copy_pinned_file(downloads / name, scan / name, item['bytes'], item['sha256'])
    with contextlib.redirect_stdout(io.StringIO()):
        image_review.review(str(scan))
    require(read_json(scan / INPUT_NAMES[2]) == review, 'fresh content review differs from the exact retained review')
    image_receipt = None
    with tarfile.open(scan / INPUT_NAMES[0], mode='r|gz') as archive:
        for member in archive:
            if member.name == 'image-acceptance.json':
                require(member.isreg() and member.size <= 1024 * 1024, 'invalid image receipt member')
                image_receipt = image_review.strict_json(archive.extractfile(member).read())
                break
    image_review.validate_image_receipt_profile(image_receipt, retention)
    require(image_receipt['image']['manifestDigest'] == pins['imageManifestDigest'] and
            image_receipt['image']['configDigest'] == pins['imageConfigDigest'] and
            image_receipt['offlineUtilityDigest'] == pins['offlineUtilityDigest'], 'image receipt differs from deployment pins')
    extract_verified_archive(scan / INPUT_NAMES[0], root / 'image', expected_members(image_receipt), pins['inputs'][0]['sha256'])
    print(json.dumps({'prepared': True, 'actualDeploymentExecuted': False, 'privateInputsUploaded': False}))


def inspect_outputs(root):
    directory = root / 'outputs'
    owned_directory(directory)
    require(set(path.name for path in directory.iterdir()) == set(OUTPUT_NAMES), 'only two exact public output files may be retained')
    for name in OUTPUT_NAMES:
        owned_file(directory / name, 65536)
        scan_public_json(directory / name)
    print(json.dumps({'publicMetadataScanned': True, 'files': 2, 'privateDirectoryUploads': False}))


if __name__ == '__main__':
    try:
        os.umask(0o077)
        require(len(sys.argv) == 3 and sys.argv[1] in ('prepare', 'inspect-outputs'), 'unsupported bounded evidence operation')
        root = Path(sys.argv[2])
        require(os.environ.get('GITHUB_ACTIONS') == 'true' and root == Path(os.environ['RUNNER_TEMP']) / 'presigned-v3-deployment-ci',
                'only the exact disposable runner directory is supported')
        (prepare if sys.argv[1] == 'prepare' else inspect_outputs)(root)
    except Exception:
        print(json.dumps({'passed': False, 'reason': 'public evidence boundary refused; private contents omitted', 'uploaded': False}), file=sys.stderr)
        sys.exit(1)
