#!/usr/bin/env python3
"""Read-only, bounded review of exact test archives, including deleted layers.

No extraction, eval, subprocess, network access, or matched secret values in
errors. This is not a general proof that arbitrary binaries contain no secrets.
It supplements the fresh-runner, no-credential build and semantic verifier.
"""
import base64
import io
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import zlib

MAX_ARCHIVE = 2 * 1024 ** 3 - 1
MAX_DECODED = 8 * 1024 ** 3
MAX_MEMBER = 512 * 1024 ** 2
STAGES = ('rootless-preflight', 'build-image', 'inspect-image', 'export-oci',
          'runtime-identity', 'operator-runtime', 'browser-execution')
SECRET_PATTERNS = (
    rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[ \t\r\n]+(?:[A-Za-z0-9-]{1,40}:[^\r\n]{0,200}\r?\n){0,8}[ \t\r\n]*(?:[A-Za-z0-9+/=][ \t\r\n]*){32}',
    rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})',
    rb'__cookie__:[A-Za-z0-9+/=_-]{16,}',
    rb'(?i)["\x27](?:personalPrivateKey|payoutPrivateKey|privateKeyHex|recoveryKey|walletSeed|mnemonic)["\x27]\s*:\s*["\x27][A-Za-z0-9+/= _-]{32,}["\x27]',
    rb'(?i)(?:rpcpassword|_authToken)\s*[=:]\s*["\x27]?[A-Za-z0-9_+/=-]{20,}',
    rb'(?i)authorization\s*[:=]\s*["\x27]?(?:bearer|basic) [A-Za-z0-9+/=_-]{20,}',
)
COMPILED = tuple(re.compile(pattern) for pattern in SECRET_PATTERNS)
FRAMEWORK_KEY = re.compile(rb'"(?:encryptionKey|previewModeSigningKey|previewModeEncryptionKey)"\s*:\s*"[A-Za-z0-9+/=]{32,}"')
SCAN_LOCATION = 'archive'
# Public known-answer test constants, independently matched byte-for-byte to
# Debian gnutls28 3.7.9-2+deb12u7 lib/crypto-selftests-pk.c (source SHA-256
# c3d79122e072177f55dc30a98f68b949c0f36f6159a363aae9512a22a9280ed0).
# This is NOT a dependency/binary/PEM exemption. Each permitted prefix needs its
# exact absolute tar offset/hash, the exact library path/data offset/full hash,
# and the complete pinned public layer's recomputed hash before acceptance.
PUBLIC_SELFTEST_LAYER = 'sha256:66462cc862fe2053b9863fefa3866e07bb5dfb06f6b3ce3177cc096e4021aabe'
PUBLIC_SELFTEST_LIBRARY = 'usr/lib/x86_64-linux-gnu/libgnutls.so.30.34.3'
PUBLIC_SELFTEST_LIBRARY_SHA = '779b25d20249988bea2c1aa6bbeb218f5ae7ea8a9d30ce4f54ea37372965cc4b'
PUBLIC_SELFTEST_LIBRARY_OFFSET = 41243648
PUBLIC_SELFTEST_PEMS = {
    42830560: '44ae6697029e164bb2806e1e6451191c842135a19c0b6c8cfafcfd381c7bf6bd',
    42830784: 'bfc3a3f38b8fc38418c7134de56ac4c0817fadcd780d1e44259a21b5f77d1562',
    42830944: '8f44247507bf319ea32fe99e20ef0e51a29728f687d39ed5031b86f81bc97c5b',
    42832704: '30baf071efd07da5161c8e210f8c277a17222a8bdd24675284904d061b337862',
    42833024: '1dbd7ca4219e8deef2478cde99de95c38b604a092ca2ccf4d9ce88e4836ce283',
    42834528: '6c928c7c99db09403dabacd8858575de4cedc2d93e5e35c5cb38c335e470405d',
}


class ReviewError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise ReviewError(reason)


def strict_json(data):
    def pairs(entries):
        result = {}
        for key, value in entries:
            require(key not in result, 'duplicate JSON member')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def location(name):
    global SCAN_LOCATION
    # Even a filename can be a secret. Resolve this digest against known public
    # source paths privately; never echo a rejected archive filename.
    SCAN_LOCATION = 'path-sha256:' + hashlib.sha256(name.encode()).hexdigest()


class SingleGzipReader(io.RawIOBase):
    """Exactly one bounded gzip member: no ignored comments in extra members."""
    def __init__(self, path):
        super().__init__()
        self.raw = path.open('rb')
        self.decoder = zlib.decompressobj(31)
        self.pending = b''
        self.finished = False
        self.decoded = 0

    def readable(self):
        return True

    def readinto(self, output):
        if self.finished:
            return 0
        while True:
            if not self.pending:
                self.pending = self.raw.read(64 * 1024)
                require(bool(self.pending), 'truncated single gzip member')
            data = self.decoder.decompress(self.pending, len(output))
            self.pending = self.decoder.unconsumed_tail
            self.decoded += len(data)
            require(self.decoded <= MAX_DECODED, 'gzip decoded bytes exceed limit')
            if self.decoder.eof:
                require(not self.decoder.unused_data and not self.pending and not self.raw.read(1),
                        'extra gzip member or compressed trailer')
                self.finished = True
            if data:
                output[:len(data)] = data
                return len(data)
            if self.finished:
                return 0

    def close(self):
        self.raw.close()
        super().close()


def inspect_outer_envelope(path):
    """The exact GNU ustar/gzip envelope emitted by the frozen packer."""
    def octal(field):
        require(bool(re.fullmatch(rb'[ 0-7\x00]+', field)), 'invalid outer numeric field')
        return int(field.strip(b' \x00') or b'0', 8)
    with path.open('rb') as raw:
        require(raw.read(10) == b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03', 'noncanonical outer gzip header')
    names = set()
    total = 0
    with io.BufferedReader(SingleGzipReader(path), buffer_size=1024 * 1024) as data:
        while True:
            header = data.read(512)
            require(len(header) == 512, 'truncated outer tar header')
            total += 512
            if header == b'\x00' * 512:
                require(data.read(512) == b'\x00' * 512, 'invalid outer end marker')
                total += 512
                tail = data.read(10241)
                require(len(tail) <= 10240 and not tail.strip(b'\x00') and not data.read(1), 'nonzero or excessive outer trailer')
                total += len(tail)
                break
            first, *rest = header[:100].split(b'\x00', 1)
            require(not rest or not rest[0].strip(b'\x00'), 'noncanonical outer name padding')
            name = member_name(first.decode('ascii'), outer=True)
            require(name not in names and len(names) < 512, 'duplicate outer header')
            names.add(name)
            require(octal(header[100:108]) == 0o600 and octal(header[108:116]) == 0 and octal(header[116:124]) == 0 and
                    octal(header[136:148]) == 0, 'noncanonical outer ownership, mode or time')
            size = octal(header[124:136])
            require(size <= MAX_ARCHIVE, 'oversized outer body')
            require(octal(header[148:156]) == sum(header[:148] + b' ' * 8 + header[156:]), 'invalid outer checksum')
            require(header[156:157] == b'0' and header[157:257] == b'\x00' * 100 and header[257:265] == b'ustar\x0000',
                    'unsupported outer type or format')
            require(not header[265:329].strip(b'\x00') and octal(header[329:337]) == 0 and octal(header[337:345]) == 0 and
                    not header[345:].strip(b'\x00'), 'noncanonical outer metadata')
            remaining = size
            while remaining:
                chunk = data.read(min(1024 * 1024, remaining))
                require(bool(chunk), 'truncated outer body')
                remaining -= len(chunk)
            padding = (-size) % 512
            require(data.read(padding) == b'\x00' * padding, 'nonzero outer file padding')
            total += size + padding
            require(total <= MAX_DECODED, 'outer envelope exceeds limit')
    require(total % 10240 == 0, 'noncanonical outer tar record size')
    return len(names)


def member_name(name, outer=False):
    require(isinstance(name, str) and len(name) <= 1024 and '\x00' not in name,
            'invalid member name')
    # OCI writers commonly prefix names with ./; never permit an absolute path.
    require(not name.startswith('/'), 'absolute archive member')
    parts = PurePosixPath(name).parts
    require('..' not in parts, 'traversal archive member')
    normalized = '/'.join(part for part in parts if part != '.')
    if outer:
        require(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,99}', normalized)),
                'unreviewed outer member name')
    return normalized


def scan_path(name):
    parts = name.lower().split('/')
    require(not any(part in {'.git', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.cookie',
                            'wallet.dat', 'wallets', 'node-wallet-backup.dat', 'pgdata', 'pg_version'} for part in parts),
            'credential or wallet path')
    require(not any((part == '.env' or part.startswith('.env.')) and part != '.env.example' for part in parts),
            'operational dotenv path')
    require(not re.search(r'(?:^|/)(?:control|lifecycle|native-wallet-backup|passkey-envelope)\.json$', name, re.I),
            'private lifecycle or custody path')
    require(not name.startswith(('home/runner/', 'home/codex/')), 'host home copied into image')
    require(not name.endswith(('.dump', '.sqlite', '.sqlite3')), 'database dump path')


def scan_bytes(data, forbidden=(), permitted_pems=None, data_offset=0):
    for index, pattern in enumerate(COMPILED):
        for match in pattern.finditer(data):
            if index == 0 and permitted_pems and permitted_pems.get(data_offset + match.start()) == hashlib.sha256(match[0]).hexdigest():
                continue
            error = ReviewError('credential-like content')
            error.rule_index = index
            raise error
    lowered = data.lower()
    require(not any(value.lower() in lowered for value in forbidden if len(value) >= 4),
            'unintended identifying content')
    require(not re.search(rb'(?i)/(?:home/codex|Users/[^/\s]+)/(?:\.codex|Vaults|assistant-home)', data),
            'private operational host path')


def scan_stream(stream, size, forbidden, permitted_pems=None, file_offset=0):
    require(0 <= size <= MAX_MEMBER, 'oversized decoded member')
    digest = hashlib.sha256()
    remaining = size
    tail = b''
    while remaining:
        read_before = size - remaining
        chunk = stream.read(min(1024 * 1024, remaining))
        require(bool(chunk), 'truncated member')
        remaining -= len(chunk)
        digest.update(chunk)
        scan_bytes(tail + chunk, forbidden, permitted_pems, file_offset + read_before - len(tail))
        require(not FRAMEWORK_KEY.search(tail + chunk), 'framework key outside its exact reviewed manifest')
        tail = (tail + chunk)[-8192:]
    return digest.hexdigest()


def check_action_manifest(name, data):
    """Only an unused generated framework test-build key, never an action key."""
    if name == 'app/.next/server/server-reference-manifest.json':
        body = strict_json(data)
        require(set(body) == {'node', 'edge', 'encryptionKey'} and body['node'] == {} and body['edge'] == {},
                'nonempty or unknown server-action manifest')
        try:
            key = base64.b64decode(body['encryptionKey'], validate=True)
        except Exception:
            raise ReviewError('invalid generated test-framework key') from None
        require(len(key) == 32, 'invalid generated test-framework key size')
        require(base64.b64encode(key).decode() == body['encryptionKey'], 'noncanonical generated framework key')
        return True
    if name == 'app/.next/server/server-reference-manifest.js':
        text = data.decode('utf-8').strip()
        prefix = 'self.__RSC_SERVER_MANIFEST='
        require(text.startswith(prefix), 'unexpected framework manifest script')
        encoded = text[len(prefix):].removesuffix(';')
        body = strict_json(strict_json(encoded))
        require(set(body) == {'node', 'edge', 'encryptionKey'} and body['node'] == {} and body['edge'] == {} and
                body['encryptionKey'] == 'process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY',
                'unexpected framework manifest script content')
    return False


def check_preview_manifest(data):
    body = strict_json(data)
    require(set(body) == {'version', 'routes', 'dynamicRoutes', 'notFoundRoutes', 'preview'} and body['version'] == 4,
            'unexpected prerender manifest schema')
    preview = body['preview']
    require(set(preview) == {'previewModeId', 'previewModeSigningKey', 'previewModeEncryptionKey'},
            'unexpected generated preview schema')
    for field, length in (('previewModeId', 32), ('previewModeSigningKey', 64), ('previewModeEncryptionKey', 64)):
        require(isinstance(preview[field], str) and bool(re.fullmatch('[0-9a-f]{' + str(length) + '}', preview[field])),
                'unexpected generated preview key format')
    # This exact frozen application has no preview/draft-mode consumers. These
    # fresh framework values are permanently public TEST keys, never production.
    remaining = {key: value for key, value in body.items() if key != 'preview'}
    require(not FRAMEWORK_KEY.search(json.dumps(remaining).encode()), 'unexpected additional framework key')


class ReviewedLayerReader:
    """Also scan tar headers, padding, and any trailing bytes, not just files."""
    def __init__(self, stream, forbidden, totals, layer_digest=None):
        self.stream, self.forbidden, self.totals = stream, forbidden, totals
        self.tail = b''
        self.position = 0
        self.digest = hashlib.sha256()
        self.permitted_pems = PUBLIC_SELFTEST_PEMS if layer_digest == PUBLIC_SELFTEST_LAYER else None

    def read(self, size=-1):
        data = self.stream.read(size)
        offset = self.position - len(self.tail)
        self.position += len(data)
        self.digest.update(data)
        self.totals['decodedTarBytes'] += len(data)
        require(self.totals['decodedTarBytes'] <= MAX_DECODED, 'decoded tar exceeds limit')
        scan_bytes(self.tail + data, self.forbidden, self.permitted_pems, offset)
        self.tail = (self.tail + data)[-8192:]
        return data


def inspect_layer(stream, forbidden, totals, layer_digest=None):
    # tarfile streaming mode only decodes headers and reads bytes. Symlinks and
    # hardlinks are never followed, and nothing is materialized on the host.
    reader = ReviewedLayerReader(stream, forbidden, totals, layer_digest)
    # The frozen export command explicitly requests uncompressed OCI layers.
    # Refuse any other format rather than skipping bytes during decompression.
    with tarfile.open(fileobj=reader, mode='r|') as layer:
        for member in layer:
            totals['layerMembers'] += 1
            require(totals['layerMembers'] <= 200000, 'excessive layer members')
            name = member_name(member.name)
            location(name)
            scan_path(name)
            scan_bytes(name.encode(), forbidden)
            scan_bytes(member.uname.encode(), forbidden)
            scan_bytes(member.gname.encode(), forbidden)
            require(member.isreg() or member.isdir() or member.issym() or member.islnk(),
                    'device or unsupported layer member')
            for key, value in member.pax_headers.items():
                scan_bytes((key + '=' + value).encode(), forbidden)
            if member.issym() or member.islnk():
                # Base-image links can legitimately be absolute or use ../.
                # They are inspected as data, not used for extraction.
                scan_bytes(member.linkname.encode(), forbidden)
            if member.isreg():
                totals['decodedBytes'] += member.size
                require(totals['decodedBytes'] <= MAX_DECODED, 'decoded image exceeds limit')
                body = layer.extractfile(member)
                require(body is not None, 'missing regular layer body')
                if name in ('app/.next/server/server-reference-manifest.json', 'app/.next/server/server-reference-manifest.js',
                            'app/.next/prerender-manifest.json'):
                    require(member.size <= 1024 * 1024, 'oversized framework manifest')
                    data = body.read()
                    require(len(data) == member.size, 'truncated framework manifest')
                    scan_bytes(data, forbidden)
                    if name == 'app/.next/prerender-manifest.json':
                        check_preview_manifest(data)
                        totals['testPreviewManifests'] += 1
                    else:
                        totals['unusedTestFrameworkKeys'] += int(check_action_manifest(name, data))
                else:
                    if layer_digest == PUBLIC_SELFTEST_LAYER and name == PUBLIC_SELFTEST_LIBRARY:
                        require(member.offset_data == PUBLIC_SELFTEST_LIBRARY_OFFSET and member.size == 2209528,
                                'public self-test library location or size changed')
                        digest = scan_stream(body, member.size, forbidden, reader.permitted_pems, member.offset_data)
                        require(digest == PUBLIC_SELFTEST_LIBRARY_SHA, 'public self-test library bytes changed')
                        totals['publicSelfTestLibraries'] = totals.get('publicSelfTestLibraries', 0) + 1
                    else:
                        scan_stream(body, member.size, forbidden)
    while reader.read(1024 * 1024):
        pass
    if layer_digest is not None:
        require('sha256:' + reader.digest.hexdigest() == layer_digest, 'reviewed raw layer digest changed')


def owned_file(path, maximum):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077 and info.st_size <= maximum,
            'input must be a bounded owned private regular file')
    return info


def hash_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def review(directory):
    os.umask(0o077)
    root = Path(directory)
    info = root.lstat()
    require(root.is_absolute() and root.resolve() == root and stat.S_ISDIR(info.st_mode) and
            info.st_uid == os.getuid() and not info.st_mode & 0o077, 'private canonical review directory required')
    retained = list(root.glob('presigned-v2-*-retention.json'))
    require(len(retained) == 1, 'one exact retention record required')
    owned_file(retained[0], 1024 * 1024)
    retention = strict_json(retained[0].read_bytes())
    network = retention['network']
    require(network in ('signet', 'mainnet') and retention['syntheticOnly'] is True and
            retention['productionUsePermitted'] is False, 'only test evidence can be reviewed')
    asset = f'presigned-v2-{network}-test-evidence.tar.gz'
    require(retention['assetName'] == asset, 'unexpected asset name')
    archive = root / asset
    size = owned_file(archive, MAX_ARCHIVE).st_size
    digest = hash_file(archive)
    require(digest == retention['archiveSha256'] and size == retention['archiveBytes'], 'archive differs from verified bytes')
    require(inspect_outer_envelope(archive) == retention['files'], 'outer envelope membership differs')
    # Repo owner is an ephemeral review input, not embedded in public tooling or
    # review reports. Dependency authorship is public source, not host identity.
    owner = os.environ.get('GITHUB_REPOSITORY_OWNER', '')
    forbidden = (owner.encode(),) if owner else ()
    totals = {'layerMembers': 0, 'decodedBytes': 0, 'decodedTarBytes': 0, 'unusedTestFrameworkKeys': 0,
              'testPreviewManifests': 0, 'publicSelfTestLibraries': 0}
    names = set()
    layers = set()
    json_blobs = {}
    receipt = None
    with tarfile.open(archive, mode='r|gz') as outer:
        for member in outer:
            name = member_name(member.name, outer=True)
            location(name)
            require(member.isreg() and name not in names and len(names) < 512 and 0 <= member.size <= MAX_ARCHIVE,
                    'unexpected outer member type, duplicate or size')
            names.add(name)
            scan_bytes(name.encode(), forbidden)
            body = outer.extractfile(member)
            require(body is not None, 'missing archive body')
            blob = name.removeprefix('oci/blobs/sha256/')
            if receipt and name == f'oci/blobs/sha256/{blob}' and f'sha256:{blob}' in receipt['image']['layerDigests']:
                inspect_layer(body, forbidden, totals, f'sha256:{blob}')
                layers.add(f'sha256:{blob}')
            else:
                require(member.size <= 32 * 1024 * 1024, 'unexpected large non-layer archive member')
                data = body.read()
                require(len(data) == member.size, 'truncated archive member')
                scan_bytes(data, forbidden)
                if name == 'image-acceptance.json':
                    receipt = strict_json(data)
                    require(receipt['sourceDigest'] == retention['sourceDigest'] and receipt['receiptDigest'] == retention['evidenceDigest'],
                            'receipt differs from retained candidate')
                if name.startswith('oci/blobs/sha256/'):
                    json_blobs[f'sha256:{blob}'] = strict_json(data)
    require(receipt is not None, 'missing image receipt')
    image = receipt['image']
    expected = {'image-acceptance.json', 'browser.json', 'runtime.json', 'oci/oci-layout', 'oci/index.json'}
    expected.update(f'{stage}.{channel}.log' for stage in STAGES for channel in ('stdout', 'stderr'))
    expected.update(f'oci/blobs/sha256/{value[7:]}' for value in
                    {image['manifestDigest'], image['configDigest'], *image['layerDigests']})
    require(names == expected and len(names) == retention['files'] and layers == set(image['layerDigests']),
            'missing or extra actual archive members or historical layers')
    config = json_blobs[image['configDigest']]
    expected_env = {'PATH', 'NODE_VERSION', 'YARN_VERSION', 'NEXT_TELEMETRY_DISABLED', 'NODE_ENV',
                    'VAULT_NETWORK', 'NEXT_PUBLIC_VAULT_NETWORK', 'HOSTNAME', 'PORT'}
    env = config['config']['Env']
    require(len(env) == len(expected_env) and {value.split('=', 1)[0] for value in env} == expected_env,
            'unreviewed image environment')
    env_values = dict(value.split('=', 1) for value in env)
    require(env_values == {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                          'NODE_VERSION': '22.23.2', 'YARN_VERSION': '1.22.22', 'NEXT_TELEMETRY_DISABLED': '1',
                          'NODE_ENV': 'production', 'VAULT_NETWORK': network, 'NEXT_PUBLIC_VAULT_NETWORK': network,
                          'HOSTNAME': '0.0.0.0', 'PORT': '3000'}, 'unreviewed image environment values')
    manifest = json_blobs[image['manifestDigest']]
    require(all(layer['mediaType'] == 'application/vnd.oci.image.layer.v1.tar' for layer in manifest['layers']),
            'unexpected compressed layer format')
    require(totals['unusedTestFrameworkKeys'] > 0, 'unused framework action-manifest evidence missing')
    require(totals['testPreviewManifests'] > 0, 'test preview-manifest evidence missing')
    require(totals['publicSelfTestLibraries'] == 1, 'exact pinned public self-test library evidence missing')
    require(hash_file(archive) == digest, 'archive changed during content review')
    result = {'version': 1, 'kind': 'presigned-v2-test-archive-content-review', 'passed': True, 'network': network,
              'archiveSha256': digest, 'archiveBytes': size, 'archiveMembers': len(names), 'layers': len(layers), **totals,
              'sourceCommit': retention['sourceCommit'], 'sourceDigest': retention['sourceDigest'],
              'toolingCommit': retention['toolingCommit'], 'workflowRunId': retention['workflowRunId'],
              'scannerSha256': hash_file(Path(__file__)),
              'historicalLayersInspected': True, 'exactArchiveMembersInspected': True,
              'canonicalOuterEnvelopeVerified': True,
              'knownPublicSelfTestPemCount': 6, 'publicSelfTestLibrarySha256': PUBLIC_SELFTEST_LIBRARY_SHA,
              'freshCredentialFreeHostedBuildRequired': True, 'universalSecretAbsenceProven': False,
              'productionUsePermitted': False, 'fundingAuthorized': False}
    output = root / f'presigned-v2-{network}-content-review.json'
    with output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'usage: review one retained test archive directory')
        review(sys.argv[1])
    except Exception as error:
        # Never include data-derived exception messages or raw matched values.
        reason = str(error) if isinstance(error, ReviewError) else 'malformed or unsupported archive content'
        print(json.dumps({'passed': False, 'reason': reason, 'location': SCAN_LOCATION,
                          'ruleIndex': getattr(error, 'rule_index', None), 'uploaded': False}), file=sys.stderr)
        sys.exit(1)
