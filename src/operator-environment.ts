import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export function loadProtectedEnvironmentFile(
  rawPath: string,
  options: { required?: boolean } = {},
): string | null {
  const environmentPath = resolve(rawPath);
  if (!existsSync(environmentPath)) {
    if (options.required) throw new Error(`protected environment file does not exist: ${environmentPath}`);
    return null;
  }
  assertProtectedRegularFile(environmentPath, 'BTC vault environment');
  const parentStat = lstatSync(dirname(environmentPath));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('BTC vault environment parent must be a real directory, not a link');
  }
  if ((parentStat.mode & 0o022) !== 0) {
    throw new Error('BTC vault environment parent must not be writable by group or other users');
  }
  loadEnvFile(environmentPath);
  return environmentPath;
}

export function writeProtectedEnvironmentFile(
  rawPath: string,
  content: string,
): { path: string; reused: boolean } {
  return writeProtectedFile(rawPath, content);
}

export function writeProtectedFile(
  rawPath: string,
  content: string,
): { path: string; reused: boolean } {
  const environmentPath = resolve(rawPath);
  const parent = dirname(environmentPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('protected environment parent must be a real directory, not a link');
  }
  if ((parentStat.mode & 0o077) !== 0) {
    throw new Error('protected environment parent must not be accessible by group or other users');
  }

  if (existsSync(environmentPath)) {
    assertProtectedRegularFile(environmentPath, 'protected environment');
    if (readFileSync(environmentPath, 'utf8') !== content) {
      throw new Error('protected environment already exists with different content; refusing to overwrite it');
    }
    return { path: environmentPath, reused: true };
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      environmentPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  chmodSync(environmentPath, 0o600);
  fsyncDirectory(parent);
  return { path: environmentPath, reused: false };
}

export function appendProtectedFile(rawPath: string, content: string): { path: string } {
  const protectedPath = resolve(rawPath);
  const parent = dirname(protectedPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('protected file parent must be a real directory, not a link');
  }
  if ((parentStat.mode & 0o077) !== 0) {
    throw new Error('protected file parent must not be accessible by group or other users');
  }
  if (existsSync(protectedPath)) assertProtectedRegularFile(protectedPath, 'protected file');

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      protectedPath,
      fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  chmodSync(protectedPath, 0o600);
  fsyncDirectory(parent);
  return { path: protectedPath };
}

export function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertProtectedRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users`);
  }
}
