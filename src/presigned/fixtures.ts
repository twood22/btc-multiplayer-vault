/** PUBLIC, DETERMINISTIC OFFLINE TEST FIXTURES. NEVER FUND ON A PUBLIC NETWORK. */
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { deterministicKeypair, taggedHash } from '../crypto.js';
import { asSats, type BitcoinNetworkName } from '../types.js';
import { buildPresignedGraph } from './graph.js';
import { authorizePresignedFundingSignedPsbt, finalizePresignedFunding } from './funding.js';
import { derivePresignedParticipantKeys } from './roster.js';
import { createPreauthorizations } from './signing.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedParticipantKeys, type PresignedRoster } from './types.js';
import { genesisHash, networkParameters } from './validation.js';

export function createPresignedFixture(input: { walletKinds?: ('p2wpkh' | 'p2tr')[]; network?: BitcoinNetworkName } = {}) {
  const vaultId = '22222222-2222-4222-8222-222222222222';
  const participantSecrets = Object.fromEntries(PARTICIPANT_IDS.map((id, index) => [id, Buffer.alloc(32, index + 1).toString('base64url')])) as Record<ParticipantId, string>;
  const derived = PARTICIPANT_IDS.map(id => derivePresignedParticipantKeys(participantSecrets[id], id, vaultId));
  const keysById = Object.fromEntries(derived.map(item => [item.publicIdentity.id, item.keys])) as Record<ParticipantId, PresignedParticipantKeys>;
  const network = input.network ?? 'signet';
  const roster: PresignedRoster = { version: 2, protocol: PRESIGNED_PROTOCOL, vaultId, network, genesisHash: genesisHash(network),
    economics: { depositSatsPerParticipant: asSats(10_000), firstWithdrawalSats: asSats(9500), secondWithdrawalSats: asSats(10_250),
      soloWithdrawalFeeSats: asSats(300), soloFeeBudgetSats: asSats(2000), cooperativeFeeSats: asSats(300),
      recoveryFeeSats: asSats(500), finalSweepFeeSats: asSats(300), recoveryDelayBlocks: 12 },
    feePolicy: { kind: 'confirmed-truc-payout-cpfp-v1', maxChildFeeSats: 100_000 }, participants: derived.map(item => item.publicIdentity) };
  const wallets = PARTICIPANT_IDS.map((id, index) => {
    const pair = deterministicKeypair('public-presigned-v2-offline-fixture', `${id}:external-wallet`);
    const kind = input.walletKinds?.[index] ?? (index === 1 ? 'p2wpkh' : 'p2tr');
    const privateKey = Buffer.from(pair.privateKeyHex, 'hex');
    const publicKey = Buffer.from(pair.publicKeyHex, 'hex');
    const payment = kind === 'p2wpkh' ? bitcoin.payments.p2wpkh({ pubkey: publicKey, network: networkParameters(network) })
      : bitcoin.payments.p2tr({ internalPubkey: publicKey.subarray(1), network: networkParameters(network) });
    return { id, kind, privateKey, publicKey, scriptPubKeyHex: Buffer.from(payment.output!).toString('hex') };
  });
  const walletKeys = Object.fromEntries(wallets.map(wallet => [wallet.id, wallet])) as Record<ParticipantId, typeof wallets[number]>;
  const graph = buildPresignedGraph({ roster, funding: { epochId: '33333333-3333-4333-8333-333333333333', feeSats: 600,
    inputs: wallets.map((wallet, index) => ({ participantId: wallet.id, txid: String(index + 1).padStart(64, '0'), vout: 0,
      valueSats: 12_000, scriptPubKeyHex: wallet.scriptPubKeyHex, changeScriptPubKeyHex: wallet.scriptPubKeyHex,
      confirmationBlockHash: '44'.repeat(32), confirmations: 6 })) } });
  return { graph, roster: graph.roster, keysById, participantSecrets, walletKeys };
}

export function preauthorizePresignedFixture(fixture: ReturnType<typeof createPresignedFixture>) {
  return PARTICIPANT_IDS.flatMap(id => createPreauthorizations({ graph: fixture.graph, participantId: id,
    privateKeys: fixture.keysById[id].soloPrivateKeys, approvedGraphDigest: fixture.graph.digest }));
}

export function signPresignedFixtureFunding(fixture: ReturnType<typeof createPresignedFixture>) {
  const signatures = PARTICIPANT_IDS.map(id => {
    const graph = fixture.graph;
    const wallet = fixture.walletKeys[id];
    const index = graph.funding.inputs.findIndex(coin => coin.participantId === id);
    const psbt = bitcoin.Psbt.fromBase64(graph.fundingPsbtBase64, { network: networkParameters(graph.roster.network) });
    if (wallet.kind === 'p2wpkh') psbt.signInput(index, { publicKey: wallet.publicKey, sign: hash => ecc.sign(hash, wallet.privateKey) });
    else {
      // Supplied by the external wallet, not required from the coordinator.
      psbt.updateInput(index, { tapInternalKey: wallet.publicKey.subarray(1) });
      const tweak = taggedHash('TapTweak', wallet.publicKey.subarray(1));
      const even = wallet.publicKey[0] === 3 ? ecc.privateNegate(wallet.privateKey) : wallet.privateKey;
      const tweaked = ecc.privateAdd(even, tweak)!;
      psbt.signInput(index, { publicKey: Buffer.from(ecc.pointFromScalar(tweaked, true)!),
        sign: () => { throw new Error('fixture Taproot signer does not sign ECDSA'); },
        signSchnorr: hash => ecc.signSchnorr(hash, tweaked) });
    }
    return authorizePresignedFundingSignedPsbt({ graph, participantId: id, signedPsbtBase64: psbt.toBase64(), approvedGraphDigest: graph.digest });
  });
  return finalizePresignedFunding({ graph: fixture.graph, signatures });
}
