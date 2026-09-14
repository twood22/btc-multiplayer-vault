/** Fail-closed private deployment policy. Only reads reviewed migration bytes. */
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { databaseEndpointFingerprint } from '../../src/database-restore-receipt.js';
import { assertDatabaseUrl } from '../../web/lib/database-config.js';
import { EXPECTED_MIGRATION_FILES, EXPECTED_MIGRATION_VERSIONS } from '../../web/lib/migrations.js';
import { commitmentDigest, exactKeys, hexBytes, identifier, sameCanonical } from '../../src/presigned/validation.js';
import { PRESIGNED_PROTOCOL_V3 } from '../../src/presigned/types.js';

export interface DeploymentImage {
  evidenceDirectory: string; sourceDigest: string; imageManifestDigest: string; imageConfigDigest: string;
  offlineUtilityDigest: string; acceptanceReceiptPath: string; acceptanceReceiptDigest: string;
}
export interface PresignedDeploymentPlan {
  version: 1; protocol: typeof PRESIGNED_PROTOCOL_V3; kind: 'private-loopback-deployment-v1';
  installationId: string; releaseId: string; network: 'signet' | 'mainnet';
  candidate: DeploymentImage; rollback: DeploymentImage | null;
  environmentFile: string; environmentSha256: string; protectedDirectory: string; journalDirectory: string;
  databaseEndpointFingerprint: string;
  /** null is legal ONLY after an actual query proves a completely empty public schema. */
  databaseRestore: { receiptPath: string; receiptDigest: string } | null;
  migrationVersions: string[]; migrationDigest: string;
  host: '127.0.0.1'; port: number; watcherIntervalSeconds: number;
  digest: string;
}
export interface DeploymentCommand { executable: 'podman'; args: string[] }
export const DEPLOYMENT_EXECUTION_ACK = 'EXECUTE_REVIEWED_PRIVATE_DEPLOYMENT' as const;
export const DEPLOYMENT_QUIESCENCE_ACK = 'ALL_OTHER_APP_AND_WATCHER_PROCESSES_QUIESCED' as const;
const DOMAIN = 'vault/presigned-graph-v3/private-deployment';
const imageKeys = ['evidenceDirectory','sourceDigest','imageManifestDigest','imageConfigDigest','offlineUtilityDigest','acceptanceReceiptPath','acceptanceReceiptDigest'];
export function deploymentMigrationDigest() {
  return commitmentDigest(`${DOMAIN}/migrations`, EXPECTED_MIGRATION_FILES.map(file => ({ file,
    sha256: createHash('sha256').update(readFileSync(resolve('db/migrations', file))).digest('hex') })));
}
export function validateDeploymentPlan(value: unknown): PresignedDeploymentPlan {
  exactKeys(value, ['version','protocol','kind','installationId','releaseId','network','candidate','rollback','environmentFile',
    'environmentSha256','protectedDirectory','journalDirectory','databaseEndpointFingerprint','databaseRestore',
    'migrationVersions','migrationDigest','host','port','watcherIntervalSeconds','digest'], 'private deployment plan');
  const plan = value as PresignedDeploymentPlan;
  assert(plan.version === 1 && plan.protocol === PRESIGNED_PROTOCOL_V3 && plan.kind === 'private-loopback-deployment-v1');
  identifier(plan.installationId, 'installation'); identifier(plan.releaseId, 'deployment release');
  assert(plan.network === 'signet' || plan.network === 'mainnet');
  assert(plan.rollback !== undefined && plan.databaseRestore !== undefined);
  canonicalPath(plan.protectedDirectory); canonicalPath(plan.journalDirectory); canonicalPath(plan.environmentFile);
  assert(plan.protectedDirectory !== plan.journalDirectory && !plan.protectedDirectory.startsWith(`${plan.journalDirectory}/`) &&
    !plan.journalDirectory.startsWith(`${plan.protectedDirectory}/`), 'secret storage and operation journal must be separate');
  assert(dirname(plan.environmentFile) === plan.protectedDirectory, 'environment file must be in the exact protected secret directory');
  assert(!['/app','/proc','/sys','/dev','/etc','/tmp','/run','/var','/home'].includes(plan.protectedDirectory), 'secret directory is too broad or overlaps runtime internals');
  assert(!['/app','/proc','/sys','/dev','/etc'].some(prefix => plan.protectedDirectory.startsWith(`${prefix}/`)), 'secret directory overlaps executable or system paths');
  assert(plan.protectedDirectory !== process.env.HOME && !resolve('.').startsWith(`${plan.protectedDirectory}/`) &&
    ![plan.protectedDirectory,plan.journalDirectory].some(path => path === resolve('.') || path.startsWith(`${resolve('.')}/`)),
  'private deployment state must be external to the source tree, not a whole home or workspace');
  for (const image of [plan.candidate, ...(plan.rollback ? [plan.rollback] : [])]) {
    exactKeys(image, imageKeys, 'deployment image'); canonicalPath(image.evidenceDirectory); canonicalPath(image.acceptanceReceiptPath);
    assert(dirname(image.acceptanceReceiptPath) === plan.protectedDirectory, 'release receipt must be in the protected secret directory');
    for (const field of ['sourceDigest','offlineUtilityDigest','acceptanceReceiptDigest'] as const) hexBytes(image[field], 32, field);
    for (const field of ['imageManifestDigest','imageConfigDigest'] as const) assert(/^sha256:[0-9a-f]{64}$/u.test(image[field]), 'immutable OCI digest required');
  }
  for (const field of ['environmentSha256','databaseEndpointFingerprint','migrationDigest','digest'] as const) hexBytes(plan[field], 32, field);
  if (plan.databaseRestore !== null) {
    exactKeys(plan.databaseRestore, ['receiptPath','receiptDigest'], 'deployment database restoration');
    canonicalPath(plan.databaseRestore.receiptPath); hexBytes(plan.databaseRestore.receiptDigest, 32, 'restoration receipt digest');
    assert(dirname(plan.databaseRestore.receiptPath) === plan.protectedDirectory);
  }
  sameCanonical(plan.migrationVersions, [...EXPECTED_MIGRATION_VERSIONS], 'deployment migration set');
  assert(plan.migrationDigest === deploymentMigrationDigest(), 'deployment migration bytes changed');
  assert(plan.host === '127.0.0.1' && Number.isSafeInteger(plan.port) && plan.port >= 1024 && plan.port <= 65535,
    'deployment listener must be one unprivileged loopback port');
  assert(Number.isSafeInteger(plan.watcherIntervalSeconds) && plan.watcherIntervalSeconds >= 15 && plan.watcherIntervalSeconds <= 3600);
  const { digest, ...body } = plan;
  assert(commitmentDigest(DOMAIN, body) === digest, 'deployment plan digest changed');
  return plan;
}
export function createDeploymentPlan(body: Omit<PresignedDeploymentPlan, 'digest'>) {
  return validateDeploymentPlan({ ...body, digest: commitmentDigest(DOMAIN, body) });
}
export function canonicalPath(value: string) {
  assert(typeof value === 'string' && value === resolve(value) && value.length >= 8 && value.length <= 4096 &&
    !/[\x00-\x1f,:]/u.test(value), 'deployment requires a canonical absolute non-system path');
}
const allowedEnvironment = /^(?:VAULT_[A-Z0-9_]+|NEXT_PUBLIC_VAULT_NETWORK|WEBAUTHN_RP_ID|WEBAUTHN_RP_NAME|WEBAUTHN_ORIGIN|APP_ORIGIN|DATABASE_URL|DATABASE_RESTORE_RECEIPT|DATABASE_RESTORE_RECEIPT_DIGEST|BITCOIN_BACKEND|BITCOIN_RPC_URL|BITCOIN_RPC_USER|BITCOIN_RPC_USERNAME|BITCOIN_RPC_PASSWORD|BITCOIN_RPC_COOKIE_FILE|BITCOIN_RPC_TIMEOUT_MS|CHAIN_OBSERVATION_ORIGINS|PRESIGNED_CHAIN_API_URL|PRESIGNED_V[23]_(?:MAINNET_AUTHORIZATION|BROADCAST_NETWORK|ACCEPTANCE_RECEIPT|ACCEPTANCE_RECEIPT_DIGEST|FUNDING_RESTORE_RECEIPT|FUNDING_RESTORE_RECEIPT_DIGEST|RELEASE_REPORT|RELEASE_REPORT_DIGEST)|PRIVATE_BETA_MAX_DEPOSIT_SATS|DEPLOYED_IMAGE_MANIFEST_DIGEST)$/u;
/** Never return or log this map. Child arguments carry variable NAMES only. */
export function validateDeploymentEnvironment(plan: PresignedDeploymentPlan, environment: Record<string, string>) {
  assert(Object.keys(environment).length <= 80 && Object.keys(environment).every(key => allowedEnvironment.test(key)), 'unreviewed execution environment key');
  assert(environment.VAULT_NETWORK === plan.network && environment.NEXT_PUBLIC_VAULT_NETWORK === plan.network, 'deployment environment changed network');
  const database = assertDatabaseUrl(environment.DATABASE_URL, { production: true });
  assert(databaseEndpointFingerprint(database) === plan.databaseEndpointFingerprint, 'deployment environment changed database');
  const origin = new URL(environment.APP_ORIGIN!); const webauthn = new URL(environment.WEBAUTHN_ORIGIN!);
  assert(origin.origin === webauthn.origin && origin.href === `${origin.origin}/` && !origin.username && !origin.password &&
    (origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname)), 'invalid deployment application origin');
  const rp = environment.WEBAUTHN_RP_ID;
  assert(rp && (origin.hostname === rp || origin.hostname.endsWith(`.${rp}`)), 'deployment passkey RP differs');
  assert(environment.BITCOIN_BACKEND === 'core', 'deployment requires private Core');
  const rpc = new URL(environment.BITCOIN_RPC_URL!);
  assert(!rpc.username && !rpc.password && !rpc.hash && !rpc.search &&
    (rpc.protocol === 'https:' || rpc.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(rpc.hostname)), 'private Core transport is unsafe');
  const cookie = environment.BITCOIN_RPC_COOKIE_FILE;
  assert(!(environment.BITCOIN_RPC_USER && environment.BITCOIN_RPC_USERNAME), 'ambiguous Core identity');
  assert(cookie ? !environment.BITCOIN_RPC_USERNAME && !environment.BITCOIN_RPC_USER && !environment.BITCOIN_RPC_PASSWORD
    : Boolean((environment.BITCOIN_RPC_USERNAME || environment.BITCOIN_RPC_USER) && environment.BITCOIN_RPC_PASSWORD), 'Core needs exactly one protected authentication mechanism');
  if (cookie) { canonicalPath(cookie); assert(dirname(cookie) === plan.protectedDirectory, 'Core cookie escaped the protected directory'); }
  for (const [key, value] of Object.entries(environment)) {
    assert(typeof value === 'string' && value.length <= 8192 && !value.includes('\0'), 'invalid environment value');
    if (key.endsWith('_RECEIPT') || key.endsWith('_REPORT')) { canonicalPath(value); assert(dirname(value) === plan.protectedDirectory, 'runtime evidence escaped protected directory'); }
  }
  assert(environment.VAULT_DEMO_SEED === undefined, 'demo custody is not a deployment input');
  assert(environment.PRESIGNED_V2_BROADCAST_NETWORK === undefined || environment.PRESIGNED_V2_BROADCAST_NETWORK === plan.network,
    'broadcast opt-in belongs to another network');
  assert(environment.PRESIGNED_V3_BROADCAST_NETWORK === undefined, 'broadcast network uses the single shared reviewed switch');
  return environment;
}
export function deploymentContainerName(plan: PresignedDeploymentPlan, role: 'web' | 'watcher' | 'migration') {
  return `presigned-${role}-${plan.installationId.replaceAll('-','')}-${plan.releaseId.replaceAll('-','').slice(0,12)}`;
}
export function deploymentRuntimeEnvironment(plan: PresignedDeploymentPlan, image: DeploymentImage, environment: Record<string,string>) {
  return { ...environment, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: String(plan.port),
    VAULT_NETWORK: plan.network, NEXT_PUBLIC_VAULT_NETWORK: plan.network,
    PRESIGNED_V2_ACCEPTANCE_RECEIPT: image.acceptanceReceiptPath,
    PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST: image.acceptanceReceiptDigest,
    DEPLOYED_IMAGE_MANIFEST_DIGEST: image.imageManifestDigest };
}
export function deploymentRunCommand(plan: PresignedDeploymentPlan, role: 'web' | 'watcher' | 'migration', environmentKeys: string[], uid: number, gid: number): DeploymentCommand {
  validateDeploymentPlan(plan); assert(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid >= 0, 'root deployment is prohibited');
  assert(new Set(environmentKeys).size === environmentKeys.length && environmentKeys.every(key => /^[A-Z][A-Z0-9_]*$/u.test(key)));
  const args = ['run','--pull=never','--name',deploymentContainerName(plan,role),'--label',`io.vault.installation=${plan.installationId}`,
    '--label',`io.vault.release=${plan.releaseId}`,'--label',`io.vault.plan=${plan.digest}`,'--label',`io.vault.environment=${plan.environmentSha256}`,
    '--label',`io.vault.role=${role}`,'--network','host','--read-only','--read-only-tmpfs=false','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--userns','keep-id','--user',`${uid}:${gid}`,'--pids-limit','256','--memory','1g','--cpus','2',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--tmpfs','/run:rw,noexec,nosuid,size=16m',
    '--mount',`type=bind,source=${plan.protectedDirectory},destination=${plan.protectedDirectory},ro`,
    '--log-driver','none', ...[...environmentKeys].sort().flatMap(key => ['--env',key]),
    ...(role === 'web' ? ['--detach'] : ['--rm']), '--entrypoint','node', plan.candidate.imageConfigDigest];
  args.push(...(role === 'web' ? ['scripts/start-production.mjs'] : ['--conditions=react-server','--import','tsx',
    role === 'watcher' ? 'web/scripts/watch-chain.ts' : 'web/scripts/migrate.ts']));
  return { executable: 'podman', args };
}

export function validateDeploymentDatabaseIdentity(plan: PresignedDeploymentPlan, savedIdentity: string,
  current: { fingerprint:string; migrationVersions:string[] }) {
  hexBytes(savedIdentity,32,'journaled database identity');
  exactKeys(current,['fingerprint','migrationVersions'],'current deployment database identity');
  assert(current.fingerprint===savedIdentity,'database instance changed after the durable deployment record');
  sameCanonical(current.migrationVersions,plan.migrationVersions,'exact deployed migration set');
}

/** Podman derives CapDrop from host defaults, not the literal ALL token; its
 * effective/bounding OCI sets establish the actual zero-capability contract.
 * UsernsMode is normalized to private or a namespace path, so the recorded
 * keep-id command is additionally checked against live kernel UID/GID maps.
 * Source: upstream libpod/container_inspect{,_linux}.go (Podman inspect API). */
export function validateDeploymentContainerHardening(actual: any) {
  const host=actual?.HostConfig;
  assert(host && (actual.EffectiveCaps===null || Array.isArray(actual.EffectiveCaps) && actual.EffectiveCaps.length===0) &&
    (actual.BoundingCaps===null || Array.isArray(actual.BoundingCaps) && actual.BoundingCaps.length===0) && Array.isArray(host.CapAdd) && host.CapAdd.length===0 &&
    Array.isArray(host.CapDrop) && host.CapDrop.every((cap:unknown)=>typeof cap==='string' && /^CAP_[A-Z0-9_]+$/u.test(cap)),
  'retained container has executable or bounding capabilities');
  assert(Array.isArray(host.SecurityOpt) && host.SecurityOpt.includes('no-new-privileges') &&
    !host.SecurityOpt.some((option:unknown)=>typeof option!=='string' || /unconfined|unmask=all|label=disable/u.test(option)),
  'retained container removed no-new-privileges or disabled its confinement');
  assert(host.UsernsMode==='private' || typeof host.UsernsMode==='string' && /^ns:\/proc\/\d+\/ns\/user$/u.test(host.UsernsMode),
    'retained container does not use a separate user namespace');
  assert(host.PidsLimit===256 && host.Memory===1073741824 && host.CpuPeriod===100000 && host.CpuQuota===200000 && host.NanoCpus===2000000000 &&
    host.LogConfig?.Type==='none','retained process, memory, CPU or no-log limits changed');
  const command:string[]=actual.Config?.CreateCommand;
  assert(Array.isArray(command) && command.every((arg:unknown)=>typeof arg==='string'));
  for(const [option,value] of [['--userns','keep-id'],['--cap-drop','ALL'],['--security-opt','no-new-privileges'],['--log-driver','none']]) {
    const positions:number[]=command.flatMap((arg:string,index:number)=>arg===option?[index]:[]);
    assert(positions.length===1 && command[positions[0]!+1]===value,'retained container creation changed its explicit hardening');
  }
  assert(command.includes('--read-only-tmpfs=false'),'automatic unbounded writable temporary mounts are forbidden');
  exactKeys(host.Tmpfs,['/tmp','/run'],'bounded deployment temporary mounts');
  for(const [path,limit] of [['/tmp',67108864],['/run',16777216]] as const) {
    const options=String(host.Tmpfs[path]).split(',');
    assert(options.includes('rw') && options.includes('noexec') && options.includes('nosuid') &&
      !options.some(option=>['exec','suid','ro'].includes(option)),'deployment temporary mount lost its restrictions');
    const sizes=options.filter(option=>option.startsWith('size=')); assert(sizes.length===1);
    const match=/^size=(\d+)([kmg]?)$/iu.exec(sizes[0]!);
    assert(match && Number(match[1])*({k:1024,m:1048576,g:1073741824}[match[2]!.toLowerCase()]??1)===limit,
      'deployment temporary memory budget changed');
  }
}

export function validateDeploymentProcessPrivileges(input: {status:string;uidMap:string;gidMap:string;userNamespace:string;hostUserNamespace:string}, uid:number, gid:number) {
  assert(Number.isSafeInteger(uid) && uid>0 && Number.isSafeInteger(gid) && gid>=0);
  exactKeys(input,['status','uidMap','gidMap','userNamespace','hostUserNamespace'],'actual running privilege observations');
  assert(/^NoNewPrivs:\s+1$/mu.test(input.status),'running container lost no-new-privileges');
  for(const name of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert(new RegExp(`^${name}:\\s+0+$`,'mu').test(input.status),
    'running container retained a kernel capability');
  assert(/^user:\[\d+\]$/u.test(input.userNamespace) && /^user:\[\d+\]$/u.test(input.hostUserNamespace) &&
    input.userNamespace!==input.hostUserNamespace,'running container shares or lacks a known host user namespace');
  for(const [kind,owner] of [['uid',uid],['gid',gid]] as const) {
    assert(new RegExp(`^${kind==='uid'?'Uid':'Gid'}:\\s+${owner}\\s+${owner}\\s+${owner}\\s+${owner}$`,'mu').test(input.status),
      'running process has an unreviewed real/effective/saved/filesystem identity');
    const mappings=input[kind==='uid'?'uidMap':'gidMap'].trim().split('\n').map(line=>line.trim().split(/\s+/u).map(Number));
    assert(mappings.length>0 && mappings.length<=340 && mappings.every(row=>row.length===3 && row.every(value=>Number.isSafeInteger(value)&&value>=0) && row[2]!>0));
    const applicable=mappings.filter(([start,,size])=>owner>=start! && owner<start!+size!);
    assert(applicable.length===1 && applicable[0]![1]!+(owner-applicable[0]![0]!)===owner,
      'running user namespace does not preserve the reviewed non-root owner');
  }
}
