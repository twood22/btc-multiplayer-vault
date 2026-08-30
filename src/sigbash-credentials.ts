import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { getAuthHash } from '@sigbash/sdk';
import { fsyncDirectory } from './operator-environment.js';

export interface CreatedSigbashCredentialFile {
  credentialFile: string;
  fileMode: '0600';
  durablySynced: true;
  apikeyHash: string;
  secretValuesPrinted: false;
}

export interface CreatedIndependentSigbashCredentialFile {
  credentialFile: string;
  fileMode: '0600';
  durablySynced: true;
  apikeyHashes: Record<string, string>;
  secretValuesPrinted: false;
}

export async function createSigbashCredentialFile(
  rawOutputPath = '.env',
): Promise<CreatedSigbashCredentialFile> {
  const credentialFile = resolve(rawOutputPath);
  if (basename(credentialFile) === '.env.example') {
    throw new Error('refusing to write credentials to .env.example');
  }
  const credentialParent = dirname(credentialFile);
  mkdirSync(credentialParent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(credentialParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('credential parent must be a real directory, not a link');
  }
  if ((parentStat.mode & 0o077) !== 0) {
    throw new Error('credential parent must not be accessible by group or other users');
  }

  const apiKey = randomBytes(32).toString('hex');
  const userKey = randomBytes(32).toString('hex');
  const userSecretKey = randomBytes(32).toString('hex');
  const vaultDemoSeed = randomBytes(32).toString('hex');
  const { apikeyHash } = await getAuthHash(apiKey, userKey);
  const content = [
    `SIGBASH_API_KEY=${apiKey}`,
    `SIGBASH_USER_KEY=${userKey}`,
    `SIGBASH_SECRET_KEY=${userSecretKey}`,
    'SIGBASH_SERVER_URL=https://www.sigbash.com',
    'SIGBASH_WASM_URL=https://www.sigbash.com/sigbash.wasm',
    'SIGBASH_WASM_SHA384=a57fa4c7172fb06dce6133832778247fb22c586d1e2ee70282ff8efa1f0e5b58a81b02dbd1d6b69e474254bc35c6945d',
    'SIGBASH_WASM_EXEC_URL=https://www.sigbash.com/wasm_exec.js',
    'SIGBASH_WASM_EXEC_SHA384=74dd1f0a8a6a8fcbbdba677994bf7c44a0f112367047019cf42c25057f147a1511ec8be50c35dfa5add8ce3403fec718',
    `VAULT_DEMO_SEED=${vaultDemoSeed}`,
    '',
  ].join('\n');

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      credentialFile,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(credentialParent);
  return {
    credentialFile,
    fileMode: '0600',
    durablySynced: true,
    apikeyHash,
    secretValuesPrinted: false,
  };
}

/** Create isolated hosted-Sigbash credentials for each participant in one protected operator file. */
export async function createIndependentSigbashCredentialFile(
  rawOutputPath: string,
  participantIds: readonly string[],
): Promise<CreatedIndependentSigbashCredentialFile> {
  if (participantIds.length === 0 || new Set(participantIds).size !== participantIds.length ||
      participantIds.some((id) => !/^[a-z][a-z0-9-]{0,31}$/u.test(id))) {
    throw new Error('independent Sigbash credential participants must be unique canonical ids');
  }
  const credentialFile = resolve(rawOutputPath);
  if (basename(credentialFile) === '.env.example') {
    throw new Error('refusing to write credentials to .env.example');
  }
  const credentialParent = dirname(credentialFile);
  mkdirSync(credentialParent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(credentialParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('credential parent must be a real directory, not a link');
  }
  if ((parentStat.mode & 0o077) !== 0) {
    throw new Error('credential parent must not be accessible by group or other users');
  }

  const apikeyHashes: Record<string, string> = {};
  const lines: string[] = [];
  for (const participantId of participantIds) {
    const apiKey = randomBytes(32).toString('hex');
    const userKey = randomBytes(32).toString('hex');
    const userSecretKey = randomBytes(32).toString('hex');
    const suffix = participantId.toUpperCase().replaceAll('-', '_');
    const { apikeyHash } = await getAuthHash(apiKey, userKey);
    apikeyHashes[participantId] = apikeyHash;
    lines.push(
      `SIGBASH_API_KEY_${suffix}=${apiKey}`,
      `SIGBASH_USER_KEY_${suffix}=${userKey}`,
      `SIGBASH_SECRET_KEY_${suffix}=${userSecretKey}`,
    );
  }
  lines.push(
    'SIGBASH_SERVER_URL=https://www.sigbash.com',
    'SIGBASH_WASM_URL=https://www.sigbash.com/sigbash.wasm',
    'SIGBASH_WASM_SHA384=a57fa4c7172fb06dce6133832778247fb22c586d1e2ee70282ff8efa1f0e5b58a81b02dbd1d6b69e474254bc35c6945d',
    'SIGBASH_WASM_EXEC_URL=https://www.sigbash.com/wasm_exec.js',
    'SIGBASH_WASM_EXEC_SHA384=74dd1f0a8a6a8fcbbdba677994bf7c44a0f112367047019cf42c25057f147a1511ec8be50c35dfa5add8ce3403fec718',
    `VAULT_DEMO_SEED=${randomBytes(32).toString('hex')}`,
    '',
  );

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      credentialFile,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, lines.join('\n'), { encoding: 'utf8' });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(credentialParent);
  return {
    credentialFile,
    fileMode: '0600',
    durablySynced: true,
    apikeyHashes,
    secretValuesPrinted: false,
  };
}
