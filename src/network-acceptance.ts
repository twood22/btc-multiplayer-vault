import { AMOUNTS, NETWORK } from './config.js';
import { auditSpecState } from './audit.js';
import {
  BITCOIN_CORE_CHAIN,
  BITCOIN_GENESIS_HASH,
  BITCOIN_NETWORK,
  BITCOIN_NETWORK_CONFIG,
  BITCOIN_NETWORK_NAME,
  assertConfiguredChain,
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
const wrongChain = BITCOIN_CORE_CHAIN === 'main' ? 'signet' : 'main';
let rejectedWrongChain = false;
try {
  assertConfiguredChain(wrongChain);
} catch {
  rejectedWrongChain = true;
}
const addressPrefix = BITCOIN_NETWORK_NAME === 'mainnet' ? 'bc1p' : 'tb1p';

const checks = [
  ['config and shared network names match', NETWORK === BITCOIN_NETWORK_NAME],
  ['BitcoinJS network prefix matches the selected profile', BITCOIN_NETWORK.bech32 === addressPrefix.slice(0, -2)],
  ['Bitcoin Core chain name matches the selected profile', BITCOIN_CORE_CHAIN === BITCOIN_NETWORK_CONFIG.coreChain],
  ['backend identity is pinned to the selected genesis block', BITCOIN_GENESIS_HASH === BITCOIN_NETWORK_CONFIG.genesisHash],
  ['a backend from the other network is rejected before use', rejectedWrongChain],
  ['audit proves every payout and vault address uses the selected taproot prefix', audit.checks.some(
    (check) => check.name === `all payout and vault addresses are ${BITCOIN_NETWORK_NAME} taproot addresses` && check.ok,
  )],
  ['audit proves every policy destination declares the selected network', audit.checks.some(
    (check) => check.name === `all solo policies and destination conditions declare ${BITCOIN_NETWORK_NAME}` && check.ok,
  )],
  ['a solo PSBT round-trips through the shared parser', inspection.outputs.length === 2],
  ['every parsed solo output uses the selected taproot prefix', inspection.outputs.every(
    (output) => output.address.startsWith(addressPrefix),
  )],
] as const;

if (!checks.every(([, ok]) => ok)) {
  throw new Error(`${BITCOIN_NETWORK_NAME} acceptance failed: ${checks.filter(([, ok]) => !ok).map(([name]) => name).join(', ')}`);
}

console.log(JSON.stringify({
  passed: true,
  network: BITCOIN_NETWORK_NAME,
  checks: checks.map(([name, ok]) => ({ name, ok })),
}, null, 2));
