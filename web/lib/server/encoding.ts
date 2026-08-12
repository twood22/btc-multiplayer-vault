import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function fromBase64url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is not base64url`);
  return Buffer.from(value, 'base64url');
}

export function toBase64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
