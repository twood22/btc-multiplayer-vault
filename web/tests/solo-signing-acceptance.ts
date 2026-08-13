import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Buffer } from 'buffer';
import type { SigbashClient } from '@sigbash/sdk';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import {
  base58CheckEncode,
  deriveXpubChildPubkey,
  deterministicKeypair,
  SECP_ORDER,
  sha256Hex,
  tapLeafHash,
  xpubRootXonly,
} from '../../src/crypto.js';
import { BITCOIN_NETWORK } from '../../src/network.js';
import { psbtUnsignedTxid } from '../../src/psbt.js';
import {
  createPublishedRosterArtifact,
  publishedRosterDigest,
} from '../../src/roster-ceremony.js';
import { asSats, type VaultEconomics } from '../../src/types.js';
import {
  participantLeaveRounds,
  rosterEntry,
  type RosterEntry,
  type SigbashRosterRegistration,
} from '../../src/vault.js';
import type { SigbashCustodyKey } from '../lib/client/sigbash-custody.js';
import {
  signAuthorizedSoloWithdrawal,
  unlockPublishedVault,
} from '../lib/client/vault-signing.js';

bitcoin.initEccLib(ecc);

const IDS = ['alice', 'bob', 'carol'];
const VAULT_ID = 'f1248f25-7d25-4774-9ad0-5ce5c87ddf5d';
const ROUND = 'alicebobcarol';
const ALICE_SECRET = participantSecret('alice');
const fixture = liveRosterFixture();
const economics = tinyEconomics();
const artifact = createPublishedRosterArtifact(VAULT_ID, fixture.roster, economics);
const digest = publishedRosterDigest(artifact);
const unlocked = unlockPublishedVault({
  artifact,
  expectedDigest: digest,
  participantSecret: ALICE_SECRET,
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
  const keyMaterial = fixture.policyKeys.get(`alice:${ROUND}`)!;
  let verifiedPsbtBase64: string | undefined;
  return {
    async getKey(keyId: string) {
      options.calls?.push('getKey');
      assert.equal(keyId, registration.keyId);
      return {
        keyId: registration.keyId,
        keyIndex: registration.keyIndex,
        network: 'mainnet',
        policyRoot: options.getKeyPolicyRoot ?? registration.policyRoot,
        require2FA: false,
        kmcJSON: '{"isolated":"acceptance-only"}',
      };
    },
    async verifyPSBT(input: { psbtBase64: string; kmcJSON: string; network: string }) {
      options.calls?.push('verifyPSBT');
      assert.equal(input.network, 'mainnet');
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
      assert.equal(input.network, 'mainnet');
      assert.equal(input.require2FA, false);
      assert.equal(input.finalizePsbt, true);
      const signed = signPolicyLeafPsbt(input.psbtBase64, keyMaterial.childPrivateKey);
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

function signPolicyLeafPsbt(
  psbtBase64: string,
  privateKey: Buffer,
): { txHex: string; psbtBase64: string } {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
  const publicKey = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
  const xonly = publicKey.subarray(1);
  const leaf = psbt.data.inputs[0]?.tapLeafScript?.find((item) =>
    Buffer.from(item.script).toString('hex') === `20${xonly.toString('hex')}ac`,
  );
  if (!leaf) throw new Error('isolated signer could not find its policy leaf');
  psbt.signTaprootInput(0, {
    publicKey: xonly,
    sign(): Buffer { throw new Error('isolated signer is Schnorr-only'); },
    signSchnorr(hash: Buffer): Buffer {
      return Buffer.from(ecc.signSchnorr(hash, privateKey));
    },
  });
  assert.equal(psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature)), true);
  psbt.finalizeTaprootInput(0, tapLeafHash(Buffer.from(leaf.script)));
  return { txHex: psbt.extractTransaction().toHex(), psbtBase64: psbt.toBase64() };
}

function liveRosterFixture(): {
  roster: RosterEntry[];
  policyKeys: Map<string, { childPrivateKey: Buffer }>;
} {
  const policyKeys = new Map<string, { childPrivateKey: Buffer }>();
  const roster = IDS.map((id) => {
    const base = rosterEntry(id, participantSecret(id), IDS);
    const registrations = Object.fromEntries(participantLeaveRounds(id, IDS).map((round) => {
      const key = syntheticBip328Key(`${id}:${round}`);
      policyKeys.set(`${id}:${round}`, { childPrivateKey: key.childPrivateKey });
      return [round, {
        network: 'mainnet',
        keyId: String(participantLeaveRounds(id, IDS).indexOf(round)),
        keyIndex: participantLeaveRounds(id, IDS).indexOf(round),
        bip328Xpub: key.xpub,
        policyLeafXonlyPubkey: key.policyLeafXonly,
        identificationLeafXonlyPubkey: xpubRootXonly(key.xpub),
        policyRoot: sha256Hex(`solo-client-policy-root:${id}:${round}`),
        policyId: `${round}:${id}`,
      } satisfies SigbashRosterRegistration];
    }));
    return {
      ...base,
      sigbashLeafByRound: Object.fromEntries(
        Object.entries(registrations).map(([round, item]) => [round, item.policyLeafXonlyPubkey]),
      ),
      sigbashIdentificationLeafByRound: Object.fromEntries(
        Object.entries(registrations).map(([round, item]) => [round, item.identificationLeafXonlyPubkey]),
      ),
      sigbashRegistrationByRound: registrations,
    };
  });
  return { roster, policyKeys };
}

function syntheticBip328Key(label: string): {
  xpub: string;
  policyLeafXonly: string;
  childPrivateKey: Buffer;
} {
  const root = deterministicKeypair('solo-signing-acceptance', `${label}:root`);
  const rootPrivateKey = Buffer.from(root.privateKeyHex, 'hex');
  const chainCode = Buffer.from(sha256Hex(`solo-signing-chain:${label}`), 'hex');
  const xpub = base58CheckEncode(Buffer.concat([
    Buffer.from('0488b21e', 'hex'),
    Buffer.from([0]),
    Buffer.alloc(4),
    Buffer.alloc(4),
    chainCode,
    Buffer.from(root.publicKeyHex, 'hex'),
  ]));
  const first = derivePrivateChild(rootPrivateKey, chainCode, 0);
  const second = derivePrivateChild(first.privateKey, first.chainCode, 0);
  const policyLeafXonly = Buffer.from(ecc.pointFromScalar(second.privateKey, true)!).subarray(1).toString('hex');
  assert.equal(deriveXpubChildPubkey(xpub, [0, 0]).xonlyPubKeyHex, policyLeafXonly);
  return { xpub, policyLeafXonly, childPrivateKey: second.privateKey };
}

function derivePrivateChild(
  privateKey: Buffer,
  chainCode: Buffer,
  index: number,
): { privateKey: Buffer; chainCode: Buffer } {
  const publicKey = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
  const serializedIndex = Buffer.alloc(4);
  serializedIndex.writeUInt32BE(index);
  const digest = createHmac('sha512', chainCode)
    .update(Buffer.concat([publicKey, serializedIndex]))
    .digest();
  const tweak = digest.subarray(0, 32);
  const tweakNumber = BigInt(`0x${tweak.toString('hex')}`);
  if (tweakNumber === 0n || tweakNumber >= SECP_ORDER) throw new Error('invalid isolated BIP32 tweak');
  const child = ecc.privateAdd(privateKey, tweak);
  if (!child) throw new Error('invalid isolated BIP32 child');
  return { privateKey: Buffer.from(child), chainCode: digest.subarray(32) };
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
      network: 'mainnet',
      createdAt: 1_786_000_000,
    },
  };
}

function participantSecret(id: string): string {
  return `participant-${id}-solo-signing-acceptance-secret-material`;
}

function tinyEconomics(): VaultEconomics {
  return {
    depositSatsPerParticipant: asSats(10_000),
    firstWithdrawalSats: asSats(9_500),
    secondWithdrawalSats: asSats(10_250),
    soloFeeBudgetSats: asSats(2_000),
    soloWithdrawalFeeSats: asSats(300),
    cooperativeFeeSats: asSats(300),
    recoveryFeeSats: asSats(500),
    finalSweepFeeSats: asSats(300),
    recoveryDelayBlocks: 12,
  };
}
