import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { sha256Hex } from '../crypto.js';
import { MAINNET_GENESIS_HASH, SIGNET_GENESIS_HASH } from '../network.js';
import type { BitcoinNetworkName } from '../types.js';
import { PARTICIPANT_IDS, type ParticipantId, type RoundId } from './types.js';

bitcoin.initEccLib(ecc);

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`presigned-v2: ${message}`);
}

export function exactKeys(value: unknown, expected: string[], label: string): void {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  const keys = Object.keys(value as object).sort();
  assert(JSON.stringify(keys) === JSON.stringify([...expected].sort()), `${label} has unexpected or missing fields`);
}

export function safeInteger(value: number, min: number, max: number, label: string): void {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, `invalid ${label}`);
}

export function hexBytes(value: string, bytes: number, label: string): Buffer {
  assert(typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u').test(value), `invalid ${label}`);
  return Buffer.from(value, 'hex');
}

export function publicKey(value: string, compressed: boolean, label: string): Buffer {
  const bytes = hexBytes(value, compressed ? 33 : 32, label);
  assert(compressed ? ecc.isPoint(bytes) && (bytes[0] === 2 || bytes[0] === 3) : ecc.isXOnlyPoint(bytes), `invalid ${label}`);
  return bytes;
}

export function identifier(value: string, label: string): void {
  assert(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value), `invalid ${label}`);
}

export function participantId(value: string): asserts value is ParticipantId {
  assert(PARTICIPANT_IDS.some(id => id === value), 'unknown participant');
}

export function roundId(ids: readonly ParticipantId[]): RoundId {
  assert(ids.length >= 2 && ids.length <= 3 && new Set(ids).size === ids.length, 'invalid round members');
  ids.forEach(participantId);
  return [...ids].sort().join('') as RoundId;
}

export function memberRounds(id: ParticipantId): RoundId[] {
  participantId(id);
  return [roundId(PARTICIPANT_IDS), ...PARTICIPANT_IDS.filter(other => other !== id).map(other => roundId([id, other]))].sort();
}

export function networkParameters(network: BitcoinNetworkName): typeof bitcoin.networks.bitcoin {
  assert(network === 'mainnet' || network === 'signet', 'unsupported network');
  return network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

export function genesisHash(network: BitcoinNetworkName): string {
  networkParameters(network);
  return network === 'mainnet' ? MAINNET_GENESIS_HASH : SIGNET_GENESIS_HASH;
}

/** Canonical JSON, not an object-order dependent authentication primitive. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    assert(Number.isSafeInteger(value), 'canonical JSON only accepts safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  assert(typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype, 'non-JSON commitment value');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function commitmentDigest(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\n${canonicalJson(value)}`);
}

export function supportedWalletScript(value: string): boolean {
  return typeof value === 'string' && /^(?:0014[0-9a-f]{40}|5120[0-9a-f]{64})$/u.test(value);
}

export function sameCanonical(actual: unknown, expected: unknown, label: string): void {
  assert(canonicalJson(actual) === canonicalJson(expected), `${label} differs from independently rebuilt commitment`);
}
