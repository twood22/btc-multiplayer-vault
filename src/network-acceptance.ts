import { AMOUNTS, NETWORK } from './config.js';
import { auditSpecState } from './audit.js';
import {
  BITCOIN_CORE_CHAIN,
  BITCOIN_NETWORK,
  BITCOIN_NETWORK_NAME,
  MAINNET_GENESIS_HASH,
  assertMainnetChain,
} from './network.js';
import { buildSoloWithdrawalPsbt, inspectPsbt } from './psbt.js';
import { createDemoState } from './vault.js';

const state = createDemoState();
const audit = auditSpecState(state);
const roundOneIds = state.participants.map((participant) => participant.id);
const solo = buildSoloWithdrawalPsbt({
  state,
  currentIds: roundOneIds,
  leaverId: 'alice',
  txid: '00'.repeat(32),
  vout: 0,
  valueSats: AMOUNTS.deposit * roundOneIds.length,
});
const inspection = inspectPsbt(solo.psbtBase64);
let rejectedNonMainnet = false;
try {
  assertMainnetChain('signet');
} catch {
  rejectedNonMainnet = true;
}

const checks = [
  ['product network literal is mainnet', NETWORK === 'mainnet'],
  ['shared service network literal is mainnet', BITCOIN_NETWORK_NAME === 'mainnet'],
  ['shared BitcoinJS network uses the bc human-readable prefix', BITCOIN_NETWORK.bech32 === 'bc'],
  ['shared Bitcoin Core chain name is main', BITCOIN_CORE_CHAIN === 'main'],
  ['backend identity is pinned to the Bitcoin mainnet genesis block', MAINNET_GENESIS_HASH === '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'],
  ['a non-mainnet backend is rejected before use', rejectedNonMainnet],
  ['audit proves every payout and vault address is bc1p', audit.checks.some(
    (check) => check.name === 'all payout and vault addresses are mainnet taproot addresses' && check.ok,
  )],
  ['audit proves every policy destination declares mainnet', audit.checks.some(
    (check) => check.name === 'all solo policies and destination conditions declare mainnet' && check.ok,
  )],
  ['a mainnet solo PSBT round-trips through the shared parser', inspection.outputs.length === 2],
  ['every parsed solo output is a mainnet taproot address', inspection.outputs.every(
    (output) => output.address.startsWith('bc1p'),
  )],
] as const;

if (!checks.every(([, ok]) => ok)) {
  throw new Error(`mainnet acceptance failed: ${checks.filter(([, ok]) => !ok).map(([name]) => name).join(', ')}`);
}

console.log(JSON.stringify({ passed: true, checks: checks.map(([name, ok]) => ({ name, ok })) }, null, 2));
