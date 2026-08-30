import type { SigbashClient } from '@sigbash/sdk';

export interface SigbashBrowserRuntimeConfig {
  serverUrl: string;
  wasmUrl: string;
  wasmSha384: string;
  sdkVersion: '0.8.0';
}

export interface LoadedSigbashBrowserRuntime {
  sdk: typeof import('@sigbash/sdk');
  config: SigbashBrowserRuntimeConfig;
}

let runtimePromise: Promise<LoadedSigbashBrowserRuntime> | undefined;
let goRuntimePromise: Promise<void> | undefined;
const VERIFIED_GO_RUNTIME_PATH = '/api/sigbash/runtime/go';

/** Load only after a passkey unlock; importing this module never touches credentials. */
export function loadSigbashBrowserRuntime(
  onProgress?: (progress: number, stage: string) => void,
): Promise<LoadedSigbashBrowserRuntime> {
  runtimePromise ??= load(onProgress).catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

async function load(
  onProgress?: (progress: number, stage: string) => void,
): Promise<LoadedSigbashBrowserRuntime> {
  const config = await postJson('/api/sigbash/runtime/config', {}) as unknown as SigbashBrowserRuntimeConfig;
  if (config.sdkVersion !== '0.8.0') throw new Error('server selected an unsupported Sigbash SDK version');
  if (!/^https:\/\//u.test(config.serverUrl) || !/^https:\/\//u.test(config.wasmUrl)) {
    throw new Error('Sigbash browser runtime must use HTTPS');
  }
  if (!/^[0-9a-f]{96}$/u.test(config.wasmSha384)) {
    throw new Error('Sigbash WASM integrity pin is invalid');
  }
  await loadGoRuntime();
  const sdk = await import('@sigbash/sdk');
  if (sdk.SDK_VERSION !== config.sdkVersion) throw new Error('bundled Sigbash SDK version does not match the server gate');
  await sdk.loadWasm({
    wasmUrl: config.wasmUrl,
    expectedHash: config.wasmSha384,
    onProgress,
  });
  return { sdk, config };
}

async function loadGoRuntime(): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  // The SDK creates proof workers after the main runtime is loaded. Point those
  // workers at the same authenticated, hash-verified Go runtime route instead
  // of the SDK's unverified /wasm_exec.js default.
  globals._sigbashWasmExecUrl = VERIFIED_GO_RUNTIME_PATH;
  if (typeof globals.Go === 'function') return;
  goRuntimePromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = VERIFIED_GO_RUNTIME_PATH;
    script.async = true;
    script.onload = () => {
      if (typeof globals.Go !== 'function') {
        reject(new Error('verified Go WASM runtime did not initialize'));
        return;
      }
      resolve();
    };
    script.onerror = () => reject(new Error('verified Go WASM runtime could not be loaded'));
    document.head.append(script);
  }).catch((error) => {
    goRuntimePromise = undefined;
    throw error;
  });
  return goRuntimePromise;
}

export function createSigbashBrowserClient(
  runtime: LoadedSigbashBrowserRuntime,
  credentials: { apiKey: string; userKey: string; userSecretKey: string },
  musig2PrivateKey?: Uint8Array,
): SigbashClient {
  return new runtime.sdk.SigbashClient({
    serverUrl: runtime.config.serverUrl,
    apiKey: credentials.apiKey,
    userKey: credentials.userKey,
    userSecretKey: credentials.userSecretKey,
    privateLogs: true,
    ...(musig2PrivateKey ? { musig2PrivateKey } : {}),
  });
}

/** Release sockets and overwrite the SDK's copied private-key material. */
export function disposeSigbashBrowserClient(
  client: Pick<SigbashClient, 'disconnect' | 'dispose'>,
): void {
  try {
    client.disconnect();
  } finally {
    client.dispose();
  }
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const result = (await response.json()) as { error?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
