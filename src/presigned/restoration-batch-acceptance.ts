/** Public known-answer keys only. No network, database, or durable custody. */
import assert from 'node:assert/strict';
import { createPresignedFixture, preauthorizePresignedFixture, authorizePresignedFixtureRecoveries } from './fixtures.js';
import { createPresignedPublicKit, presignedBackupBinding, presignedBackupDomain, verifyPresignedKitRestoration } from './backup.js';
import { validatePresignedRestorationReceipt, validatePresignedRestorationReceipts } from './ceremony.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3 } from './types.js';
import { commitmentDigest } from './validation.js';

let refusals = 0; let verifiedReceipts = 0; let independentSingleChecks = 0;
for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3] as const) {
  for (const network of ['signet', 'mainnet'] as const) {
    const fixture = createPresignedFixture({ protocol, network });
    const base = { graph: fixture.graph, preauthorizations: preauthorizePresignedFixture(fixture),
      ...(protocol === PRESIGNED_PROTOCOL_V3 ? { recoveryAuthorizations: authorizePresignedFixtureRecoveries(fixture) } : {}) };
    const kit = createPresignedPublicKit(base);
    const receipts = PARTICIPANT_IDS.flatMap(participantId => {
      const proof = verifyPresignedKitRestoration({ publicKit: kit, participantId,
        participantSecret: fixture.participantSecrets[participantId], expectedBinding: presignedBackupBinding(kit, participantId) });
      return Array.from({ length: 3 }, () => ({ participantId, proof: structuredClone(proof) }));
    });
    const input = { ...base, receipts };
    const expected = receipts.map(receipt => receipt.proof);
    assert.deepEqual(validatePresignedRestorationReceipts(input), expected); verifiedReceipts += receipts.length;
    for (const index of [0, 3, 8]) {
      assert.deepEqual(validatePresignedRestorationReceipt({ ...base, ...receipts[index]! }), expected[index]);
      independentSingleChecks++;
    }
    const deny = (mutate: (bad: any) => void) => {
      const bad = structuredClone(input); mutate(bad);
      assert.throws(() => validatePresignedRestorationReceipts(bad)); refusals++;
    };
    // Fresh digests must not turn mutated evidence into valid owner proofs.
    const denyProof = (mutate: (proof: any) => void) => deny(bad => {
      const proof = bad.receipts[8].proof; mutate(proof);
      const { proofDigest: _old, ...body } = proof;
      proof.proofDigest = commitmentDigest(`${presignedBackupDomain(protocol)}/restoration-proof`, body);
    });
    deny(bad => { bad.receipts[8].participantId = 'alice'; });
    deny(bad => { bad.receipts[8].participantId = 'not-a-member'; });
    deny(bad => { bad.receipts[8].proof.proofDigest = '00'.repeat(32); });
    deny(bad => { bad.receipts[8].proof = null; });
    deny(bad => { bad.receipts = null; });
    deny(bad => { bad.graph.fundingTxid = '00'.repeat(32); });
    deny(bad => { bad.preauthorizations.pop(); });
    deny(bad => { bad.preauthorizations[0].signatureHex = '00'.repeat(64); });
    denyProof(proof => { proof.binding.participantId = 'alice'; });
    denyProof(proof => { proof.binding.network = network === 'signet' ? 'mainnet' : 'signet'; });
    denyProof(proof => { proof.binding.graphDigest = '00'.repeat(32); });
    denyProof(proof => { proof.publicKitDigest = '00'.repeat(32); });
    denyProof(proof => { proof.participantIdentityDigest = '00'.repeat(32); });
    denyProof(proof => { proof.exitProofs[2].txid = '00'.repeat(32); });
    denyProof(proof => { proof.exitProofs.reverse(); });
    denyProof(proof => { proof.exitProofs.pop(); });
    denyProof(proof => { proof.unexpected = true; });
    denyProof(proof => { proof.protocol = protocol === PRESIGNED_PROTOCOL_V3 ? PRESIGNED_PROTOCOL : PRESIGNED_PROTOCOL_V3; });
    if (protocol === PRESIGNED_PROTOCOL_V3) {
      deny(bad => { bad.recoveryAuthorizations.pop(); });
      deny(bad => { bad.recoveryAuthorizations[0].signatureHex = '00'.repeat(64); });
      denyProof(proof => { proof.recoveryProofs[2].signatureHex = '00'.repeat(64); });
      denyProof(proof => { proof.recoveryProofs.reverse(); });
    }
    const returned = validatePresignedRestorationReceipts(input);
    returned[8]!.binding.graphDigest = '00'.repeat(32);
    assert.deepEqual(validatePresignedRestorationReceipts(input), expected, 'caller cannot poison later validation via a returned object');
    const changed = structuredClone(input); changed.receipts[8]!.proof.proofDigest = '00'.repeat(32);
    assert.throws(() => validatePresignedRestorationReceipts(changed)); refusals++;
    assert.deepEqual(validatePresignedRestorationReceipts(input), expected, 'failure cannot poison later valid input');
  }
}
console.log(JSON.stringify({ passed: true, suite: 'restoration-batch-boundaries', protocols: 2, networkFormats: 2,
  verifiedReceipts, independentSingleChecks, refusals, globalCache: false, networkOrDatabaseContacted: false }));
