import 'server-only';

export interface SigbashRuntimeConfig {
  serverUrl: string;
  wasmUrl: string;
  wasmSha384: string;
  wasmExecUrl: string;
  wasmExecSha384: string;
  sdkVersion: '0.7.1';
}

export function sigbashRuntimeConfig(): SigbashRuntimeConfig {
  return {
    serverUrl: httpsOrigin(process.env.SIGBASH_SERVER_URL || 'https://www.sigbash.com', 'SIGBASH_SERVER_URL'),
    wasmUrl: httpsUrl(process.env.SIGBASH_WASM_URL || 'https://www.sigbash.com/sigbash.wasm', 'SIGBASH_WASM_URL'),
    wasmSha384: hash(process.env.SIGBASH_WASM_SHA384, 'SIGBASH_WASM_SHA384'),
    wasmExecUrl: httpsUrl(process.env.SIGBASH_WASM_EXEC_URL || 'https://www.sigbash.com/wasm_exec.js', 'SIGBASH_WASM_EXEC_URL'),
    wasmExecSha384: hash(process.env.SIGBASH_WASM_EXEC_SHA384, 'SIGBASH_WASM_EXEC_SHA384'),
    sdkVersion: '0.7.1',
  };
}

function hash(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for the live browser runtime`);
  if (!/^[0-9a-fA-F]{96}$/u.test(value)) throw new Error(`${name} must be a 96-character SHA-384 hex digest`);
  return value.toLowerCase();
}

function httpsUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or a fragment`);
  }
  return url.href;
}

function httpsOrigin(value: string, name: string): string {
  const url = new URL(httpsUrl(value, name));
  if (url.pathname !== '/' || url.search) {
    throw new Error(`${name} must be a bare HTTPS origin without a path or query`);
  }
  return url.origin;
}
