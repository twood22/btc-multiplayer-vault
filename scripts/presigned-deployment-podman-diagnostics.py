"""Private diagnostic passthrough, never an alternate Podman implementation.

The runner copies these exact bytes to a private executable named podman. Only
that generated copy can execute the descriptor-bound real /usr/bin/podman.
The ordinary tooling file permits synthetic self-tests only. No raw command,
environment, output, exception message or private path enters a record.
"""
import ctypes
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

OPERATIONS = frozenset(['unknown', 'info', 'image-inspect', 'image-probe',
    'list-owned', 'container-inspect', 'start-owned', 'stop-owned',
    'remove-transient', 'run-web', 'run-migration', 'run-watcher'])
CLASSIFICATIONS = {
    'usernamespace-clone-denied': r'cannot clone: operation not permitted',
    'rootless-reexec-failed': r'cannot re-exec process',
    'uid-map-denied': r'newuidmap.*(?:operation not permitted|permission denied|write to uid_map failed)',
    'gid-map-denied': r'newgidmap.*(?:operation not permitted|permission denied|write to gid_map failed)',
    'subordinate-ids-missing': r'(?:no|missing) (?:subuid|subgid|subordinate uid|subordinate gid) (?:ranges|ids|mappings)',
    'cgroup-denied': r'cgroup.*(?:permission denied|operation not permitted|read-only file system)',
    'resource-limit-denied': r'(?:setrlimit|rlimit_|resource limit).*(?:permission denied|operation not permitted)',
    'mount-denied': r'mount.*(?:permission denied|operation not permitted)',
    'seccomp-denied': r'seccomp.*(?:permission denied|operation not permitted|not supported)',
    'confinement-denied': r'(?:apparmor|selinux).*(?:denied|not permitted|not supported)',
    'keep-id-unsupported': r'(?:keep-id.*not supported|unsupported.*userns|invalid.*userns)',
    'unsupported-option': r'^(?:error: )?(?:unknown|unrecognized) (?:flag|option)',
    'oci-runtime-unavailable': r'oci runtime.*(?:not available|not found|invalid argument)',
    'oci-executable-missing': r'(?:executable file not found|exec.*no such file or directory)',
    'filesystem-read-only': r'read-only file system',
    'disk-space-exhausted': r'no space left on device',
    'memory-allocation-failed': r'cannot allocate memory',
    'operation-not-permitted': r'operation not permitted',
    'permission-denied': r'permission denied',
}
HEX = re.compile(r'^[0-9a-f]{64}$')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
UUID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
USER = re.compile(r'^[1-9][0-9]{0,9}:(?:0|[1-9][0-9]{0,9})$')
PROBE_SHA = '3ad0901449aadb85471bccd1643d4dc79b9459445024188d43d81ec6a4b84a99'
DIAGNOSTIC_LIMIT = 65536


def operation(args):
    """Unrecognized argv still pass through; this enum grants no authority."""
    if not isinstance(args, list) or not all(isinstance(x, str) for x in args) or args[:1] != ['--remote=false']:
        return 'unknown'
    a = args[1:]
    if a == ['info', '--format', 'json']:
        return 'info'
    for prefix, kind, digest in [(['image', 'inspect'], 'image-inspect', DIGEST),
            (['container', 'inspect'], 'container-inspect', HEX),
            (['container', 'rm'], 'remove-transient', HEX), (['start'], 'start-owned', HEX),
            (['stop', '--time', '30'], 'stop-owned', HEX)]:
        if len(a) == len(prefix)+1 and a[:-1] == prefix and digest.fullmatch(a[-1]):
            return kind
    for prefix in [['ps', '--all', '--no-trunc', '--filter'], ['ps', '--no-trunc', '--filter']]:
        if len(a) == len(prefix)+3 and a[:len(prefix)] == prefix and a[-2:] == ['--format', '{{.ID}}']:
            label = a[len(prefix)]
            if label.startswith('label=io.vault.installation=') and UUID.fullmatch(label.removeprefix('label=io.vault.installation=')):
                return 'list-owned'
    if len(a) == 19 and a[:13] == ['run', '--pull=never', '--rm', '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--userns', 'keep-id', '--user'] and \
            USER.fullmatch(a[13]) and a[14:16] == ['--entrypoint', 'node'] and DIGEST.fullmatch(a[16]) and \
            a[17] == '-e' and hashlib.sha256(a[18].encode(errors='surrogateescape')).hexdigest() == PROBE_SHA:
        return 'image-probe'
    for role, tail in [('web', ['scripts/start-production.mjs']),
            ('migration', ['--conditions=react-server', '--import', 'tsx', 'web/scripts/migrate.ts']),
            ('watcher', ['--conditions=react-server', '--import', 'tsx', 'web/scripts/watch-chain.ts'])]:
        if len(a) < 43 or a[:3] != ['run', '--pull=never', '--name'] or not a[-len(tail):] == tail:
            continue
        if not re.fullmatch('presigned-'+role+r'-[0-9a-f]{32}-[0-9a-f]{12}', a[3]):
            continue
        if a[4:5] != ['--label'] or a[6:7] != ['--label'] or a[8:9] != ['--label'] or a[10:11] != ['--label']:
            continue
        labels = [a[i] for i in [5, 7, 9, 11]]
        if not all(labels[i].startswith('io.vault.'+key+'=') and check.fullmatch(labels[i].split('=', 1)[1])
                for i, key, check in [(0, 'installation', UUID), (1, 'release', UUID), (2, 'plan', HEX), (3, 'environment', HEX)]):
            continue
        if a[3] != 'presigned-'+role+'-'+labels[0].split('=')[1].replace('-', '')+'-'+labels[1].split('=')[1].replace('-', '')[:12]:
            continue
        fixed = ['--label', 'io.vault.role='+role, '--network', 'host', '--read-only', '--read-only-tmpfs=false',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--userns', 'keep-id', '--user']
        if a[12:25] != fixed or not USER.fullmatch(a[25]):
            continue
        fixed = ['--pids-limit', '256', '--memory', '1g', '--cpus', '2',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/run:rw,noexec,nosuid,size=16m', '--mount']
        if a[26:37] != fixed:
            continue
        mount = a[37].split(',')
        if len(mount) != 4 or mount[0] != 'type=bind' or mount[3] != 'ro' or not mount[1].startswith('source=/') or \
                not mount[2].startswith('destination=/') or mount[1][7:] != mount[2][12:]:
            continue
        if a[38:40] != ['--log-driver', 'none']:
            continue
        i = 40
        keys = []
        while a[i:i+1] == ['--env'] and i+1 < len(a):
            keys.append(a[i+1]); i += 2
        if keys != sorted(set(keys)) or not all(re.fullmatch(r'[A-Z][A-Z0-9_]*', key) for key in keys):
            continue
        if a[i:i+3] != [('--detach' if role == 'web' else '--rm'), '--entrypoint', 'node']:
            continue
        if i+4 > len(a) or not DIGEST.fullmatch(a[i+3]) or a[i+4:] != tail:
            continue
        return 'run-'+role
    return 'unknown'


def classifications(stderr):
    if not isinstance(stderr, bytes) or len(stderr) > DIAGNOSTIC_LIMIT:
        return []
    # No interpolated capture groups, raw lines or error messages are returned.
    lines = [line for line in stderr.decode('utf8', errors='replace').splitlines()
             if len(line) <= 2048 and not any(ord(c) < 32 for c in line)]
    return [kind for kind, pattern in CLASSIFICATIONS.items()
            if any(re.search(pattern, line, re.I) for line in lines)][:8]


def terminal(returncode):
    if type(returncode) is not int or returncode < -64 or returncode > 255:
        raise ValueError('unrecognized native terminal')
    if returncode >= 0:
        return {'nativeClosed': True, 'exitCode': returncode, 'signal': None}
    return {'nativeClosed': True, 'exitCode': None, 'signal': signal.Signals(-returncode).name}


def signal_exit_plan(returncode):
    if type(returncode) is not int or returncode >= 0 or returncode < -64:
        raise ValueError('not a signaled native terminal')
    sig = -returncode
    return {'signal': sig, 'restoreDefault': sig not in [signal.SIGKILL, signal.SIGSTOP]}


def forwarding_environment(inherited, original_path):
    result = dict(inherited)
    result['PATH'] = original_path
    return result


def forward_bytes(destination, data, writer=os.write):
    remaining = data
    while remaining:
        count = writer(destination, remaining)
        if type(count) is not int or not 0 < count <= len(remaining):
            raise OSError('byte forwarding failed')
        remaining = remaining[count:]


def private_dir(path):
    s = os.lstat(path)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700 or os.path.realpath(path) != path:
        raise ValueError('private directory refused')


def private_json(path, maximum=8192):
    private_dir(os.path.dirname(path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o600 or not 0 < s.st_size <= maximum:
            raise ValueError('private file refused')
        data = os.read(fd, maximum+1)
        after = os.fstat(fd)
        if (s.st_size, s.st_mtime_ns, s.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != s.st_size:
            raise ValueError('private read changed')
        return json.loads(data)
    finally:
        os.close(fd)


def write_record(directory, name, record):
    private_dir(directory)
    fd = os.open(directory+'/'+name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        data = (json.dumps(record, separators=(',', ':'))+'\n').encode()
        while data:
            data = data[os.write(fd, data):]
        os.fsync(fd)
    finally:
        os.close(fd)


def run_passthrough(args):
    started = time.monotonic_ns()
    private_dir(os.path.dirname(os.path.realpath(__file__)))
    config = private_json(os.path.dirname(__file__)+'/diagnostic-config.json')
    if set(config) != {'version', 'realBinarySha256', 'originalPath', 'wrapperDirectory', 'diagnosticDirectory'} or config['version'] != 1:
        raise ValueError('diagnostic configuration refused')
    if not HEX.fullmatch(config['realBinarySha256']) or config['wrapperDirectory'] != os.path.dirname(__file__) or \
            os.path.realpath(__file__) != __file__ or os.environ.get('PATH') != config['wrapperDirectory']+':'+config['originalPath']:
        raise ValueError('diagnostic context refused')
    if os.path.basename(config['wrapperDirectory']) != 'podman-bin' or config['diagnosticDirectory'] != os.path.dirname(config['wrapperDirectory'])+'/podman-diagnostics':
        raise ValueError('diagnostic destination refused')
    private_dir(config['diagnosticDirectory'])
    fd = os.open('/usr/bin/podman', os.O_RDONLY | os.O_NOFOLLOW)
    pidfd = None
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o6022 or \
                os.path.realpath('/usr/bin/podman') != '/usr/bin/podman' or 'security.capability' in os.listxattr(fd):
            raise ValueError('real Podman refused')
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024*1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(fd)
        if digest.hexdigest() != config['realBinarySha256'] or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != \
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('real Podman bytes changed')
        os.lseek(fd, 0, os.SEEK_SET)
        env = forwarding_environment(os.environ, config['originalPath'])
        parent = os.getpid()
        libc = ctypes.CDLL(None, use_errno=True)
        child = None
        pending = []

        def forward(sig, _frame):
            if child is None or pidfd is None:
                pending.append(sig)
            else:
                try:
                    signal.pidfd_send_signal(pidfd, sig, None, 0)
                except ProcessLookupError:
                    pass

        def child_setup():
            # No detached group/namespace or new privilege. The stock caller's
            # uncatchable proxy kill must also kill the same genuine actor.
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
                raise OSError('parent-death binding failed')
            if os.getppid() != parent:
                os.kill(os.getpid(), signal.SIGKILL)
            # /proc/self/fd resolution uses this pinned descriptor before
            # exec; close-on-exec prevents adding an inherited native FD.
            os.set_inheritable(fd, False)

        for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT]:
            signal.signal(sig, forward)
        # Opening then execing this exact descriptor closes the pathname race.
        # stdin stays inherited, stdout/stderr retain every byte, argv0 remains
        # the stock executable token. Only the diagnostic PATH prefix is undone.
        native_started = time.monotonic_ns()
        child = subprocess.Popen(['podman', *args], executable='/proc/self/fd/'+str(fd),
            env=env, stdin=None, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=(fd,), preexec_fn=child_setup, restore_signals=True)
        # The descriptor prevents a late forwarded signal targeting a reused
        # numeric PID. It identifies only this direct genuine child.
        pidfd = os.pidfd_open(child.pid, 0)
        for sig in pending:
            forward(sig, None)
        stdout_bytes = stderr_bytes = 0
        retained = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, 1)
            selector.register(child.stderr, selectors.EVENT_READ, 2)
            while selector.get_map():
                for key, _mask in selector.select():
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj); key.fileobj.close(); continue
                    if key.data == 1:
                        stdout_bytes += len(chunk)
                    else:
                        stderr_bytes += len(chunk)
                        retained.extend(chunk[:max(0, DIAGNOSTIC_LIMIT-len(retained))])
                    forward_bytes(key.data, chunk)
        actual = child.wait()  # EOF+actual native terminal; no retries/new delay.
        elapsed_ms = (time.monotonic_ns()-native_started)//1000000
        record = {'version': 1, 'operation': operation(args), **terminal(actual),
            'elapsedMs': elapsed_ms,
            'stdoutBytes': stdout_bytes, 'stderrBytes': stderr_bytes,
            'classifications': classifications(bytes(retained)), 'realBinarySha256': config['realBinarySha256']}
        # A record is diagnostic only; its existence never substitutes for the
        # real terminal or the unchanged candidate's independent success gates.
        # Preserve the genuine terminal even if diagnostics cannot be written.
        # Missing diagnostics never establish a terminal or grant a pass: the
        # stock caller still needs actual zero and every original proof check.
        try:
            write_record(config['diagnosticDirectory'], str(started)+'-'+str(os.getpid())+'.json', record)
        except (OSError, ValueError):
            pass
        if actual < 0:
            plan = signal_exit_plan(actual)
            if plan['restoreDefault']:
                signal.signal(plan['signal'], signal.SIG_DFL)
            os.kill(os.getpid(), plan['signal'])  # actual signal, not 128+signal.
            os._exit(1)
        return actual
    finally:
        if pidfd is not None:
            os.close(pidfd)
        os.close(fd)


def self_test():
    """Pure: no Podman, child, filesystem mutations, signals or Linux calls."""
    checks = 0
    def check(value):
        nonlocal checks
        if not value:
            raise AssertionError('synthetic diagnostic boundary')
        checks += 1
    h = 'a'*64; d = 'sha256:'+h; u = '11111111-1111-1111-1111-111111111111'
    check(operation(['--remote=false', 'info', '--format', 'json']) == 'info')
    probe = """const fs=require('node:fs'),crypto=require('node:crypto');const files=fs.readdirSync('db/migrations').filter(x=>x.endsWith('.sql')).sort();
      console.log(JSON.stringify({uid:process.getuid(),build:JSON.parse(fs.readFileSync('vault-presigned-build.json','utf8')),
      utility:crypto.createHash('sha256').update(fs.readFileSync('public/offline/presigned-recovery.html')).digest('hex'),
      files:files.map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync('db/migrations/'+file)).digest('hex')}))}));"""
    probe_args = ['--remote=false', 'run', '--pull=never', '--rm', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--userns', 'keep-id', '--user',
        '1001:1001', '--entrypoint', 'node', d, '-e', probe]
    check(operation(probe_args) == 'image-probe')
    check(operation(probe_args[:-1]+['SYNTHETIC_SECRET']) == 'unknown')
    for args, kind in [(['image', 'inspect', d], 'image-inspect'),
            (['container', 'inspect', h], 'container-inspect'), (['container', 'rm', h], 'remove-transient'),
            (['start', h], 'start-owned'), (['stop', '--time', '30', h], 'stop-owned'),
            (['ps', '--all', '--no-trunc', '--filter', 'label=io.vault.installation='+u, '--format', '{{.ID}}'], 'list-owned')]:
        check(operation(['--remote=false', *args]) == kind)
        check(operation(['--remote=false', *args, 'SYNTHETIC_SECRET']) == 'unknown')
    for args in [[], ['--remote=true', 'info', '--format', 'json'], ['info', '--format', 'json'],
            ['--remote=false', 'container', 'rm', 'SYNTHETIC_SECRET'], ['--remote=false', 'run', 'SYNTHETIC_SECRET']]:
        check(operation(args) == 'unknown')
    for role, tail in [('web', ['scripts/start-production.mjs']),
            ('migration', ['--conditions=react-server', '--import', 'tsx', 'web/scripts/migrate.ts']),
            ('watcher', ['--conditions=react-server', '--import', 'tsx', 'web/scripts/watch-chain.ts'])]:
        args = ['--remote=false', 'run', '--pull=never', '--name', 'presigned-'+role+'-'+u.replace('-', '')+'-'+u.replace('-', '')[:12],
            '--label', 'io.vault.installation='+u, '--label', 'io.vault.release='+u,
            '--label', 'io.vault.plan='+h, '--label', 'io.vault.environment='+h,
            '--label', 'io.vault.role='+role, '--network', 'host', '--read-only', '--read-only-tmpfs=false',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--userns', 'keep-id', '--user', '1001:1001',
            '--pids-limit', '256', '--memory', '1g', '--cpus', '2', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
            '--tmpfs', '/run:rw,noexec,nosuid,size=16m', '--mount', 'type=bind,source=/private/synthetic,destination=/private/synthetic,ro',
            '--log-driver', 'none', '--env', 'APP_ORIGIN', '--env', 'DATABASE_URL',
            '--detach' if role == 'web' else '--rm', '--entrypoint', 'node', d, *tail]
        check(operation(args) == 'run-'+role)
        for fixed in ['--read-only', '--read-only-tmpfs=false', '--pull=never', '--log-driver', '--entrypoint']:
            altered = list(args); altered[altered.index(fixed)] = '--SYNTHETIC_SECRET'
            check(operation(altered) == 'unknown')
        check(operation(args+['SYNTHETIC_SECRET']) == 'unknown')
    secret = b'SYNTHETIC_SECRET_NEVER_PUBLIC'
    for phrase, kind in [(b'cannot clone: Operation not permitted', 'usernamespace-clone-denied'),
            (b'newuidmap: write to uid_map failed: Operation not permitted', 'uid-map-denied'),
            (b'newgidmap: Permission denied', 'gid-map-denied'), (b'no subuid ranges', 'subordinate-ids-missing'),
            (b'cgroup creation: Permission denied', 'cgroup-denied'), (b'setrlimit RLIMIT_NOFILE: Operation not permitted', 'resource-limit-denied'),
            (b'mount failed: Permission denied', 'mount-denied'), (b'seccomp: Operation not permitted', 'seccomp-denied'),
            (b'AppArmor denied', 'confinement-denied'), (b'keep-id is not supported', 'keep-id-unsupported'),
            (b'Error: unknown flag: --opaque', 'unsupported-option'), (b'OCI runtime is not available', 'oci-runtime-unavailable'),
            (b'executable file not found', 'oci-executable-missing'), (b'Read-only file system', 'filesystem-read-only'),
            (b'No space left on device', 'disk-space-exhausted'), (b'Cannot allocate memory', 'memory-allocation-failed')]:
        projected = classifications(phrase+b' '+secret+b' postgresql://synthetic:password@private.invalid/database')
        check(kind in projected)
        check(set(projected) <= set(CLASSIFICATIONS))
        check(secret not in json.dumps(projected).encode() and b'password' not in json.dumps(projected).encode())
    for text in [secret, b'{"passed":true,"token":"'+secret+b'"}', b'OCI runtime\nnot available',
            b'A'*65537, b'permission denied\0'+secret, b'Error: '+b'A'*2049+b' permission denied']:
        check(classifications(text) == [])
    check(terminal(0) == {'nativeClosed': True, 'exitCode': 0, 'signal': None})
    check(terminal(125) == {'nativeClosed': True, 'exitCode': 125, 'signal': None})
    check(terminal(-signal.SIGKILL) == {'nativeClosed': True, 'exitCode': None, 'signal': 'SIGKILL'})
    check(terminal(-signal.SIGTERM) == {'nativeClosed': True, 'exitCode': None, 'signal': 'SIGTERM'})
    check(signal_exit_plan(-signal.SIGKILL) == {'signal': signal.SIGKILL, 'restoreDefault': False})
    check(signal_exit_plan(-signal.SIGTERM) == {'signal': signal.SIGTERM, 'restoreDefault': True})
    inherited = {'PATH': '/private/synthetic/podman-bin:/usr/bin', 'TOKEN': secret.decode(),
        'DATABASE_URL': secret.decode(), 'PRESIGNED_V2_BROADCAST_NETWORK': 'signet'}
    forwarded = forwarding_environment(inherited, '/usr/bin')
    check(forwarded == {**inherited, 'PATH': '/usr/bin'})
    check(inherited['PATH'] == '/private/synthetic/podman-bin:/usr/bin')
    raw = b'\x00\xff\xfe' + secret + b'\r\n'
    for destination in [1, 2]:
        delivered = bytearray()
        def partial_write(fd, data):
            check(fd == destination)
            n = min(7, len(data)); delivered.extend(data[:n]); return n
        forward_bytes(destination, raw, partial_write)
        check(bytes(delivered) == raw)
    for value in [True, None, '0', 256, -65]:
        try:
            terminal(value)
        except (ValueError, TypeError):
            checks += 1
        else:
            raise AssertionError('synthetic invalid terminal accepted')
    print(json.dumps({'passed': True, 'kind': 'pure-podman-diagnostic-boundaries', 'checks': checks, 'nativeCommandsExecuted': 0}))


if __name__ == '__main__':
    if os.path.basename(__file__) == 'podman':
        try:
            os._exit(run_passthrough(sys.argv[1:]))
        except BaseException:
            # Never print arbitrary wrapper/native exceptions or infer success
            # when an actual terminal/diagnostic record could not be observed.
            os._exit(1)
    elif sys.argv[1:] == ['--self-test-pure']:
        self_test()
    else:
        raise SystemExit(1)
