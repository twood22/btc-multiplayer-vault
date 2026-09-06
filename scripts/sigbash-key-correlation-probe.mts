// Offline characterization of the SDK 0.8.0 response-correlation defect.
// This deliberately proves unsafe upstream behavior; it is NOT a passing
// application security gate. No client credentials, WASM, or network calls.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SDK_VERSION, SigbashSocket } from '@sigbash/sdk';

assert.equal(SDK_VERSION, '0.8.0', 'reassess this characterization after an SDK upgrade');
const socket = new EventEmitter();
const requests: number[] = [];
socket.on('get_encrypted_kmc', (payload: { key_index: number }) => requests.push(payload.key_index));
const request = (index: number) => SigbashSocket.prototype.request.call(
  { _socket: socket } as unknown as SigbashSocket,
  'get_encrypted_kmc', { key_index: index }, 1_000,
) as Promise<{ key_index: number }>;

// listKeys() starts these requests together using Promise.all().
const pending = [0, 1, 2].map(request);
socket.emit('get_encrypted_kmc_response', { key_index: 0 });
const parallelReplies = (await Promise.all(pending)).map(reply => reply.key_index);
assert.deepEqual(requests, [0, 1, 2]);
assert.deepEqual(parallelReplies, [0, 0, 0]);

// The two unconsumed responses can satisfy an unrelated subsequent getKey().
const next = request(2);
socket.emit('get_encrypted_kmc_response', { key_index: 1 });
const staleReply = (await next).key_index;
assert.equal(staleReply, 1);
socket.emit('get_encrypted_kmc_response', { key_index: 2 });
socket.emit('get_encrypted_kmc_response', { key_index: 2 });

// With a clean transport and exactly one outstanding request at a time,
// the same SDK primitive matches each controlled response correctly.
const sequentialReplies: number[] = [];
for (const index of [0, 1, 2]) {
  const result = request(index);
  socket.emit('get_encrypted_kmc_response', { key_index: index });
  sequentialReplies.push((await result).key_index);
}
assert.deepEqual(sequentialReplies, [0, 1, 2]);
assert.equal(socket.listenerCount('get_encrypted_kmc_response'), 0);
assert.equal(socket.listenerCount('get_encrypted_kmc_error'), 0);
console.log(JSON.stringify({
  sdkVersion: SDK_VERSION, networkCalls: 0,
  upstreamDefectReproduced: true,
  requestedIndexes: [0, 1, 2], parallelReplies,
  nextRequestedIndex: 2, staleReply, sequentialReplies,
  applicationMitigationTestedByThisProbe: false,
}, null, 2));
