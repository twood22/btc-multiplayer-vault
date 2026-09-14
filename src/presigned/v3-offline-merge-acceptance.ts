/** Public deterministic fixture keys only; no node, browser or network. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPresignedFixture, preauthorizePresignedFixture, authorizePresignedFixtureRecoveries } from './fixtures.js';
import { createPresignedPublicKit } from './backup.js';
import { buildPresignedSpend, createPresignedCooperativeNonce, signPresignedCooperativePartial } from './spends.js';
import { newPresignedOfflineExchange, validatePresignedOfflineExchange, mergePresignedOfflineExchanges,
  finalizePresignedOfflineExchange } from './offline.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type PresignedPublicKit } from './types.js';

let refusals = 0;
const refuse = (action: () => unknown) => { assert.throws(action); refusals++; };
for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]) {
  const fixture = createPresignedFixture({ protocol });
  const { graph, keysById } = fixture;
  const kit = createPresignedPublicKit({ graph, preauthorizations: preauthorizePresignedFixture(fixture),
    ...(graph.version === 3 ? { recoveryAuthorizations: authorizePresignedFixtureRecoveries(fixture) } : {}) });
  const proposal = buildPresignedSpend({ graph, kind: 'cooperative', sourceExitId: null, proposalId: randomUUID() });
  const base = newPresignedOfflineExchange(graph, proposal);
  const nonces = proposal.participantIds.map(id => createPresignedCooperativeNonce({ graph, proposal, participantId: id,
    personalPrivateKey: keysById[id].personalPrivateKey, approvedProposalDigest: proposal.digest }));
  const publicNonces = nonces.map(item => item.publicNonce);
  const full = { ...base, publicNonces };
  const partials = nonces.map(item => signPresignedCooperativePartial({ graph, proposal,
    participantId: item.publicNonce.participantId, personalPrivateKey: keysById[item.publicNonce.participantId].personalPrivateKey,
    approvedProposalDigest: proposal.digest, publicNonces, nonceBinding: item.binding, consumedSecretNonce: item.secretNonce }));
  assert(nonces.every(item => item.secretNonce.every(byte => byte === 0)));
  let exchange = mergePresignedOfflineExchanges(kit, { ...base, publicNonces: [publicNonces[0]!] }, full);
  for (const partial of partials) exchange = mergePresignedOfflineExchanges(kit, exchange, { ...full, partials: [partial] });
  assert.equal(finalizePresignedOfflineExchange(kit, exchange).txid, proposal.txid);

  // No public entry point can bypass complete-kit checks on a retained or fresh peer file.
  const incompleteSolo = { ...kit, preauthorizations: kit.preauthorizations.slice(1) };
  refuse(() => validatePresignedOfflineExchange(incompleteSolo, full));
  refuse(() => mergePresignedOfflineExchanges(incompleteSolo, full, full));
  if (graph.version === 3) {
    const incompleteRecovery: PresignedPublicKit = { ...kit, recoveryAuthorizations: kit.recoveryAuthorizations!.slice(1) };
    refuse(() => validatePresignedOfflineExchange(incompleteRecovery, full));
    refuse(() => mergePresignedOfflineExchanges(incompleteRecovery, full, full));
  }
  const bad = { ...full, partials: [{ ...partials[0]!, partialSignatureHex: '00'.repeat(32) }] };
  refuse(() => mergePresignedOfflineExchanges(kit, bad, full));
  refuse(() => mergePresignedOfflineExchanges(kit, full, bad));
  refuse(() => mergePresignedOfflineExchanges(kit, full, { ...full,
    partials: [{ ...partials[0]!, nonceSetDigest: '00'.repeat(32) }] }));
  refuse(() => mergePresignedOfflineExchanges(kit, full, { ...full,
    publicNonces: publicNonces.slice(1), partials: [partials[0]!] }));
  refuse(() => mergePresignedOfflineExchanges(kit, full, { ...full,
    publicNonces: [publicNonces[0]!, publicNonces[0]!, publicNonces[2]!] }));
  refuse(() => mergePresignedOfflineExchanges(kit, full, { ...full,
    publicNonces: publicNonces.map((nonce, index) => index ? nonce : { ...nonce, pubnonce: '00'.repeat(66) }) }));
  refuse(() => mergePresignedOfflineExchanges(kit, full, { ...full,
    publicNonces: publicNonces.map((nonce, index) => index ? nonce : { ...nonce, proposalId: randomUUID() }) }));
  const other = buildPresignedSpend({ graph, kind: 'cooperative', sourceExitId: null, proposalId: randomUUID() });
  refuse(() => mergePresignedOfflineExchanges(kit, full, newPresignedOfflineExchange(graph, other)));
  const changedNonce = createPresignedCooperativeNonce({ graph, proposal, participantId: 'alice',
    personalPrivateKey: keysById.alice.personalPrivateKey, approvedProposalDigest: proposal.digest });
  try {
    refuse(() => mergePresignedOfflineExchanges(kit, full, { ...base, publicNonces: [changedNonce.publicNonce] }));
    // A mathematically valid different nonce set cannot retain an old partial's context.
    const alternate = { ...full, publicNonces: publicNonces.map(nonce => nonce.participantId === 'alice' ? changedNonce.publicNonce : nonce),
      partials: [partials[0]!] };
    refuse(() => validatePresignedOfflineExchange(kit, alternate));
  } finally { changedNonce.secretNonce.fill(0); }
  console.log(JSON.stringify({ protocol, checkedMergeCompleted: true }));
}
assert.equal(refusals, 26);
console.log(JSON.stringify({ passed: true, protocols: [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3],
  hostilePeerOrKitRefusals: refusals, completeCooperativeMerges: 2, browserExecution: false, publicNetworkBroadcasts: 0 }));
