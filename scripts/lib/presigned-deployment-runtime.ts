/** Explicit private installation only. This module never loads operational dotenv
 * implicitly, pulls images, changes host policy, or publishes a listener. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { validatePresignedAcceptanceReceipt } from '../../src/presigned/release.js';
import { validateDatabaseRestoreReceipt, type DatabaseRestoreReceipt } from '../../src/database-restore-receipt.js';
import { captureDatabaseRuntimeIdentity, captureDatabaseSnapshot } from '../../web/lib/database-snapshot.js';
import { commitmentDigest, exactKeys, sameCanonical } from '../../src/presigned/validation.js';
import { presignedSourceDigest } from '../presigned-build-identity.mjs';
import { validateRetainedImageEvidence } from './presigned-image-evidence.js';
import { verifyOciDirectory } from './presigned-oci.js';
import { acquireLifecycleProcessLock } from './presigned-lifecycle-lock.js';
import { privateJournalDirectory, readPrivateJournalBytes, writePrivateJournalBytes } from './presigned-durable-journal.js';
import { DEPLOYMENT_EXECUTION_ACK, DEPLOYMENT_QUIESCENCE_ACK, deploymentContainerName, deploymentRunCommand,
  deploymentRuntimeEnvironment, validateDeploymentEnvironment, validateDeploymentPlan,
  validateDeploymentDatabaseIdentity, validateDeploymentContainerHardening, validateDeploymentProcessPrivileges,
  type DeploymentImage, type PresignedDeploymentPlan } from './presigned-deployment-plan.js';

const DOMAIN = 'vault/presigned-graph-v3/private-deployment-journal';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const containerId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
export interface DeploymentJournalEntry {
  version: 1; installationId: string; sequence: number; previousDigest: string | null;
  planDigest: string; releaseId: string; operation: 'install' | 'rollback';
  phase: 'prepared' | 'quiesced' | 'database-verified' | 'migrated' | 'running' | 'healthy';
  candidateContainerId: string | null; previousContainerId: string | null; activeContainerId: string | null;
  databaseIdentity: string | null; createdAt: string; digest: string;
}
/** Appended under the stable installation flock; no secrets or raw DB rows. */
export function readDeploymentJournal(plan: PresignedDeploymentPlan): DeploymentJournalEntry[] {
  privateJournalDirectory(plan.journalDirectory, false);
  const names = readdirSync(plan.journalDirectory).filter(name => name !== 'active.lock');
  assert(names.length <= 10000 && names.every(name => /^\d{8}-[0-9a-f]{64}\.json$/u.test(name)),
    'deployment journal has an interrupted or unrecognized file; preserve it for recovery');
  const entries: DeploymentJournalEntry[] = [];
  for (const name of names.sort()) {
    const entry = JSON.parse(readPrivateJournalBytes(`${plan.journalDirectory}/${name}`, 8192).toString()) as DeploymentJournalEntry;
    exactKeys(entry, ['version','installationId','sequence','previousDigest','planDigest','releaseId','operation','phase',
      'candidateContainerId','previousContainerId','activeContainerId','databaseIdentity','createdAt','digest'], 'deployment journal entry');
    const { digest, ...body } = entry;
    assert(entry.version === 1 && entry.installationId === plan.installationId && entry.sequence === entries.length + 1 &&
      entry.previousDigest === (entries.at(-1)?.digest ?? null) && /^[0-9a-f]{64}$/u.test(entry.planDigest) &&
      /^[0-9a-f-]{36}$/u.test(entry.releaseId) && ['install','rollback'].includes(entry.operation) &&
      ['prepared','quiesced','database-verified','migrated','running','healthy'].includes(entry.phase) &&
      Number.isFinite(Date.parse(entry.createdAt)) && (entry.databaseIdentity === null || /^[0-9a-f]{64}$/u.test(entry.databaseIdentity)) &&
      [entry.candidateContainerId,entry.previousContainerId,entry.activeContainerId].every(id => id === null || containerId(id)) &&
      digest === commitmentDigest(DOMAIN, body) && name === `${String(entry.sequence).padStart(8,'0')}-${digest}.json`,
    'deployment journal chain or identity changed');
    entries.push(entry);
  }
  return entries;
}
export function appendDeploymentJournal(plan: PresignedDeploymentPlan, previous: DeploymentJournalEntry[],
  value: Pick<DeploymentJournalEntry, 'operation' | 'phase' | 'candidateContainerId' | 'previousContainerId' | 'activeContainerId' | 'databaseIdentity'>) {
  // Refuse a caller using a stale in-memory head even if it forgot its lock.
  sameCanonical(readDeploymentJournal(plan), previous, 'deployment journal head');
  const body = { version: 1 as const, installationId: plan.installationId, sequence: previous.length + 1,
    previousDigest: previous.at(-1)?.digest ?? null, planDigest: plan.digest, releaseId: plan.releaseId,
    ...value, createdAt: new Date().toISOString() };
  const entry = { ...body, digest: commitmentDigest(DOMAIN, body) };
  writePrivateJournalBytes(`${plan.journalDirectory}/${String(entry.sequence).padStart(8,'0')}-${entry.digest}.json`,
    Buffer.from(`${JSON.stringify(entry)}\n`));
  previous.push(entry); return entry;
}
/** Read-only secret-file checks happen before any external process or service. */
export function readDeploymentEnvironment(plan: PresignedDeploymentPlan) {
  privateJournalDirectory(plan.protectedDirectory, false);
  const bytes = readPrivateJournalBytes(plan.environmentFile, 64 * 1024);
  assert(sha256(bytes) === plan.environmentSha256, 'private environment changed after review');
  const parsed = parseEnv(bytes.toString());
  assert(Object.values(parsed).every(value => typeof value === 'string'));
  const environment = validateDeploymentEnvironment(plan, parsed as Record<string,string>);
  // Every file that the image can consume must remain owner-only and bounded.
  for (const [key, path] of Object.entries(environment)) if (key.endsWith('_RECEIPT') || key.endsWith('_REPORT') || key === 'BITCOIN_RPC_COOKIE_FILE')
    readPrivateJournalBytes(path, 4 * 1024 * 1024);
  return environment;
}
async function verifyImage(plan: PresignedDeploymentPlan, image: DeploymentImage) {
  const receipt = validatePresignedAcceptanceReceipt(JSON.parse(readPrivateJournalBytes(image.acceptanceReceiptPath).toString()));
  assert(receipt.protocol === plan.protocol && receipt.version === 3 && receipt.receiptDigest === image.acceptanceReceiptDigest &&
    receipt.sourceDigest === image.sourceDigest && receipt.testedImageManifestDigest === image.imageManifestDigest &&
    receipt.offlineUtilityDigest === image.offlineUtilityDigest, 'deployment release receipt differs from reviewed artifact pins');
  const evidence = await validateRetainedImageEvidence(image.evidenceDirectory, image.sourceDigest, plan.network, plan.protocol);
  const oci = await verifyOciDirectory(`${image.evidenceDirectory}/oci`);
  assert(evidence.testedImageManifestDigest === image.imageManifestDigest && evidence.offlineUtilityDigest === image.offlineUtilityDigest &&
    oci.configDigest === image.imageConfigDigest, 'deployment image evidence differs from reviewed immutable image');
}
function restoreReceipt(plan: PresignedDeploymentPlan, requireFresh: boolean) {
  if (!plan.databaseRestore) return null;
  const receipt = validateDatabaseRestoreReceipt(JSON.parse(readPrivateJournalBytes(plan.databaseRestore.receiptPath).toString()));
  assert(receipt.receiptDigest === plan.databaseRestore.receiptDigest && receipt.sourceEndpointFingerprint === plan.databaseEndpointFingerprint,
    'native restoration proof belongs to another database or review');
  const age = Date.now() - Date.parse(receipt.createdAt);
  assert(!requireFresh || age >= 0 && age <= 86400000, 'native restoration proof must be no more than one day old');
  return receipt;
}
export async function verifyDeploymentPackage(value: unknown) {
  const plan = validateDeploymentPlan(value);
  assert(plan.candidate.sourceDigest === presignedSourceDigest(), 'deployment package source differs from the candidate review');
  readDeploymentEnvironment(plan); restoreReceipt(plan, false);
  await verifyImage(plan, plan.candidate);
  if (plan.rollback) await verifyImage(plan, plan.rollback);
  return { verified: true, mode: 'read-only-package-verification', planDigest: plan.digest,
    protocol: plan.protocol, network: plan.network, imageManifestDigest: plan.candidate.imageManifestDigest,
    databaseAccessed: false, containerRuntimeAccessed: false, deployed: false, fundingAuthorized: false } as const;
}
function hostEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // In particular no NODE_OPTIONS, loader, proxy, remote-container endpoint,
  // LD_PRELOAD, or operational dotenv configuration survives.
  for (const key of ['PATH','HOME','LANG','LC_ALL','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME'])
    if (process.env[key] !== undefined) result[key] = process.env[key];
  return result;
}
function podman(args: string[], environment: Record<string,string> = {}, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('podman', ['--remote=false', ...args], { env: { ...hostEnvironment(), ...environment }, stdio: ['ignore','pipe','pipe'] });
    let output = ''; let failed = false; let size = 0;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 8 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); } else output += bytes.toString(); });
    // Consume but never log stderr: a driver or server can include credentials.
    child.stderr.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 8 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('local rootless Podman is unavailable; no host-policy fallback is allowed')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0 && !failed) resolve(output.trim());
      else reject(new Error('private container operation failed; details suppressed to protect credentials; retained containers and journal were not deleted')); });
  });
}
async function runtimePreflight(plan: PresignedDeploymentPlan) {
  const uid = process.getuid?.(); const gid = process.getgid?.();
  assert(uid && gid !== undefined, 'deployment must run as an unprivileged local owner');
  const info = JSON.parse(await podman(['info','--format','json']));
  assert(info.host?.security?.rootless === true, 'rootless Podman is mandatory');
  // No secrets or network are exposed to this immutable image identity probe.
  for (const image of [plan.candidate, ...(plan.rollback ? [plan.rollback] : [])]) {
    const inspected = JSON.parse(await podman(['image','inspect',image.imageConfigDigest]));
    assert(Array.isArray(inspected) && inspected.length === 1 &&
      `sha256:${String(inspected[0].Id).replace(/^sha256:/u,'')}` === image.imageConfigDigest, 'reviewed image is not locally retained');
    const program = `const fs=require('node:fs'),crypto=require('node:crypto');const files=fs.readdirSync('db/migrations').filter(x=>x.endsWith('.sql')).sort();
      console.log(JSON.stringify({uid:process.getuid(),build:JSON.parse(fs.readFileSync('vault-presigned-build.json','utf8')),
      utility:crypto.createHash('sha256').update(fs.readFileSync('public/offline/presigned-recovery.html')).digest('hex'),
      files:files.map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync('db/migrations/'+file)).digest('hex')}))}));`;
    const identity = JSON.parse(await podman(['run','--pull=never','--rm','--network','none','--read-only','--cap-drop','ALL',
      '--security-opt','no-new-privileges','--userns','keep-id','--user',`${uid}:${gid}`,'--entrypoint','node',image.imageConfigDigest,'-e',program]));
    assert(identity.uid === uid && identity.build?.version === 3 && identity.build.protocol === plan.protocol &&
      identity.build.network === plan.network && identity.build.sourceDigest === image.sourceDigest && identity.utility === image.offlineUtilityDigest &&
      commitmentDigest('vault/presigned-graph-v3/private-deployment/migrations', identity.files) === plan.migrationDigest,
    'retained image is not the reviewed V3 network, utility, and forward/rollback-compatible schema');
  }
  return { uid, gid };
}
async function inspectContainer(id: string, plan: PresignedDeploymentPlan, image: DeploymentImage, exactPlan?: string) {
  assert(containerId(id), 'container target must be an exact retained ID');
  const result = JSON.parse(await podman(['container','inspect',id]));
  assert(Array.isArray(result) && result.length === 1);
  const actual = result[0]; const labels = actual.Config?.Labels;
  assert(actual.Id === id && `sha256:${String(actual.Image).replace(/^sha256:/u,'')}` === image.imageConfigDigest &&
    labels?.['io.vault.installation'] === plan.installationId && labels['io.vault.role'] === 'web' &&
    labels['io.vault.environment'] === plan.environmentSha256 && (!exactPlan || labels['io.vault.plan'] === exactPlan),
  'retained container identity, ownership, image, or secret-file review changed');
  assert(actual.HostConfig?.ReadonlyRootfs === true && actual.HostConfig.NetworkMode === 'host' &&
    actual.HostConfig.Privileged === false && actual.Config.User === `${process.getuid!()}:${process.getgid!()}` &&
    actual.Config.Env?.includes('HOSTNAME=127.0.0.1') && actual.Config.Env.includes(`PORT=${plan.port}`), 'retained runtime is not the hardened loopback deployment');
  validateDeploymentContainerHardening(actual);
  if(actual.State?.Running) validateRunningPrivileges(actual.State.Pid);
  // Podman 4 serializes the entrypoint as a string; current releases use an
  // array. Both must mean exactly the same single reviewed executable.
  sameCanonical(typeof actual.Config.Entrypoint==='string' ? [actual.Config.Entrypoint] : actual.Config.Entrypoint,['node'],'retained application entrypoint');
  sameCanonical(actual.Config.Cmd,['scripts/start-production.mjs'],'retained application command');
  assert(actual.Path==='node'); sameCanonical(actual.Args,['scripts/start-production.mjs'],'actual retained process arguments');
  assert(Array.isArray(actual.Mounts) && actual.Mounts.some((mount:any) => mount.Type === 'bind' && mount.Source === plan.protectedDirectory &&
    mount.Destination === plan.protectedDirectory && mount.RW === false) && actual.Mounts.every((mount:any) =>
    mount.Type === 'tmpfs' && ['/tmp','/run'].includes(mount.Destination) || mount.Type === 'bind' && mount.Source === plan.protectedDirectory &&
    mount.Destination === plan.protectedDirectory && mount.RW === false), 'retained application mount escaped the protected read-only inputs');
  const expected = deploymentRuntimeEnvironment(plan,image,readDeploymentEnvironment(plan));
  assert(Object.entries(expected).every(([key,value]) => actual.Config.Env.filter((entry:string) => entry.startsWith(`${key}=`)).length === 1 &&
    actual.Config.Env.includes(`${key}=${value}`)), 'retained application environment differs from the exact private review');
  assert(actual.Config.Env.every((entry:string) => {
    const key=entry.slice(0,entry.indexOf('='));
    return !/^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|BTC_VAULT|DATABASE|BITCOIN|VAULT|WEBAUTHN|APP_ORIGIN|PRESIGNED|NEXT_PUBLIC|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/u.test(key) || key in expected;
  }), 'retained application added an unreviewed runtime override');
  return actual;
}
function validateRunningPrivileges(pid:unknown) {
  assert(typeof pid==='number' && Number.isSafeInteger(pid) && pid>1);
  validateDeploymentProcessPrivileges({status:readFileSync(`/proc/${pid}/status`,'utf8'),uidMap:readFileSync(`/proc/${pid}/uid_map`,'utf8'),
    gidMap:readFileSync(`/proc/${pid}/gid_map`,'utf8'),userNamespace:readlinkSync(`/proc/${pid}/ns/user`),hostUserNamespace:readlinkSync('/proc/self/ns/user')},
  process.getuid!(),process.getgid!());
}
async function deploymentContainers(plan: PresignedDeploymentPlan) {
  const output = await podman(['ps','--all','--no-trunc','--filter',`label=io.vault.installation=${plan.installationId}`,'--format','{{.ID}}']);
  const ids = output ? output.split('\n') : []; assert(ids.every(containerId)); return ids;
}
async function runTransient(plan: PresignedDeploymentPlan, role: 'migration' | 'watcher', variables: Record<string,string>,
  runtime: { uid:number; gid:number }, image = plan.candidate) {
  // A killed Podman client can leave its stopped --rm container. Remove only
  // this exact disposable, non-web container, which has no writable disk mount.
  for (const id of await deploymentContainers(plan)) {
    const item = JSON.parse(await podman(['container','inspect',id]))[0];
    if (item.Config?.Labels?.['io.vault.plan'] !== plan.digest || item.Config.Labels['io.vault.role'] !== role) continue;
    assert(String(item.Name).replace(/^\//u,'') === deploymentContainerName(plan,role) &&
      `sha256:${String(item.Image).replace(/^sha256:/u,'')}` === image.imageConfigDigest &&
      item.Config.Labels['io.vault.environment'] === plan.environmentSha256 &&
      item.HostConfig?.ReadonlyRootfs === true && item.State?.Running === false,
    'the exact transient operation is still running or its identity changed; retain it and do not race it');
    assert(Array.isArray(item.Mounts) && item.Mounts.every((mount: any) => mount.Type === 'tmpfs' ||
      mount.Type === 'bind' && mount.Source === plan.protectedDirectory && mount.Destination === plan.protectedDirectory && mount.RW === false),
    'transient container has unexpected persistent writable data; it must not be removed');
    await podman(['container','rm',id]);
  }
  const command = deploymentRunCommand(plan, role, Object.keys(variables), runtime.uid, runtime.gid);
  command.args[command.args.indexOf(plan.candidate.imageConfigDigest)] = image.imageConfigDigest;
  await podman(command.args, variables, 600000);
}
async function readiness(plan: PresignedDeploymentPlan): Promise<boolean> {
  return new Promise(resolve => {
    let result = ''; let done = false;
    const finish = (value: boolean) => { if (!done) { done = true; resolve(value); } };
    const req = request({ hostname:'127.0.0.1', port:plan.port, path:'/api/health/ready', method:'GET', timeout:3000 }, response => {
      response.on('data', chunk => { result += String(chunk); if (result.length > 8192) { req.destroy(); finish(false); } });
      response.on('end', () => { try { const body = JSON.parse(result); finish(response.statusCode === 200 && body.ok === true &&
        body.service === 'btc-multiplayer-vault' && body.check === 'operational-readiness' && body.database === 'reachable' &&
        body.migrations?.applied === plan.migrationVersions.length && body.migrations.expected === plan.migrationVersions.length && body.fundingAuthorized === false); }
      catch { finish(false); } });
    });
    req.on('error', () => finish(false)); req.on('timeout', () => { req.destroy(); finish(false); }); req.end();
  });
}
function exactOwnedListener(plan: PresignedDeploymentPlan, pid: unknown): boolean {
  assert(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1, 'retained process lacks a real host PID');
  try {
    const sockets = new Set(readdirSync(`/proc/${pid}/fd`).map(fd => {
      try { return /^socket:\[(\d+)\]$/u.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1]; } catch { return undefined; }
    }).filter(Boolean));
    const listeners = ['tcp','tcp6'].flatMap(kind => readFileSync(`/proc/${pid}/net/${kind}`,'utf8').trim().split('\n').slice(1)
      .map(line => line.trim().split(/\s+/u)).filter(fields => fields[3] === '0A' && sockets.has(fields[9]))
      .map(fields => ({ kind, address:fields[1] })));
    return listeners.length === 1 && listeners[0]!.kind === 'tcp' &&
      listeners[0]!.address === `0100007F:${plan.port.toString(16).toUpperCase().padStart(4,'0')}`;
  } catch { return false; }
}
async function waitReady(plan: PresignedDeploymentPlan, id: string, image: DeploymentImage, exactPlan?: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const actual = await inspectContainer(id, plan, image, exactPlan);
    assert(actual.State?.Running === true, 'retained web process is not running');
    if (exactOwnedListener(plan,actual.State.Pid) && await readiness(plan)) return;
    await delay(500);
  }
  throw new Error('private deployment did not become ready; exact previous image remains retained for explicit rollback');
}
async function withDatabase<T>(environment: Record<string,string>, fn: (sql: ReturnType<typeof postgres>) => Promise<T>) {
  const sql = postgres(environment.DATABASE_URL!, { max:1, connect_timeout:10, idle_timeout:5, onnotice:() => {} });
  try { return await fn(sql); } finally { await sql.end({ timeout:5 }); }
}
async function databaseBeforeMigration(plan: PresignedDeploymentPlan, environment: Record<string,string>, receipt: DatabaseRestoreReceipt | null) {
  return withDatabase(environment, async sql => {
    const identity = await captureDatabaseRuntimeIdentity(sql);
    const versions = await sql<Array<{ version:number }>>`SELECT current_setting('server_version_num')::int AS version`;
    assert((versions[0]?.version ?? 0) >= 160000, 'deployment requires PostgreSQL 16 or newer');
    const objects = await sql<Array<{ count: number }>>`SELECT (
      (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') +
      (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') +
      (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')
    )::int AS count`;
    if (objects[0]?.count === 0) { assert(!receipt, 'restoration proof cannot describe an empty replacement database'); return identity.fingerprint; }
    assert(receipt, 'an existing database requires a fresh actual native backup and complete restoration proof');
    assert(identity.fingerprint === receipt.sourceDatabaseIdentityFingerprint, 'native restoration proof targets a different database instance');
    const snapshot = await captureDatabaseSnapshot(sql);
    sameCanonical(snapshot, receipt.sourceSnapshot, 'quiesced production database must exactly match the native restoration proof');
    sameCanonical(snapshot.migrationVersions, plan.migrationVersions.slice(0,snapshot.migrationVersions.length), 'existing migration history must be an exact forward-compatible prefix');
    return identity.fingerprint;
  });
}
async function databaseAfterMigration(plan: PresignedDeploymentPlan, environment: Record<string,string>, identity: string) {
  await withDatabase(environment, async sql => {
    const current = await captureDatabaseRuntimeIdentity(sql);
    const rows = await sql<Array<{ version:string }>>`SELECT version FROM schema_migrations ORDER BY version`;
    validateDeploymentDatabaseIdentity(plan,identity,{fingerprint:current.fingerprint,migrationVersions:rows.map(row=>row.version)});
  });
}
export interface DeploymentExecutionApproval { approvedPlanDigest: string; execution: typeof DEPLOYMENT_EXECUTION_ACK; quiescence: typeof DEPLOYMENT_QUIESCENCE_ACK }
export function validateDeploymentApproval(plan: PresignedDeploymentPlan, value: unknown): asserts value is DeploymentExecutionApproval {
  exactKeys(value, ['approvedPlanDigest','execution','quiescence'], 'private deployment execution review');
  const approval = value as DeploymentExecutionApproval;
  assert(approval.approvedPlanDigest === plan.digest && approval.execution === DEPLOYMENT_EXECUTION_ACK &&
    approval.quiescence === DEPLOYMENT_QUIESCENCE_ACK, 'execution needs this exact reviewed plan and separately quiesced other app/watcher processes');
}
/** A failed or interrupted operation stays journaled, with every container kept.
 * Rerun the same operation to reconcile; do not erase the journal to retry. */
export async function executeDeployment(value: unknown, operation: 'install' | 'rollback', approval: unknown) {
  const plan = validateDeploymentPlan(value); validateDeploymentApproval(plan, approval);
  assert(operation === 'install' || operation === 'rollback');
  await verifyDeploymentPackage(plan);
  privateJournalDirectory(plan.journalDirectory, true);
  const lock = acquireLifecycleProcessLock(plan.journalDirectory, plan.digest);
  try {
    const environment = readDeploymentEnvironment(plan); const runtime = await runtimePreflight(plan);
    const entries = readDeploymentJournal(plan); const tail = entries.at(-1);
    assert(!tail || tail.phase === 'healthy' || tail.planDigest === plan.digest,
      'another release has an unfinished durable operation; finish that exact reviewed operation first');
    const ours = entries.filter(entry => entry.planDigest === plan.digest);
    assert(!ours.length || ours[0]!.releaseId === plan.releaseId);
    let state = ours.at(-1);
    const add = (phase: DeploymentJournalEntry['phase'], values: Partial<DeploymentJournalEntry> = {}) => {
      state = appendDeploymentJournal(plan, entries, { operation, phase,
        candidateContainerId: state?.candidateContainerId ?? null, previousContainerId: state?.previousContainerId ?? null,
        activeContainerId: state?.activeContainerId ?? null, databaseIdentity: state?.databaseIdentity ?? null, ...values });
    };
    if (operation === 'rollback') {
      assert(plan.rollback && state?.previousContainerId && state.databaseIdentity, 'no exact previously deployed compatible image is available for rollback');
      assert(tail?.planDigest === plan.digest, 'a newer release owns the installation; rollback its reviewed plan instead');
      const previous = await inspectContainer(state.previousContainerId, plan, plan.rollback);
      await databaseAfterMigration(plan, environment, state.databaseIdentity);
      if (state.operation === 'rollback' && state.phase === 'healthy') {
        if(!previous.State.Running) { add('running'); await podman(['start',previous.Id]);
          await waitReady(plan,previous.Id,plan.rollback); add('healthy'); }
        else await waitReady(plan,previous.Id,plan.rollback);
        return deploymentResult(plan,state!);
      }
      // Reconcile a successful `run` whose client died before its ID reached
      // the journal. Never start the previous web while that candidate runs.
      let candidateId = state.candidateContainerId;
      for (const id of await deploymentContainers(plan)) {
        const item = JSON.parse(await podman(['container','inspect',id]))[0];
        if (item.Config?.Labels?.['io.vault.plan'] === plan.digest && item.Config.Labels['io.vault.role'] === 'web') {
          assert(!candidateId || candidateId === id, 'multiple candidate containers claim the same reviewed release'); candidateId = id;
          await inspectContainer(id,plan,plan.candidate,plan.digest);
        }
      }
      add('prepared', { candidateContainerId:candidateId });
      if (state!.candidateContainerId) {
        const current = await inspectContainer(state!.candidateContainerId, plan, plan.candidate, plan.digest);
        if (current.State.Running) await podman(['stop','--time','30',current.Id]);
      }
      add('quiesced');
      if (!previous.State.Running) await podman(['start',previous.Id]);
      add('running', { activeContainerId: previous.Id });
      await waitReady(plan, previous.Id, plan.rollback);
      add('healthy'); return deploymentResult(plan, state!);
    }
    assert(!state || state.operation === 'install', 'a rolled-back plan cannot be reinstalled implicitly; review a new release ID');
    if(state && ['migrated','running','healthy'].includes(state.phase)) {
      assert(state.databaseIdentity,'resumed deployment lost its saved database identity');
      await databaseAfterMigration(plan,environment,state.databaseIdentity);
    }
    if (state?.phase === 'healthy') {
      assert(tail?.planDigest === plan.digest && state.activeContainerId);
      const current=await inspectContainer(state.activeContainerId,plan,plan.candidate,plan.digest);
      if(!current.State.Running) { add('running'); await podman(['start',current.Id]);
        await waitReady(plan,current.Id,plan.candidate,plan.digest); add('healthy'); }
      else await waitReady(plan,current.Id,plan.candidate,plan.digest);
      return deploymentResult(plan,state!);
    }
    if (!state) {
      const ids = await deploymentContainers(plan);
      if (!tail) assert(ids.length === 0 && plan.rollback === null, 'first installation cannot adopt unknown containers or invent a rollback image');
      else {
        assert(tail.phase === 'healthy' && tail.activeContainerId && plan.rollback, 'upgrading a release requires its exact retained rollback image');
        await inspectContainer(tail.activeContainerId, plan, plan.rollback);
        // Stopped historical containers may remain; only the recorded one may run.
        for (const id of ids) { const found = JSON.parse(await podman(['container','inspect',id]))[0];
          assert(!found.State.Running || id === tail.activeContainerId, 'another installation process is still running'); }
      }
      add('prepared', { previousContainerId: tail?.activeContainerId ?? null, databaseIdentity: tail?.databaseIdentity ?? null });
    }
    if (state!.phase === 'prepared') {
      if (state!.previousContainerId) { const previous = await inspectContainer(state!.previousContainerId, plan, plan.rollback!);
        if (previous.State.Running) await podman(['stop','--time','30',previous.Id]); }
      add('quiesced');
    }
    if (state!.phase === 'quiesced') {
      const identity = await databaseBeforeMigration(plan, environment, restoreReceipt(plan, true));
      add('database-verified', { databaseIdentity: identity });
    }
    const variables = deploymentRuntimeEnvironment(plan, plan.candidate, environment);
    if (state!.phase === 'database-verified') {
      // A crash can leave an idempotent prefix applied. Recheck the instance and
      // never run any down migration or restore over this database.
      await withDatabase(environment, async sql => assert((await captureDatabaseRuntimeIdentity(sql)).fingerprint === state!.databaseIdentity));
      await runTransient(plan, 'migration', variables, runtime);
      await databaseAfterMigration(plan, environment, state!.databaseIdentity!); add('migrated');
    }
    if (state!.phase === 'migrated') {
      const ids = await deploymentContainers(plan); let id: string | undefined;
      for (const candidate of ids) {
        const item = JSON.parse(await podman(['container','inspect',candidate]))[0];
        if (item.Config?.Labels?.['io.vault.plan'] === plan.digest && item.Config.Labels['io.vault.role'] === 'web') {
          assert(!id, 'multiple containers claim one reviewed release'); id = candidate;
        }
      }
      if (!id) { const command = deploymentRunCommand(plan, 'web', Object.keys(variables), runtime.uid, runtime.gid);
        id = await podman(command.args, variables); assert(containerId(id)); }
      const actual = await inspectContainer(id, plan, plan.candidate, plan.digest);
      if (!actual.State.Running) await podman(['start',id]);
      add('running', { candidateContainerId: id, activeContainerId: id });
    }
    assert(state!.phase === 'running' && state!.activeContainerId);
    const recorded=await inspectContainer(state!.activeContainerId!,plan,plan.candidate,plan.digest);
    if(!recorded.State.Running) await podman(['start',recorded.Id]);
    await waitReady(plan, state!.activeContainerId!, plan.candidate, plan.digest);
    add('healthy'); return deploymentResult(plan, state!);
  } finally { lock.release(); }
}
function deploymentResult(plan: PresignedDeploymentPlan, state: DeploymentJournalEntry) {
  return { verified: true, operation: state.operation, phase: state.phase, planDigest: plan.digest,
    journalDigest: state.digest, activeContainerId: state.activeContainerId, host:plan.host, port:plan.port,
    databaseDowngraded:false, historicalContainersDeleted:false, publicListener:false, fundingAuthorized:false };
}
/** The supervisor is foreground and restartable. Existing durable watcher leases
 * coordinate chain work; exact installation flock prevents overlap with upgrades.
 * Successful unchanged polls are silent and do not grow the deployment journal. */
export async function monitorDeployment(value: unknown, approval: unknown, signal: AbortSignal, once = false) {
  const plan = validateDeploymentPlan(value); validateDeploymentApproval(plan, approval);
  await verifyDeploymentPackage(plan); const runtime = await runtimePreflight(plan);
  privateJournalDirectory(plan.journalDirectory, true);
  let checks = 0;
  do {
    if (signal.aborted) break;
    const lock = acquireLifecycleProcessLock(plan.journalDirectory, plan.digest);
    try {
      const environment = readDeploymentEnvironment(plan);
      const tail = readDeploymentJournal(plan).at(-1);
      assert(tail?.planDigest === plan.digest && tail.phase === 'healthy' && tail.activeContainerId,
        'monitor no longer owns the latest healthy deployment; stop and review the current release');
      const image = tail.operation === 'rollback' ? plan.rollback! : plan.candidate;
      assert(tail.databaseIdentity,'monitor lost its saved database identity');
      await databaseAfterMigration(plan,environment,tail.databaseIdentity);
      await waitReady(plan, tail.activeContainerId, image, tail.operation === 'install' ? plan.digest : undefined);
      const variables = deploymentRuntimeEnvironment(plan, image, environment);
      await runTransient(plan, 'watcher', variables, runtime, image);
      await databaseAfterMigration(plan,environment,tail.databaseIdentity);
      await waitReady(plan, tail.activeContainerId, image, tail.operation === 'install' ? plan.digest : undefined);
      checks++;
    } finally { lock.release(); }
    if (!once && !signal.aborted) try { await delay(plan.watcherIntervalSeconds * 1000, undefined, { signal }); } catch { /* controlled shutdown */ }
  } while (!once && !signal.aborted);
  return { checks, stopped:signal.aborted, publicListener:false, fundingAuthorized:false };
}
