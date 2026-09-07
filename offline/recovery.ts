import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { parsePresignedOfflineBackup, presignedBackupBinding, verifyPresignedKitRestoration,
  withRestoredPresignedOfflineBackup, type PresignedBackupBinding, type PresignedOfflineBackup } from '../src/presigned/backup.js';
import { buildPresignedFeeDraft, validatePresignedFeePackage, type PresignedFeeDraft, type PresignedFeePackage } from '../src/presigned/fee-package.js';
import { signPresignedFeePayout } from '../src/presigned/fees.js';
import { presignedObservedFeeCoin, validatePresignedCoinObservations, type PresignedCoinObservations } from '../src/presigned/coin-observations.js';
import { authorizePresignedFundingFeeWalletPsbt, type PresignedFundingFeeSignature, type PresignedFundingFeeRole } from '../src/presigned/funding-fees.js';
import { finalizePresignedOfflineExchange, mergePresignedOfflineExchanges, newPresignedOfflineExchange,
  parsePresignedOfflinePublicJson, validatePresignedOfflineExchange, validatePresignedOfflineTransaction,
  type PresignedOfflineExchange, type PresignedOfflineTransaction } from '../src/presigned/offline.js';
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys } from '../src/presigned/roster.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { signPresignedSpendFeePayout } from '../src/presigned/spend-fees.js';
import { buildPresignedSpend, createPresignedCooperativeNonce, createPresignedRecoveryContribution,
  signPresignedCooperativePartial, signPresignedFinalSweep, validatePresignedCooperativeNonces,
  type PresignedSpendProposal } from '../src/presigned/spends.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedParticipantKeys, type PresignedPublicKit } from '../src/presigned/types.js';
import { assert, canonicalJson, commitmentDigest, hexBytes, networkParameters, sameCanonical } from '../src/presigned/validation.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => element<HTMLInputElement>(id);
const value = (id: string) => field(id).value.trim();
const select = (id: string) => element<HTMLSelectElement>(id);
const show = (id: string, data: unknown) => { element(id).textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2); };
let busy = false;
let envelope: PresignedOfflineBackup | null = null;
let binding: PresignedBackupBinding | null = null;
let kit: PresignedPublicKit | null = null;
let participant: ParticipantId | null = null;
let proposal: PresignedSpendProposal | null = null;
let soloExitId: string | null = null;
let exchange: PresignedOfflineExchange | null = null;
let secretNonce: ReturnType<typeof createPresignedCooperativeNonce> | null = null;
let nonceAttempted = false;
let transaction: PresignedOfflineTransaction | null = null;
let observations: PresignedCoinObservations | null = null;
let feeDraft: PresignedFeeDraft | null = null;
let payoutSignatureHex = '';
let sponsorSignedPsbtBase64 = '';
let fundingFeeSignatures: PresignedFundingFeeSignature[] = [];

function guard() {
  assert(location.protocol === 'file:', 'save and open this utility as a local file before using it');
  assert(window.isSecureContext && crypto.subtle, 'this browser cannot run local-file WebCrypto safely');
}
function requireKit(): PresignedPublicKit {
  guard(); assert(kit && binding && participant, 'verify your saved kit and independent commitments first');
  return kit;
}
function requireReview() {
  requireKit(); assert(field('reviewed').checked, 'review and explicitly approve this exact source, payouts, age and fee first');
}
function requireFeeReview() {
  requireKit(); assert(feeDraft && field('fee-reviewed').checked, 'rebuild, review and explicitly approve this exact fee child first');
}
function burnNonce() { secretNonce?.secretNonce.fill(0); secretNonce = null; }
function resetSpend() {
  burnNonce(); nonceAttempted = false; proposal = null; soloExitId = null; exchange = null;
  field('reviewed').checked = false; show('review', 'Rebuild and independently review the selected spend.'); updatePeer();
}
function resetFee() {
  feeDraft = null; payoutSignatureHex = ''; sponsorSignedPsbtBase64 = ''; fundingFeeSignatures = [];
  field('fee-reviewed').checked = false; field('wallet-fee-psbt').value = ''; show('fee-review', 'No fee draft.');
}
function forget() {
  resetSpend(); resetFee(); kit = null; binding = null; participant = null; envelope = null; transaction = null; observations = null;
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) {
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = false;
    else input.value = '';
  }
  // Reset public numeric controls to their visible defaults after forgetting
  // secrets. Blank numeric inputs would otherwise become zero and make a new
  // restored kit's first fee draft invalid without a useful review screen.
  for (const id of ['sponsor-vout','child-fee','fee-cap','target-rate','relay-rate','incremental-rate'])
    field(id).value = field(id).defaultValue;
  for (const id of ['spending','transactions','fees']) element(id).hidden = true;
  show('binding', 'No file selected.'); show('transaction-review', 'No finalized transaction.');
}
async function run(action: () => void | Promise<void>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
  try { guard(); await action(); }
  catch (error) {
    const detail = error instanceof Error && error.message.startsWith('presigned-v2:')
      ? error.message : 'Operation failed. Check the selected file, recovery key, commitments and signatures. No transaction was broadcast.';
    show('status', detail);
  } finally {
    busy = false;
    document.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; });
  }
}
function click(id: string, action: () => void | Promise<void>) { element(id).addEventListener('click', () => { void run(action); }); }
function file(id: string, action: (raw: string) => void | Promise<void>, maximum = 1_048_576) {
  field(id).addEventListener('change', () => { void run(async () => {
    const selected = field(id).files?.[0]; assert(selected && selected.size <= maximum, 'select a bounded local file');
    try { await action(await selected.text()); } finally { field(id).value = ''; }
  }); });
}
function save(name: string, contents: unknown, raw = false) {
  const url = URL.createObjectURL(new Blob([raw ? String(contents) : canonicalJson(contents)], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function privateAction<T>(action: (keys: PresignedParticipantKeys, secret: string, publicKit: PresignedPublicKit) => T | Promise<T>): Promise<T> {
  guard(); assert(envelope && binding, 'select your encrypted file and independent commitments first');
  const raw = value('secret'); field('secret').value = '';
  assert(/^[A-Za-z0-9_-]{43}$/u.test(raw), 're-enter the exact separate 43-character recovery key');
  const bytes = Uint8Array.from(Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64'));
  assert(bytes.length === 32 && Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') === raw,
    'recovery key has another length or a noncanonical encoding');
  try {
    return await withRestoredPresignedOfflineBackup({ envelope, expectedBinding: binding, offlineSecret: bytes, action: async restored => {
      const derived = derivePresignedParticipantKeys(restored.participantSecret, restored.participantId, restored.publicKit.graph.roster.vaultId);
      try { return await action(derived.keys, restored.participantSecret, restored.publicKit); }
      finally { clearPresignedParticipantKeys(derived.keys); }
    } });
  } finally { bytes.fill(0); }
}
function updateSources() {
  resetSpend(); const publicKit = requireKit(); const graph = publicKit.graph; const kind = value('spend-kind');
  const choices = kind === 'solo' ? graph.exits.filter(exit => exit.leaver === participant).map(exit => [exit.id, `Exit order ${exit.id}`])
    : kind === 'final-sweep' ? graph.exits.filter(exit => exit.finalParticipant === participant).map(exit => [exit.id, `Final payout after ${exit.id}`])
      : [['', 'Original three-person vault'], ...graph.exits.filter(exit => exit.parentExitId === null && exit.leaver !== participant)
        .map(exit => [exit.id, `Remaining pair after ${exit.id}`])];
  select('source').replaceChildren(...choices.map(([id, name]) => new Option(name, id)));
}
function reviewSpend() {
  resetSpend(); const publicKit = requireKit(); const graph = publicKit.graph;
  const kind = value('spend-kind'); const source = value('source');
  if (kind === 'solo') {
    const exit = graph.exits.find(item => item.id === source && item.leaver === participant);
    assert(exit, 'selected solo exit does not belong to this participant'); soloExitId = exit.id;
    show('review', { kind, graphDigest: graph.digest, exitId: exit.id, txid: exit.txid,
      source: `${exit.inputTxid}:${exit.inputVout}`, feeSats: exit.feeSats, outputs: txOutputs(exit.unsignedTxHex) });
  } else {
    assert(['cooperative','recovery','final-sweep'].includes(kind), 'unknown spend kind');
    proposal = buildPresignedSpend({ graph, proposalId: crypto.randomUUID(),
      kind: kind as PresignedSpendProposal['kind'], sourceExitId: source || null });
    assert(proposal.participantIds.includes(participant!), 'you are not a participant in this exact source');
    if (kind !== 'final-sweep') exchange = newPresignedOfflineExchange(graph, proposal);
    show('review', { kind, proposalId: proposal.proposalId, proposalDigest: proposal.digest, graphDigest: graph.digest,
      txid: proposal.txid, source: proposal.source, threshold: proposal.threshold, feeSats: proposal.feeSats,
      minimumSourceConfirmations: kind === 'recovery' ? graph.roster.economics.recoveryDelayBlocks : 1,
      outputs: txOutputs(proposal.unsignedTxHex) });
  }
  updatePeer(); show('status', 'Fixed transaction rebuilt. Check the source and outputs independently before signing.');
}
function txOutputs(hex: string) {
  const graph = requireKit().graph;
  return bitcoin.Transaction.fromHex(hex).outs.map((output, vout) => ({ vout, valueSats: Number(output.value),
    scriptPubKeyHex: Buffer.from(output.script).toString('hex'), address: bitcoin.address.fromOutputScript(output.script, networkParameters(graph.roster.network)) }));
}
function updatePeer() {
  show('peer-status', exchange ? { proposalId: exchange.proposal.proposalId, proposalDigest: exchange.proposal.digest,
    publicNonceSigners: exchange.publicNonces.map(item => item.participantId), partialSigners: exchange.partials.map(item => item.participantId),
    recoverySigners: exchange.recoveryContributions.map(item => item.participantId), nonceHeldOnlyInThisPage: Boolean(secretNonce), nonceAttempted } : 'No peer exchange.');
}
function addToExchange(changes: Partial<Pick<PresignedOfflineExchange, 'publicNonces' | 'partials' | 'recoveryContributions'>>) {
  const publicKit = requireKit(); assert(exchange, 'prepare or import a public peer proposal first');
  exchange = mergePresignedOfflineExchanges(publicKit, exchange, { ...exchange, ...changes }); updatePeer();
}
function setTransaction(value: PresignedOfflineTransaction) {
  transaction = validatePresignedOfflineTransaction(requireKit(), value); resetFee();
  show('transaction-review', { kind: transaction.kind, graphDigest: transaction.graphDigest, txid: transaction.txid,
    outputs: txOutputs(transaction.transactionHex), signedBytesReadyForIndependentCoreVerification: true });
  show('status', 'Exact transaction and signatures verified locally. Nothing was broadcast. Save the public transaction before closing this page.');
}
function publicTransaction(kind: PresignedOfflineTransaction['kind'], signed: { txid: string; transactionHex: string },
  spend: PresignedSpendProposal | null = null, exitId: string | null = null) {
  setTransaction({ version: 2, protocol: PRESIGNED_PROTOCOL, format: 'presigned-offline-transaction-v1',
    graphDigest: requireKit().graph.digest, kind, proposal: spend, exitId,
    txid: signed.txid, transactionHex: signed.transactionHex } as PresignedOfflineTransaction);
}

file('backup', raw => {
  forget(); envelope = parsePresignedOfflineBackup(raw); show('binding', envelope.binding);
  show('status', 'File header inspected, not yet authenticated. Enter the independently saved commitments and separate recovery key.');
}, 720 * 1024);
click('verify', async () => {
  assert(envelope, 'select your encrypted recovery file first');
  hexBytes(value('expected-graph'), 32, 'independently saved graph digest'); hexBytes(value('expected-funding'), 32, 'independently saved funding ID');
  binding = { ...envelope.binding, graphDigest: value('expected-graph'), fundingTxid: value('expected-funding') };
  const verified = await privateAction((_keys, secret, publicKit) => {
    const proof = verifyPresignedKitRestoration({ publicKit, participantId: envelope!.binding.participantId,
      participantSecret: secret, expectedBinding: binding! });
    return { proof, publicKit };
  });
  kit = verified.publicKit; participant = binding.participantId;
  sameCanonical(presignedBackupBinding(kit, participant), binding, 'offline independently pinned binding');
  show('binding', { ...binding, verifiedOwnerExits: verified.proof.exitProofs.map(item => item.exitId), proofDigest: verified.proof.proofDigest });
  for (const id of ['spending','transactions','fees']) element(id).hidden = false;
  updateSources(); show('status', 'Kit authenticated. All three of your owner exits were completed and verified locally; their witnesses were discarded. Select only the spend you intend to release.');
});
click('forget', () => { forget(); show('status', 'Session forgotten. No secrets or nonces were stored.'); });
select('spend-kind').addEventListener('change', () => { void run(updateSources); });
select('source').addEventListener('change', () => { void run(resetSpend); });
click('prepare', reviewSpend);
click('sign-single', async () => {
  requireReview(); const publicKit = requireKit(); const graph = publicKit.graph;
  if (soloExitId) {
    const exit = graph.exits.find(item => item.id === soloExitId)!;
    const signed = await privateAction(keys => completePresignedExit({ graph, preauthorizations: publicKit.preauthorizations,
      exitId: exit.id, participantId: participant!, privateKey: keys.soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest }));
    publicTransaction('solo', signed, null, exit.id);
  } else {
    assert(proposal?.kind === 'final-sweep', 'select your solo exit or final-owner sweep');
    const spend = proposal;
    const signed = await privateAction(keys => signPresignedFinalSweep({ graph, proposal: spend, participantId: participant!,
      payoutPrivateKey: keys.payoutPrivateKey, approvedProposalDigest: spend.digest }));
    publicTransaction('final-sweep', signed, spend);
  }
});
file('peer', raw => {
  const publicKit = requireKit(); const incoming = validatePresignedOfflineExchange(publicKit, parsePresignedOfflinePublicJson(raw));
  assert(incoming.proposal.participantIds.includes(participant!), 'this peer proposal belongs to another round');
  if (!exchange) { resetSpend(); exchange = incoming; proposal = incoming.proposal; }
  else { exchange = mergePresignedOfflineExchanges(publicKit, exchange, incoming); proposal = exchange.proposal; }
  // A peer file can add only append-only public contributions. Still require
  // the user to review the exact proposal again before any private-key action.
  field('reviewed').checked = false;
  show('review', { proposalId: proposal.proposalId, proposalDigest: proposal.digest, kind: proposal.kind,
    source: proposal.source, txid: proposal.txid, feeSats: proposal.feeSats, threshold: proposal.threshold,
    minimumSourceConfirmations: proposal.kind === 'recovery' ? publicKit.graph.roster.economics.recoveryDelayBlocks : 1,
    outputs: txOutputs(proposal.unsignedTxHex) }); updatePeer(); show('status', 'Public peer contributions verified. Compare the exact proposal ID and digest with the other signers.');
});
click('nonce', async () => {
  requireReview(); assert(exchange?.proposal.kind === 'cooperative' && !nonceAttempted && !secretNonce &&
    !exchange.publicNonces.some(item => item.participantId === participant), 'this proposal already has your nonce; continue it or start a fresh proposal');
  const spend = exchange.proposal; nonceAttempted = true;
  try {
    secretNonce = await privateAction(keys => createPresignedCooperativeNonce({ graph: requireKit().graph,
      proposal: spend, participantId: participant!, personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: spend.digest }));
    addToExchange({ publicNonces: [...exchange.publicNonces, secretNonce.publicNonce] });
  } catch (error) { burnNonce(); throw error; }
  show('status', 'Public nonce added. Save and exchange the public peer file. Keep this page open; its secret nonce cannot be restored.');
});
click('partial', async () => {
  requireReview(); assert(exchange?.proposal.kind === 'cooperative' && secretNonce, 'this page has no unconsumed secret nonce; begin a fresh proposal if it was lost');
  validatePresignedCooperativeNonces({ graph: requireKit().graph, proposal: exchange.proposal, publicNonces: exchange.publicNonces });
  // Remove the sole live reference BEFORE decrypting the participant key. It
  // never went to disk or browser storage, and no file can restore it.
  const consumed = secretNonce; secretNonce = null;
  const current = exchange;
  try {
    const partial = await privateAction(keys => signPresignedCooperativePartial({ graph: requireKit().graph, proposal: current.proposal,
      participantId: participant!, personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: current.proposal.digest,
      publicNonces: current.publicNonces, nonceBinding: consumed.binding, consumedSecretNonce: consumed.secretNonce }));
    addToExchange({ partials: [...current.partials, partial] });
  } finally { consumed.secretNonce.fill(0); updatePeer(); }
  show('status', 'Nonce consumed and partial verified. Save the updated public peer file. Do not restart this same nonce from any snapshot.');
});
click('recovery-share', async () => {
  requireReview(); assert(exchange?.proposal.kind === 'recovery', 'prepare or import a timelocked recovery proposal');
  assert(!exchange.recoveryContributions.some(item => item.participantId === participant), 'your recovery contribution is already present');
  const current = exchange;
  const contribution = await privateAction(keys => createPresignedRecoveryContribution({ graph: requireKit().graph, proposal: current.proposal,
    participantId: participant!, personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: current.proposal.digest }));
  addToExchange({ recoveryContributions: [...current.recoveryContributions, contribution] });
  show('status', 'Recovery contribution verified. Save and exchange the public peer file; Core still enforces CSV maturity.');
});
click('export-peer', () => {
  assert(exchange, 'no public peer exchange to save'); validatePresignedOfflineExchange(requireKit(), exchange);
  save(`presigned-peer-${exchange.proposal.proposalId}-${participant}.json`, exchange);
});
click('finalize-peer', () => {
  requireReview(); assert(exchange, 'no peer exchange to finalize');
  const signed = finalizePresignedOfflineExchange(requireKit(), exchange);
  publicTransaction(exchange.proposal.kind, signed, exchange.proposal);
});
file('transaction-file', raw => setTransaction(validatePresignedOfflineTransaction(requireKit(), parsePresignedOfflinePublicJson(raw))));
click('import-funding', () => {
  const graph = requireKit().graph; const transactionHex = value('funding-hex');
  assert(/^[0-9a-f]+$/u.test(transactionHex) && transactionHex.length <= 20_000, 'funding hex is missing, invalid or too large');
  publicTransaction('funding', { txid: graph.fundingTxid, transactionHex });
  field('funding-hex').value = '';
});
click('save-transaction', () => { assert(transaction, 'no finalized transaction to save'); save(`presigned-${transaction.kind}-${transaction.txid}.json`, transaction); });
click('save-hex', () => { assert(transaction, 'no finalized transaction to save'); save(`presigned-${transaction.txid}.hex.txt`, transaction.transactionHex, true); });

// Fee actions below are all local. Imported observation truth is the user's
// independent-Core responsibility; signatures bind the exact immutable economics.
file('fee-observations', raw => {
  observations = null; resetFee();
  observations = validatePresignedCoinObservations(requireKit().graph, parsePresignedOfflinePublicJson(raw));
  show('status', `Loaded ${observations.coins.length} public coin observations at height ${observations.tip.height}, observed ${observations.observedAt}. This offline file cannot prove that their blocks remain active or coins remain spendable.`);
});
click('build-fee', () => {
  const publicKit = requireKit(); assert(transaction, 'sign or import the exact parent transaction first');
  validatePresignedOfflineTransaction(publicKit, transaction);
  const graph = publicKit.graph;
  assert(observations, 'import independent private-Core coin observations first');
  const report = validatePresignedCoinObservations(graph, observations);
  const find = (txid: string, vout: number) => presignedObservedFeeCoin(report, txid, vout, transaction!.txid);
  const priorChild = value('previous-child');
  assert(priorChild.length <= 20_000, 'previous fee child is too large');
  const sponsorInput = presignedObservedFeeCoin(report, value('sponsor-txid'), Number(value('sponsor-vout')),
    priorChild ? bitcoin.Transaction.fromHex(priorChild).getId() : null);
  const approval = { childFeeSats: Number(value('child-fee')), maxChildFeeSats: Number(value('fee-cap')),
    targetPackageRateMillisatsPerVbyte: Number(value('target-rate')), minRelayRateMillisatsPerVbyte: Number(value('relay-rate')),
    sponsorChangeScriptPubKeyHex: sponsorInput.scriptPubKeyHex, approveExactNoChangeFee: false,
    replacement: priorChild ? { previousChildTransactionHex: priorChild,
      incrementalRelayRateMillisatsPerVbyte: Number(value('incremental-rate')) } : null };
  // Same-wallet sponsor change is deliberately fixed by this utility. There is
  // no arbitrary destination field and no implicit consume-the-whole-coin fee.
  const base = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, epochId: graph.funding.epochId,
    ownerParticipantId: participant!, parentAuthorityDigest: commitmentDigest('vault/presigned-graph-v2/offline-parent', transaction) };
  resetFee();
  if (transaction.kind === 'funding') feeDraft = { ...base, mode: 'funding', proposalId: null,
    request: { graph, fundingTransactionHex: transaction.transactionHex, changeParticipantId: participant!,
      fundingInputObservations: graph.funding.inputs.map(coin => find(coin.txid, coin.vout)), sponsorInput, approval } };
  else if (transaction.kind === 'solo') {
    const exit = graph.exits.find(item => item.id === transaction!.exitId)!;
    feeDraft = { ...base, mode: 'solo', proposalId: crypto.randomUUID(), request: { graph, exitId: exit.id,
      parentTransactionHex: transaction.transactionHex, roundInputObservation: find(exit.inputTxid, exit.inputVout), sponsorInput, approval } };
  } else feeDraft = { ...base, mode: 'spend', proposalId: transaction.proposal.proposalId,
    request: { graph, parentSpendProposal: transaction.proposal, parentTransactionHex: transaction.transactionHex,
      payoutParticipantId: participant!, sourceObservation: find(transaction.proposal.source.txid, transaction.proposal.source.vout), sponsorInput, approval } };
  reviewFee();
});
function reviewFee() {
  const publicKit = requireKit(); assert(feeDraft, 'no fee draft');
  sameCanonical(feeDraft.request.graph, publicKit.graph, 'offline fee graph');
  assert(feeDraft.ownerParticipantId === participant, 'fee draft uses another payout owner');
  assert(feeDraft.request.approval.sponsorChangeScriptPubKeyHex === feeDraft.request.sponsorInput.scriptPubKeyHex &&
    feeDraft.request.approval.approveExactNoChangeFee === false, 'this offline utility requires preserved same-wallet sponsor change');
  const built = buildPresignedFeeDraft(feeDraft);
  show('fee-review', { mode: feeDraft.mode, approvalDigest: built.approvalDigest, parentTxid: built.parentTxid,
    childTxid: built.unsignedTxid, preservedPayoutOrRefundSats: 'payoutSats' in built ? built.payoutSats : built.changeSats,
    childFeeSats: built.childFeeSats, sponsorChangeSats: built.sponsorChangeSats,
    maximumChildVsize: built.maximumChildVsize, approval: feeDraft.request.approval, outputs: txOutputs(feeUnsignedHex(built.psbtBase64)) });
  show('status', 'Exact fee child rebuilt. Save the public draft and inspect its coins, outputs and fee before signing.');
}
function feeUnsignedHex(psbtBase64: string) { return Buffer.from(bitcoin.Psbt.fromBase64(psbtBase64).data.globalMap.unsignedTx.toBuffer()).toString('hex'); }
file('fee-draft-file', raw => {
  resetFee(); feeDraft = parsePresignedOfflinePublicJson(raw) as PresignedFeeDraft; reviewFee();
});
click('save-fee-draft', () => { assert(feeDraft, 'no fee draft'); reviewFee(); save('presigned-offline-fee-draft.json', feeDraft); });
click('save-fee-psbt', () => {
  assert(feeDraft, 'no fee draft'); reviewFee(); const built = buildPresignedFeeDraft(feeDraft);
  const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
  const parent = feeDraft.mode === 'funding' ? feeDraft.request.fundingTransactionHex : feeDraft.request.parentTransactionHex;
  psbt.updateInput(0, { nonWitnessUtxo: Buffer.from(parent, 'hex') });
  save('presigned-offline-fee-unsigned.psbt.txt', psbt.toBase64(), true);
});
click('sign-fee', async () => {
  requireFeeReview(); const draft = feeDraft!; assert(draft.mode !== 'funding', 'a funding refund requires its original external wallet, never a participant key');
  const built = buildPresignedFeeDraft(draft);
  payoutSignatureHex = (await privateAction(keys => draft.mode === 'solo'
    ? signPresignedFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys })
    : signPresignedSpendFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys }))).payoutSignatureHex;
  show('status', 'Your detached payout signature is ready. Import the external sponsor wallet’s signed PSBT to finalize.');
});
click('import-fee-wallet', () => {
  requireFeeReview(); const draft = feeDraft!; const built = buildPresignedFeeDraft(draft); const signed = value('wallet-fee-psbt');
  assert(signed.length > 0 && signed.length <= 200_000, 'wallet PSBT is missing or too large');
  if (draft.mode === 'funding') {
    const contributions = authorizePresignedFundingFeeWalletPsbt({ request: draft.request,
      roles: value('funding-roles').split(',') as PresignedFundingFeeRole[], signedPsbtBase64: signed, approvalDigest: built.approvalDigest });
    for (const item of contributions) {
      const previous = fundingFeeSignatures.find(other => other.role === item.role);
      if (previous) sameCanonical(previous, item, 'retained funding fee wallet contribution');
      else fundingFeeSignatures.push(item);
    }
  } else {
    assert(payoutSignatureHex, 'sign your payout portion before verifying the sponsor wallet PSBT');
    validatePresignedFeePackage({ ...draft, signatures: { payoutSignatureHex, sponsorSignedPsbtBase64: signed } });
    sponsorSignedPsbtBase64 = signed;
  }
  field('wallet-fee-psbt').value = ''; show('status', 'External wallet signature(s) verified against the exact child and explicit roles.');
});
click('finalize-fee', () => {
  requireFeeReview(); const draft = feeDraft!;
  const packageValue = { ...draft, signatures: draft.mode === 'funding' ? fundingFeeSignatures :
    { payoutSignatureHex, sponsorSignedPsbtBase64 } } as PresignedFeePackage;
  const checked = validatePresignedFeePackage(packageValue);
  save('presigned-offline-signed-fee-package.json', checked.package);
  save('presigned-offline-signed-fee-transactions.json', { version: 2, protocol: PRESIGNED_PROTOCOL,
    format: 'presigned-offline-fee-transactions-v1', network: requireKit().graph.roster.network,
    genesisHash: requireKit().graph.roster.genesisHash, packageDigest: checked.packageDigest,
    parentTxid: checked.completed.parentTxid, childTxid: checked.completed.txid,
    transactionHexes: [checked.parentTransactionHex, checked.completed.transactionHex] });
  show('status', 'Signed parent and child saved. Independently verify their current coins and Core policy. Nothing was broadcast.');
});

window.addEventListener('pagehide', () => { burnNonce(); field('secret').value = ''; });
try { guard(); show('status', 'Local cryptography ready. No network connection or service login is used.'); }
catch { document.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
  show('status', 'Save and open this utility as a local file in a browser with local-file WebCrypto support. Do not enter a recovery key on a remotely served page.'); }
