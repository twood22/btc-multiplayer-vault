import assert from 'node:assert/strict';
import type { SigbashClient } from '@sigbash/sdk';
import * as bitcoin from 'bitcoinjs-lib';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { psbtUnsignedTxid } from '../../src/psbt.js';
import type { SigbashRosterRegistration } from '../../src/vault.js';
import type { SigbashCustodyKey } from '../lib/client/sigbash-custody.js';
import {
  signAuthorizedSoloWithdrawal,
  unlockPublishedVault,
} from '../lib/client/vault-signing.js';
import {
  createIsolatedSoloFixture,
  signPolicyLeafPsbt,
  SOLO_PARTICIPANTS,
  SOLO_ROUND,
} from './solo-signing-fixture.js';

const IDS = [...SOLO_PARTICIPANTS];
const VAULT_ID = 'f1248f25-7d25-4774-9ad0-5ce5c87ddf5d';
const ROUND = SOLO_ROUND;
const fixture = createIsolatedSoloFixture(VAULT_ID);
const { artifact, digest } = fixture;
const unlocked = unlockPublishedVault({
  artifact,
  expectedDigest: digest,
  participantSecret: fixture.participantSecrets.alice,
});
const registration = artifact.participants.find((entry) => entry.id === 'alice')!
  .sigbashRegistrationByRound![ROUND]!;
const custodyKey = custodyKeyFor(registration);
const coin = {
  vaultId: VAULT_ID,
  rosterDigest: digest,
  kind: 'vault' as const,
  roundId: ROUND,
  ownerParticipantId: null,
  txid: '91'.repeat(32),
  vout: 0,
  valueSats: artifact.funding.valueSats,
  scriptPubKeyHex: artifact.funding.outputScriptHex,
};
const checks: Array<{ name: string; ok: true }> = [];

await check('the production client boundary accepts a service-shaped policy-leaf signature only after local authorization', async () => {
  const calls: string[] = [];
  const client = signerClient({ calls });
  const result = await signAuthorizedSoloWithdrawal({
    unlocked,
    currentIds: IDS,
    trustedInput: coin,
    custodyKey,
    client,
  });
  assert.deepEqual(calls, ['getKey', 'verifyPSBT', 'signPSBT']);
  assert.equal(result.verification.passed, true);
  assert(result.signed.transactionHex);
  assert(result.signed.signedPsbtBase64);
  assert.equal(result.authorization.finalTxid, psbtUnsignedTxid(result.built.psbtBase64));
  assert.equal(result.authorization.txHexVerified, true);
  assert.equal(result.authorization.signedPsbtVerified, true);
  assert.equal(result.authorization.signedPsbtFinalized, true);
  assert(result.authorization.consensus?.checks.some((item) => item.includes('OP_CHECKSIG satisfied')));
});

await check('the production client boundary fails closed unless verifyPSBT explicitly passes without an error', async () => {
  let signCalls = 0;
  const missingPassed = signerClient({
    verifyResult: { success: true },
    onSign: () => { signCalls += 1; },
  });
  await assert.rejects(() => signAuthorizedSoloWithdrawal({
    unlocked,
    currentIds: IDS,
    trustedInput: coin,
    custodyKey,
    client: missingPassed,
  }), /Sigbash rejected/u);
  const passedWithError = signerClient({
    verifyResult: { passed: true, error: 'server disagreement' },
    onSign: () => { signCalls += 1; },
  });
  await assert.rejects(() => signAuthorizedSoloWithdrawal({
    unlocked,
    currentIds: IDS,
    trustedInput: coin,
    custodyKey,
    client: passedWithError,
  }), /server disagreement/u);
  assert.equal(signCalls, 0);
});

await check('the production client boundary rejects a signer response that mutates the committed transaction', async () => {
  const client = signerClient({ mutateTransaction: true });
  await assert.rejects(() => signAuthorizedSoloWithdrawal({
    unlocked,
    currentIds: IDS,
    trustedInput: coin,
    custodyKey,
    client,
  }), /changed output 0's value/u);
});

await check('the production client boundary rejects a KMC or signature bound to a different policy root', async () => {
  await assert.rejects(() => signAuthorizedSoloWithdrawal({
    unlocked,
    currentIds: IDS,
    trustedInput: coin,
    custodyKey,
    client: signerClient({ getKeyPolicyRoot: 'aa'.repeat(32) }),
  }), /policy root differs/u);
  await assert.rejects(() => signAuthorizedSoloWithdrawal({
    unlocked,
    currentIds: IDS,
    trustedInput: coin,
    custodyKey,
    client: signerClient({ signingPolicyRoot: 'bb'.repeat(32) }),
  }), /policy root different/u);
});

console.log(JSON.stringify({
  title: 'isolated production-client Sigbash solo-signing acceptance',
  passed: true,
  externalSigbashContacted: false,
  liveMainnetEvidence: false,
  checks,
}, null, 2));

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks.push({ name, ok: true });
}

function signerClient(options: {
  calls?: string[];
  verifyResult?: Record<string, unknown>;
  getKeyPolicyRoot?: string;
  signingPolicyRoot?: string;
  mutateTransaction?: boolean;
  onSign?: () => void;
} = {}): SigbashClient {
  const privateKey = fixture.policyPrivateKeys.get(`alice:${ROUND}`)!;
  let verifiedPsbtBase64: string | undefined;
  return {
    async getKey(keyId: string) {
      options.calls?.push('getKey');
      assert.equal(keyId, registration.keyId);
      return {
        keyId: registration.keyId,
        keyIndex: registration.keyIndex,
        network: BITCOIN_NETWORK_NAME,
        policyRoot: options.getKeyPolicyRoot ?? registration.policyRoot,
        require2FA: false,
        kmcJSON: '{"isolated":"acceptance-only"}',
      };
    },
    async verifyPSBT(input: { psbtBase64: string; kmcJSON: string; network: string }) {
      options.calls?.push('verifyPSBT');
      assert.equal(input.network, BITCOIN_NETWORK_NAME);
      assert.equal(input.kmcJSON, '{"isolated":"acceptance-only"}');
      assert(input.psbtBase64.length > 0);
      verifiedPsbtBase64 = input.psbtBase64;
      return options.verifyResult ?? {
        passed: true,
        pathId: '12'.repeat(32),
        satisfiedClause: 'isolated exact solo policy',
        nullifierStatus: [{ inputIndex: 0, available: true, message: 'fixture only' }],
      };
    },
    async signPSBT(input: {
      keyId: string;
      psbtBase64: string;
      kmcJSON: string;
      network: string;
      require2FA: boolean;
      finalizePsbt: boolean;
    }) {
      options.calls?.push('signPSBT');
      options.onSign?.();
      assert.equal(input.keyId, registration.keyId);
      assert.equal(input.psbtBase64, verifiedPsbtBase64);
      assert.equal(input.kmcJSON, '{"isolated":"acceptance-only"}');
      assert.equal(input.network, BITCOIN_NETWORK_NAME);
      assert.equal(input.require2FA, false);
      assert.equal(input.finalizePsbt, true);
      const signed = signPolicyLeafPsbt(input.psbtBase64, privateKey);
      let txHex = signed.txHex;
      if (options.mutateTransaction) {
        const transaction = bitcoin.Transaction.fromHex(txHex);
        transaction.outs[0]!.value -= 1n;
        txHex = transaction.toHex();
      }
      return {
        success: true,
        txHex,
        signedPSBT: signed.psbtBase64,
        pathId: '12'.repeat(32),
        policyRootHex: options.signingPolicyRoot ?? registration.policyRoot,
        satisfiedClause: 'isolated exact solo policy',
      };
    },
  } as unknown as SigbashClient;
}

function custodyKeyFor(item: SigbashRosterRegistration): SigbashCustodyKey {
  return {
    round: ROUND,
    keyId: item.keyId,
    keyIndex: item.keyIndex,
    policyId: item.policyId,
    policyRoot: item.policyRoot,
    bip328Xpub: item.bip328Xpub,
    poetJSON: { version: '1.1', policy: { operator: 'AND', children: [] } },
    recoveryKit: {
      version: 'sdk-recovery-v1',
      keyId: item.keyId,
      recoveryKEK: '31'.repeat(32),
      cekCiphertext: '32'.repeat(48),
      cekNonce: '33'.repeat(12),
      network: BITCOIN_NETWORK_NAME,
      createdAt: 1_786_000_000,
    },
  };
}
