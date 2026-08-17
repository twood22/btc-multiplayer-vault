/**
 * The Sigbash browser bundle imports four Node crypto helpers solely for its
 * optional admin-readable audit-log mode. This product always constructs the
 * SDK with privateLogs=true, whose audit encryption runs inside the pinned
 * WASM. Resolve that unconditional import to fail-closed stubs instead of
 * bundling a broad Node crypto polyfill into the signing client.
 */
function unavailable(): never {
  throw new Error('admin-readable Sigbash audit crypto is disabled in the browser');
}

export const createDecipheriv = unavailable;
export const createHmac = unavailable;
export const randomBytes = unavailable;
export const createCipheriv = unavailable;
export const createHash = unavailable;
export const createRequire = unavailable;
export const readFile = unavailable;
export const resolve = unavailable;
export class Worker {
  constructor() { unavailable(); }
}
