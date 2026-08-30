import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Buffer } from 'buffer';
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
import { BITCOIN_NETWORK, BITCOIN_NETWORK_NAME } from '../../src/network.js';
import {
  createPublishedRosterArtifact,
  publishedRosterDigest,
  type PublishedRosterArtifact,
} from '../../src/roster-ceremony.js';
import { asSats, type VaultEconomics } from '../../src/types.js';
import {
  participantLeaveRounds,
  rosterEntry,
  type RosterEntry,
  type SigbashRosterRegistration,
} from '../../src/vault.js';

bitcoin.initEccLib(ecc);

export const SOLO_PARTICIPANTS = ['alice', 'bob', 'carol'] as const;
export const SOLO_ROUND = 'alicebobcarol';

export interface IsolatedSoloFixture {
  artifact: PublishedRosterArtifact;
  digest: string;
  participantSecrets: Record<(typeof SOLO_PARTICIPANTS)[number], string>;
  policyPrivateKeys: Map<string, Buffer>;
}

export function createIsolatedSoloFixture(vaultId: string): IsolatedSoloFixture {
  const participantIds = [...SOLO_PARTICIPANTS];
  const participantSecrets = Object.fromEntries(SOLO_PARTICIPANTS.map((id) => [
    id,
    `participant-${id}-isolated-solo-signing-secret-material`,
  ])) as IsolatedSoloFixture['participantSecrets'];
  const policyPrivateKeys = new Map<string, Buffer>();
  const roster: RosterEntry[] = SOLO_PARTICIPANTS.map((id) => {
    const base = rosterEntry(id, participantSecrets[id], participantIds);
    const rounds = participantLeaveRounds(id, participantIds);
    const registrations = Object.fromEntries(rounds.map((round, keyIndex) => {
      const key = syntheticBip328Key(`${vaultId}:${id}:${round}`);
      policyPrivateKeys.set(`${id}:${round}`, key.childPrivateKey);
      return [round, {
        network: BITCOIN_NETWORK_NAME,
        keyId: String(keyIndex),
        keyIndex,
        bip328Xpub: key.xpub,
        policyLeafXonlyPubkey: key.policyLeafXonly,
        identificationLeafXonlyPubkey: xpubRootXonly(key.xpub),
        policyRoot: sha256Hex(`isolated-solo-policy-root:${vaultId}:${id}:${round}`),
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
  const artifact = createPublishedRosterArtifact(vaultId, roster, tinyEconomics());
  return {
    artifact,
    digest: publishedRosterDigest(artifact),
    participantSecrets,
    policyPrivateKeys,
  };
}

export function signPolicyLeafPsbt(
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

function syntheticBip328Key(label: string): {
  xpub: string;
  policyLeafXonly: string;
  childPrivateKey: Buffer;
} {
  const root = deterministicKeypair('isolated-solo-signing', `${label}:root`);
  const rootPrivateKey = Buffer.from(root.privateKeyHex, 'hex');
  const chainCode = Buffer.from(sha256Hex(`isolated-solo-chain:${label}`), 'hex');
  const xpub = base58CheckEncode(Buffer.concat([
    Buffer.from(BITCOIN_NETWORK_NAME === 'mainnet' ? '0488b21e' : '043587cf', 'hex'),
    Buffer.from([0]),
    Buffer.alloc(4),
    Buffer.alloc(4),
    chainCode,
    Buffer.from(root.publicKeyHex, 'hex'),
  ]));
  const first = derivePrivateChild(rootPrivateKey, chainCode, 0);
  const second = derivePrivateChild(first.privateKey, first.chainCode, 0);
  const policyLeafXonly = Buffer.from(ecc.pointFromScalar(second.privateKey, true)!)
    .subarray(1)
    .toString('hex');
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
