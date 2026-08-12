import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  openSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { getAuthHash } from '@sigbash/sdk';

export interface CreatedSigbashCredentialFile {
  credentialFile: string;
  fileMode: '0600';
  apikeyHash: string;
  secretValuesPrinted: false;
}

export async function createSigbashCredentialFile(
  rawOutputPath = '.env',
): Promise<CreatedSigbashCredentialFile> {
  const credentialFile = resolve(rawOutputPath);
  if (basename(credentialFile) === '.env.example') {
    throw new Error('refusing to write credentials to .env.example');
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
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, content, { encoding: 'utf8' });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  chmodSync(credentialFile, 0o600);
  return {
    credentialFile,
    fileMode: '0600',
    apikeyHash,
    secretValuesPrinted: false,
  };
}
