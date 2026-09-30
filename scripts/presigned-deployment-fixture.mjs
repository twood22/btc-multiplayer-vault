/** Separately pinned operator fixture. Never edits or adopts candidate files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLING=dirname(fileURLToPath(import.meta.url));
const ORIGINAL='scripts/presigned-deployment-image-acceptance.mts';
const CONFIGURED='presigned-deployment-configured-fixture.mts';
export const DRILL_FIXTURE=Object.freeze({profile:'configured-disposable-fixture-v1',
  originalSha256:'a25b3fa6226d63b20a506d13b255d617cdaf9b25bee6c7a6828c331736e00983',
  configuredSha256:'fe931a29997ed8b053ef973ac4b656a2b6f40aa8170da36998b67a78a1113aa0',
  configurationCorrection:'VAULT_CONFIRMATIONS_REQUIRED=1',
  importResolution:'private-owned-exact-candidate-alias',applicationSourceUnchanged:true,
  stockAssertionsUnchanged:true,originalUnconfiguredFixturePassed:false});
export const FIXTURE_IMPORT_RELOCATIONS=Object.freeze([
  ['../src/presigned/release.js','./candidate/src/presigned/release.js'],
  ['../src/presigned/types.js','./candidate/src/presigned/types.js'],
  ['../src/presigned/validation.js','./candidate/src/presigned/validation.js'],
  ['../src/database-restore-receipt.js','./candidate/src/database-restore-receipt.js'],
  ['../web/lib/database-snapshot.js','./candidate/web/lib/database-snapshot.js'],
  ['../web/lib/migrations.js','./candidate/web/lib/migrations.js'],
  ['./lib/presigned-oci.js','./candidate/scripts/lib/presigned-oci.js'],
  ['./presigned-build-identity.mjs','./candidate/scripts/presigned-build-identity.mjs'],
  ['./lib/presigned-durable-journal.js','./candidate/scripts/lib/presigned-durable-journal.js'],
  ['./lib/presigned-deployment-plan.js','./candidate/scripts/lib/presigned-deployment-plan.js'],
  ['./lib/presigned-deployment-runtime.js','./candidate/scripts/lib/presigned-deployment-runtime.js'],
  ['./lib/presigned-deployment-evidence.js','./candidate/scripts/lib/presigned-deployment-evidence.js'],
].map(Object.freeze));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateDrillFixture(value){
  assert(value&&Object.getPrototypeOf(value)===Object.prototype);
  assert.deepEqual(Object.keys(value).sort(),Object.keys(DRILL_FIXTURE).sort());
  for(const [key,expected] of Object.entries(DRILL_FIXTURE)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);assert(descriptor&&Object.hasOwn(descriptor,'value'));assert.equal(descriptor.value,expected);
  }
  return value;
}
export function reconstructOriginalFixture(configured){
  assert(typeof configured==='string'&&Buffer.byteLength(configured)<=65536&&!configured.includes('\0'));
  let original=configured;
  const correction=",VAULT_CONFIRMATIONS_REQUIRED:'1'";
  assert.equal(original.split(correction).length,2,'one exact operator configuration correction required');
  original=original.replace(correction,'');
  for(const [before,after]of FIXTURE_IMPORT_RELOCATIONS){
    const token="'"+after+"'";assert.equal(original.split(token).length,2,'one exact literal import relocation required');
    original=original.replace(token,"'"+before+"'");
  }
  assert.equal(sha(original),DRILL_FIXTURE.originalSha256,'stock fixture statements or assertions changed');
  return original;
}
export function validateFixtureBytes(original,configured){
  assert(Buffer.isBuffer(original)&&Buffer.isBuffer(configured));
  assert.equal(sha(original),DRILL_FIXTURE.originalSha256);
  assert.equal(sha(configured),DRILL_FIXTURE.configuredSha256);
  assert.equal(reconstructOriginalFixture(configured.toString('utf8')),original.toString('utf8'));
}
function ownedDirectory(path,privateOnly=false){
  assert(typeof path==='string'&&path===resolve(path)&&realpathSync(path)===path);
  const before=lstatSync(path);assert(before.isDirectory()&&!before.isSymbolicLink()&&before.uid===process.getuid()&&
    (before.mode&0o022)===0&&(!privateOnly||(before.mode&0o777)===0o700));
  const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const opened=fstatSync(fd);assert(opened.dev===before.dev&&opened.ino===before.ino);}finally{closeSync(fd);}
}
function ownedBytes(path,privateOnly=false){
  assert(realpathSync(path)===path);ownedDirectory(dirname(path),privateOnly);
  const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===process.getuid()&&before.nlink===1&&
    (before.mode&0o022)===0&&(!privateOnly||(before.mode&0o777)===0o600)&&before.size>0&&before.size<=65536);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const opened=fstatSync(fd);assert(opened.dev===before.dev&&opened.ino===before.ino&&opened.size===before.size);
    const bytes=readFileSync(fd),after=fstatSync(fd);assert(after.size===opened.size&&after.mtimeMs===opened.mtimeMs&&after.ctimeMs===opened.ctimeMs&&bytes.length===opened.size);return bytes;
  }finally{closeSync(fd);}
}
function ownedAlias(path,target){
  const before=lstatSync(path);assert(before.isSymbolicLink()&&before.uid===process.getuid()&&before.nlink===1);
  assert.equal(readlinkSync(path),target);assert.equal(realpathSync(path),target);ownedDirectory(target);
  const after=lstatSync(path);assert(after.dev===before.dev&&after.ino===before.ino&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs);
}
export function verifyPreparedFixture(binding,candidateRoot){
  assert(binding&&Object.isFrozen(binding)&&binding.candidateRoot===candidateRoot);
  assert.equal(binding.directory,join(binding.root,'drill-fixture'));assert.equal(binding.entry,join(binding.directory,CONFIGURED));
  ownedDirectory(binding.root,true);ownedDirectory(binding.directory,true);ownedDirectory(candidateRoot);
  assert.equal(process.cwd(),candidateRoot,'candidate cwd must remain unchanged');
  ownedAlias(join(binding.directory,'candidate'),candidateRoot);
  ownedAlias(join(binding.directory,'node_modules'),join(candidateRoot,'node_modules'));
  validateFixtureBytes(ownedBytes(join(candidateRoot,ORIGINAL)),ownedBytes(binding.entry,true));
  return binding;
}
export function prepareConfiguredFixture(root,candidateRoot){
  ownedDirectory(root,true);ownedDirectory(candidateRoot);ownedDirectory(join(candidateRoot,'node_modules'));
  assert.equal(process.cwd(),candidateRoot);
  const original=ownedBytes(join(candidateRoot,ORIGINAL)),configured=ownedBytes(join(TOOLING,CONFIGURED));
  validateFixtureBytes(original,configured);
  const directory=join(root,'drill-fixture');mkdirSync(directory,{mode:0o700});
  const entry=join(directory,CONFIGURED),fd=openSync(entry,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,configured);fsyncSync(fd);}finally{closeSync(fd);}
  symlinkSync(candidateRoot,join(directory,'candidate'),'dir');
  symlinkSync(join(candidateRoot,'node_modules'),join(directory,'node_modules'),'dir');
  return verifyPreparedFixture(Object.freeze({root,directory,entry,candidateRoot}),candidateRoot);
}
