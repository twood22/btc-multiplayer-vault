import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { parsePresignedOfflineBackup, presignedBackupBinding, verifyPresignedKitRestoration,
  withRestoredPresignedOfflineBackup, type PresignedBackupBinding, type PresignedOfflineBackup } from '../src/presigned/backup.js';
import { buildPresignedCashout, signPresignedCashout, authorizePresignedCashoutTransaction,
  type PresignedCashout, type PresignedCashoutRequest } from '../src/presigned/cashout.js';
import { buildPresignedFeeDraft, validatePresignedFeePackage, type PresignedFeeDraft, type PresignedFeePackage } from '../src/presigned/fee-package.js';
import { signPresignedFeePayout } from '../src/presigned/fees.js';
import { presignedObservedFeeCoin, validatePresignedCoinObservations, type PresignedCoinObservations } from '../src/presigned/coin-observations.js';
import { authorizePresignedFundingFeeWalletPsbt, type PresignedFundingFeeSignature, type PresignedFundingFeeRole } from '../src/presigned/funding-fees.js';
import { finalizePresignedOfflineExchange, mergePresignedOfflineExchanges, newPresignedOfflineExchange,
  parsePresignedOfflinePublicJson, validatePresignedOfflineExchange, validatePresignedOfflineTransaction,
  type PresignedOfflineExchange, type PresignedOfflineTransaction } from '../src/presigned/offline.js';
import { selectPresignedOfflineSource } from '../src/presigned/offline-source.js';
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys } from '../src/presigned/roster.js';
import { completePresignedExit } from '../src/presigned/signing.js';
import { signPresignedSpendFeePayout } from '../src/presigned/spend-fees.js';
import { buildPresignedSpend, createPresignedCooperativeNonce, createPresignedRecoveryContribution,
  signPresignedCooperativePartial, signPresignedFinalSweep, validatePresignedCooperativeNonces,
  type PresignedSpendProposal } from '../src/presigned/spends.js';
import { type ParticipantId, type PresignedParticipantKeys, type PresignedPublicKit } from '../src/presigned/types.js';
import { assert, canonicalJson, commitmentDigest, hexBytes, networkParameters, sameCanonical } from '../src/presigned/validation.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => element<HTMLInputElement>(id);
const value = (id: string) => field(id).value.trim();
const select = (id: string) => element<HTMLSelectElement>(id);
const show = (id: string, data: unknown) => { element(id).textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2); };
let busy = false;
let refreshSourceChoices = false;
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
let recoveryObservations: PresignedCoinObservations | null = null;
let recoveryReviewDigest: string | null = null;
let spendRevision = 0;
let observations: PresignedCoinObservations | null = null;
let feeDraft: PresignedFeeDraft | null = null;
let feeReviewDigest: string | null = null;
let feeRevision = 0;
let payoutSignatureHex = '';
let sponsorSignedPsbtBase64 = '';
let fundingFeeSignatures: PresignedFundingFeeSignature[] = [];
let cashoutObservations: PresignedCoinObservations | null = null;
let cashoutRequest: PresignedCashoutRequest | null = null;
let cashout: PresignedCashout | null = null;
let cashoutSigned: ReturnType<typeof signPresignedCashout> | null = null;

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
  if (proposal?.kind === 'recovery') checkedRecoveryReview(proposal, true);
  return spendRevision;
}
function requireFeeReview() {
  const reviewed = checkedFeeDraft();
  assert(field('fee-reviewed').checked, 'rebuild, review and explicitly approve this exact fee child first');
  return reviewed;
}
function burnNonce() { secretNonce?.secretNonce.fill(0); secretNonce = null; }
function resetSpend() {
  spendRevision++; recoveryReviewDigest = null;
  burnNonce(); nonceAttempted = false; proposal = null; soloExitId = null; exchange = null;
  field('reviewed').checked = false; show('review', 'Rebuild and independently review the selected spend.'); updatePeer();
}
function clearFeeSignatures() {
  feeRevision++;
  payoutSignatureHex = ''; sponsorSignedPsbtBase64 = ''; fundingFeeSignatures = []; field('wallet-fee-psbt').value = '';
}
function resetFee() {
  feeDraft = null; feeReviewDigest = null; clearFeeSignatures();
  field('fee-reviewed').checked = false; show('fee-review', 'No fee draft.');
}
function resetCashout() {
  cashoutRequest = null; cashout = null; cashoutSigned = null;
  field('cashout-reviewed').checked = false;
  show('cashout-review', 'No reviewed cash-out.'); show('cashout-result', 'No signed cash-out.');
}
function forget() {
  resetSpend(); resetFee(); resetCashout(); kit = null; binding = null; participant = null; envelope = null;
  transaction = null; observations = null; cashoutObservations = null; recoveryObservations = null;
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) {
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = false;
    else input.value = '';
  }
  // Reset public numeric controls to their visible defaults after forgetting
  // secrets. Blank numeric inputs would otherwise become zero and make a new
  // restored kit's first fee draft invalid without a useful review screen.
  for (const id of ['sponsor-vout','child-fee','fee-cap','target-rate','relay-rate','incremental-rate',
    'cashout-vout','cashout-fee','cashout-fee-cap'])
    field(id).value = field(id).defaultValue;
  for (const id of ['spending','transactions','fees','cashouts']) element(id).hidden = true;
  show('binding', 'No file selected.'); show('transaction-review', 'No finalized transaction.');
  show('recovery-source-review', 'No recovery source observations.');
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
    if (refreshSourceChoices) { refreshSourceChoices = false; void run(updateSources); }
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
      const derived = derivePresignedParticipantKeys(restored.participantSecret, restored.participantId,
        restored.publicKit.graph.roster.vaultId, restored.publicKit.graph.protocol);
      try { return await action(derived.keys, restored.participantSecret, restored.publicKit); }
      finally { clearPresignedParticipantKeys(derived.keys); }
    } });
  } finally { bytes.fill(0); }
}
function updateSources() {
  resetSpend(); const publicKit = requireKit(); const graph = publicKit.graph; const kind = value('spend-kind');
  const choices = kind === 'solo' ? graph.exits.filter(exit => exit.leaver === participant).map(exit => [exit.id, `Exit order ${exit.id}`])
    : kind === 'final-sweep' ? graph.exits.filter(exit => exit.finalParticipant === participant).map(exit => [exit.id, `Final payout after ${exit.id}`])
      : kind === 'recovery' ? recoveryObservations ? (() => {
        const selected = recoverySource();
        return [[selected.sourceExitId ?? '', selected.sourceExitId ? `Observed remaining pair after ${selected.sourceExitId}` : 'Observed original three-person vault']];
      })() : []
      : [['', 'Original three-person vault'], ...graph.exits.filter(exit => exit.parentExitId === null && exit.leaver !== participant)
        .map(exit => [exit.id, `Remaining pair after ${exit.id}`])];
  select('source').replaceChildren(...choices.map(([id, name]) => new Option(name, id)));
}
function recoverySource(spend?: PresignedSpendProposal) {
  const graph = requireKit().graph;
  assert(recoveryObservations, 'import your independently checked recovery source observations first');
  const selected = selectPresignedOfflineSource({ graph, participantId: participant!, observations: recoveryObservations });
  if (spend) {
    assert(spend.kind === 'recovery' && spend.sourceExitId === selected.sourceExitId,
      'recovery proposal does not use your observed current graph source');
    sameCanonical(spend.source, selected.source, 'observed recovery source');
  }
  return selected;
}
function checkedRecoveryReview(spend: PresignedSpendProposal, requireMaturity: boolean) {
  const selected = recoverySource(spend);
  assert(recoveryReviewDigest === selected.reportDigest, 'recovery source changed after review; rebuild before continuing');
  if (requireMaturity) assert(selected.eligibleForNextBlock, 'recovery source is not yet mature; import a new observation after the required blocks');
  return selected;
}
function showRecoverySource() {
  const selected = recoverySource();
  show('recovery-source-review', { ...selected,
    warning: 'These are your imported Core observations, not proof of current chain state. Recheck the active block and exact unspent coin before broadcast. A pending spend may win the race; the chain decides.' });
}
function invalidateRecoverySource() {
  recoveryObservations = null; resetSpend();
  if (value('spend-kind') === 'recovery') select('source').replaceChildren();
  if (transaction?.kind === 'recovery') {
    transaction = null; resetFee(); show('transaction-review', 'Recovery source changed. Reimport observations and review again.');
  }
  show('recovery-source-review', 'No recovery source observations.');
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
    const next = buildPresignedSpend({ graph, proposalId: crypto.randomUUID(),
      kind: kind as PresignedSpendProposal['kind'], sourceExitId: source || null });
    assert(next.participantIds.includes(participant!), 'you are not a participant in this exact source');
    const selected = kind === 'recovery' ? recoverySource(next) : null;
    proposal = next; recoveryReviewDigest = selected?.reportDigest ?? null;
    if (kind !== 'final-sweep') exchange = newPresignedOfflineExchange(graph, proposal);
    show('review', { kind, proposalId: proposal.proposalId, proposalDigest: proposal.digest, graphDigest: graph.digest,
      txid: proposal.txid, source: proposal.source, threshold: proposal.threshold, feeSats: proposal.feeSats,
      minimumSourceConfirmations: kind === 'recovery' ? graph.roster.economics.recoveryDelayBlocks : 1,
      ...(kind === 'recovery' ? { recoveryPolicy: recoveryNotice(publicKit), recoverySourceObservation: selected } : {}),
      outputs: txOutputs(proposal.unsignedTxHex) });
  }
  updatePeer(); show('status', 'Fixed transaction rebuilt. Check the source and outputs independently before signing.');
}
function txOutputs(hex: string) {
  const graph = requireKit().graph;
  return bitcoin.Transaction.fromHex(hex).outs.map((output, vout) => ({ vout, valueSats: Number(output.value),
    scriptPubKeyHex: Buffer.from(output.script).toString('hex'), address: bitcoin.address.fromOutputScript(output.script, networkParameters(graph.roster.network)) }));
}
function recoveryNotice(publicKit: PresignedPublicKit): string {
  return publicKit.graph.version === 3
    ? 'Fixed equal settlement to every current participant, including an absent member. Ends the game without the last-survivor bonus. The parent amounts, destinations and fee cannot be changed by the trigger quorum.'
    : 'Legacy recovery risk: after this coin’s delay, the quorum can use other software to send the entire remaining vault anywhere. Equal payouts shown here are not Bitcoin-enforced.';
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
  const graph = requireKit().graph;
  setTransaction({ version: graph.version, protocol: graph.protocol, format: 'presigned-offline-transaction-v1',
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
  show('binding', { ...binding, verifiedOwnerExits: verified.proof.exitProofs.map(item => item.exitId),
    ...(verified.proof.recoveryProofs ? { verifiedRecoveryTriggerKeys: verified.proof.recoveryProofs.map(item => item.recoveryId),
      verifiedFixedRecoveryAuthorizations: kit.recoveryAuthorizations!.length } : {}), proofDigest: verified.proof.proofDigest });
  for (const id of ['spending','transactions','fees','cashouts']) element(id).hidden = false;
  updateSources(); show('status', 'Kit authenticated. All three of your owner exits were completed and verified locally; their witnesses were discarded. '
    + (kit.graph.version === 3 ? 'All nine fixed-refund approvals and your three separate recovery-trigger keys were verified. ' : '')
    + 'Select only the spend you intend to release.');
});
click('forget', () => { forget(); show('status', 'Session forgotten. No secrets or nonces were stored.'); });
field('reviewed').addEventListener('change', () => { spendRevision++; });
field('recovery-observations').addEventListener('change', invalidateRecoverySource);
file('recovery-observations', raw => {
  const report = validatePresignedCoinObservations(requireKit().graph, parsePresignedOfflinePublicJson(raw));
  selectPresignedOfflineSource({ graph: requireKit().graph, participantId: participant!, observations: report });
  recoveryObservations = report; updateSources(); showRecoverySource();
  show('status', 'Recovery source observations loaded. Review the exact source, confirmations, eligibility and any pending conflict.');
});
select('spend-kind').addEventListener('change', () => {
  resetSpend();
  if (busy) { refreshSourceChoices = true; select('source').replaceChildren(); }
  else void run(updateSources);
});
select('source').addEventListener('change', resetSpend);
click('prepare', reviewSpend);
click('sign-single', async () => {
  const revision = requireReview(); const publicKit = requireKit(); const graph = publicKit.graph;
  if (soloExitId) {
    const exit = graph.exits.find(item => item.id === soloExitId)!;
    const signed = await privateAction(keys => completePresignedExit({ graph, preauthorizations: publicKit.preauthorizations,
      exitId: exit.id, participantId: participant!, privateKey: keys.soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest }));
    assert(requireReview() === revision && soloExitId === exit.id, 'spend review changed during signing; rebuild before continuing');
    publicTransaction('solo', signed, null, exit.id);
  } else {
    assert(proposal?.kind === 'final-sweep', 'select your solo exit or final-owner sweep');
    const spend = proposal;
    const signed = await privateAction(keys => signPresignedFinalSweep({ graph, proposal: spend, participantId: participant!,
      payoutPrivateKey: keys.payoutPrivateKey, approvedProposalDigest: spend.digest }));
    assert(requireReview() === revision && proposal === spend, 'spend review changed during signing; rebuild before continuing');
    publicTransaction('final-sweep', signed, spend);
  }
});
field('peer').addEventListener('change', () => { field('reviewed').checked = false; spendRevision++; });
file('peer', raw => {
  const publicKit = requireKit(); const incoming = parsePresignedOfflinePublicJson(raw);
  const next = exchange ? mergePresignedOfflineExchanges(publicKit, exchange, incoming)
    : validatePresignedOfflineExchange(publicKit, incoming);
  assert(next.proposal.participantIds.includes(participant!), 'this peer proposal belongs to another round');
  const selected = next.proposal.kind === 'recovery' ? recoverySource(next.proposal) : null;
  if (!exchange) resetSpend();
  exchange = next; proposal = next.proposal; recoveryReviewDigest = selected?.reportDigest ?? null;
  // A peer file can add only append-only public contributions. Still require
  // the user to review the exact proposal again before any private-key action.
  field('reviewed').checked = false;
  show('review', { proposalId: proposal.proposalId, proposalDigest: proposal.digest, kind: proposal.kind,
    source: proposal.source, txid: proposal.txid, feeSats: proposal.feeSats, threshold: proposal.threshold,
    minimumSourceConfirmations: proposal.kind === 'recovery' ? publicKit.graph.roster.economics.recoveryDelayBlocks : 1,
    ...(proposal.kind === 'recovery' ? { recoveryPolicy: recoveryNotice(publicKit), recoverySourceObservation: selected } : {}),
    outputs: txOutputs(proposal.unsignedTxHex) }); updatePeer(); show('status', 'Public peer contributions verified. Compare the exact proposal ID and digest with the other signers.');
});
click('nonce', async () => {
  const revision = requireReview(); assert(exchange?.proposal.kind === 'cooperative' && !nonceAttempted && !secretNonce &&
    !exchange.publicNonces.some(item => item.participantId === participant), 'this proposal already has your nonce; continue it or start a fresh proposal');
  const current = exchange; const spend = current.proposal; nonceAttempted = true;
  try {
    secretNonce = await privateAction(keys => createPresignedCooperativeNonce({ graph: requireKit().graph,
      proposal: spend, participantId: participant!, personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: spend.digest }));
    assert(requireReview() === revision && exchange === current, 'spend review changed during nonce creation; start a fresh proposal');
    addToExchange({ publicNonces: [...exchange.publicNonces, secretNonce.publicNonce] });
  } catch (error) { burnNonce(); throw error; }
  show('status', 'Public nonce added. Save and exchange the public peer file. Keep this page open; its secret nonce cannot be restored.');
});
click('partial', async () => {
  const revision = requireReview(); assert(exchange?.proposal.kind === 'cooperative' && secretNonce, 'this page has no unconsumed secret nonce; begin a fresh proposal if it was lost');
  validatePresignedCooperativeNonces({ graph: requireKit().graph, proposal: exchange.proposal, publicNonces: exchange.publicNonces });
  // Remove the sole live reference BEFORE decrypting the participant key. It
  // never went to disk or browser storage, and no file can restore it.
  const consumed = secretNonce; secretNonce = null;
  const current = exchange;
  try {
    const partial = await privateAction(keys => signPresignedCooperativePartial({ graph: requireKit().graph, proposal: current.proposal,
      participantId: participant!, personalPrivateKey: keys.personalPrivateKey, approvedProposalDigest: current.proposal.digest,
      publicNonces: current.publicNonces, nonceBinding: consumed.binding, consumedSecretNonce: consumed.secretNonce }));
    assert(requireReview() === revision && exchange === current, 'spend review changed during signing; begin a fresh proposal');
    addToExchange({ partials: [...current.partials, partial] });
  } finally { consumed.secretNonce.fill(0); updatePeer(); }
  show('status', 'Nonce consumed and partial verified. Save the updated public peer file. Do not restart this same nonce from any snapshot.');
});
click('recovery-share', async () => {
  const revision = requireReview(); assert(exchange?.proposal.kind === 'recovery', 'prepare or import a timelocked recovery proposal');
  assert(!exchange.recoveryContributions.some(item => item.participantId === participant), 'your recovery contribution is already present');
  const current = exchange;
  const selected = checkedRecoveryReview(current.proposal, true);
  assert(current.recoveryContributions.length < current.proposal.threshold, 'the selected recovery quorum is already complete');
  const contribution = await privateAction(keys => {
    const graph = requireKit().graph;
    return createPresignedRecoveryContribution({ graph, proposal: current.proposal, participantId: participant!,
      ...(graph.version === 3 ? { recoveryTriggerPrivateKey: keys.recoveryTriggerPrivateKeys![current.proposal.source.roundId!]! }
        : { personalPrivateKey: keys.personalPrivateKey }), approvedProposalDigest: current.proposal.digest });
  });
  assert(requireReview() === revision && exchange === current &&
    checkedRecoveryReview(current.proposal, true).reportDigest === selected.reportDigest,
  'recovery source or approval changed during signing; rebuild before continuing');
  addToExchange({ recoveryContributions: [...current.recoveryContributions, contribution] });
  show('status', 'Recovery contribution verified. Save and exchange the public peer file; Core still enforces CSV maturity.');
});
click('export-peer', () => {
  assert(exchange, 'no public peer exchange to save'); validatePresignedOfflineExchange(requireKit(), exchange);
  if (exchange.proposal.kind === 'recovery') checkedRecoveryReview(exchange.proposal, exchange.recoveryContributions.length > 0);
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
field('fee-reviewed').addEventListener('change', clearFeeSignatures);
field('fee-observations').addEventListener('change', () => { observations = null; resetFee(); });
file('fee-observations', raw => {
  observations = null; resetFee();
  observations = validatePresignedCoinObservations(requireKit().graph, parsePresignedOfflinePublicJson(raw));
  show('status', `Loaded ${observations.coins.length} public coin observations at height ${observations.tip.height}, observed ${observations.observedAt}. This offline file cannot prove that their blocks remain active or coins remain spendable.`);
});
for (const id of ['sponsor-txid','sponsor-vout','child-fee','fee-cap','target-rate','relay-rate','previous-child','incremental-rate'])
  element(id).addEventListener('input', resetFee);
click('build-fee', () => {
  resetFee();
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
  const base = { version: graph.version, protocol: graph.protocol, epochId: graph.funding.epochId,
    ownerParticipantId: participant!, parentAuthorityDigest: commitmentDigest(`vault/${graph.protocol}/offline-parent`, transaction) };
  let draft: PresignedFeeDraft;
  if (transaction.kind === 'funding') draft = { ...base, mode: 'funding', proposalId: null,
    request: { graph, fundingTransactionHex: transaction.transactionHex, changeParticipantId: participant!,
      fundingInputObservations: graph.funding.inputs.map(coin => find(coin.txid, coin.vout)), sponsorInput, approval } };
  else if (transaction.kind === 'solo') {
    const exit = graph.exits.find(item => item.id === transaction!.exitId)!;
    draft = { ...base, mode: 'solo', proposalId: crypto.randomUUID(), request: { graph, exitId: exit.id,
      parentTransactionHex: transaction.transactionHex, roundInputObservation: find(exit.inputTxid, exit.inputVout), sponsorInput, approval } };
  } else draft = { ...base, mode: 'spend', proposalId: transaction.proposal.proposalId,
    request: { graph, parentSpendProposal: transaction.proposal, parentTransactionHex: transaction.transactionHex,
      payoutParticipantId: participant!, sourceObservation: find(transaction.proposal.source.txid, transaction.proposal.source.vout), sponsorInput, approval } };
  reviewFee(draft);
});
function validateFeeDraft(draft: PresignedFeeDraft) {
  const publicKit = requireKit();
  sameCanonical(draft.request.graph, publicKit.graph, 'offline fee graph');
  assert(draft.ownerParticipantId === participant, 'fee draft uses another payout owner');
  assert(draft.request.approval.sponsorChangeScriptPubKeyHex === draft.request.sponsorInput.scriptPubKeyHex &&
    draft.request.approval.approveExactNoChangeFee === false, 'this offline utility requires preserved same-wallet sponsor change');
  return buildPresignedFeeDraft(draft);
}
function draftReviewDigest(draft: PresignedFeeDraft) {
  return commitmentDigest(`vault/${requireKit().graph.protocol}/offline-fee-review`, draft);
}
function checkedFeeDraft() {
  assert(feeDraft && feeReviewDigest, 'rebuild, review and explicitly approve this exact fee child first');
  const built = validateFeeDraft(feeDraft);
  assert(draftReviewDigest(feeDraft) === feeReviewDigest, 'fee draft changed after review; rebuild before continuing');
  return { draft: feeDraft, built, reviewDigest: feeReviewDigest, revision: feeRevision };
}
function reviewFee(draft: PresignedFeeDraft) {
  resetFee();
  // Do not publish imported or newly built state until every local-context
  // check and the complete transaction reconstruction has succeeded.
  const built = validateFeeDraft(draft);
  const reviewDigest = draftReviewDigest(draft);
  show('fee-review', { mode: draft.mode, reviewDigest, approvalDigest: built.approvalDigest, parentTxid: built.parentTxid,
    childTxid: built.unsignedTxid, preservedPayoutOrRefundSats: 'payoutSats' in built ? built.payoutSats : built.changeSats,
    childFeeSats: built.childFeeSats, sponsorChangeSats: built.sponsorChangeSats,
    maximumChildVsize: built.maximumChildVsize, approval: draft.request.approval, outputs: txOutputs(feeUnsignedHex(built.psbtBase64)) });
  feeDraft = draft; feeReviewDigest = reviewDigest;
  show('status', 'Exact fee child rebuilt. Save the public draft and inspect its coins, outputs and fee before signing.');
}
function feeUnsignedHex(psbtBase64: string) { return Buffer.from(bitcoin.Psbt.fromBase64(psbtBase64).data.globalMap.unsignedTx.toBuffer()).toString('hex'); }
// Invalidate before file-size/read checks too, including a change while an
// earlier private-key action is awaiting decryption.
field('fee-draft-file').addEventListener('change', resetFee);
file('fee-draft-file', raw => {
  resetFee(); reviewFee(parsePresignedOfflinePublicJson(raw) as PresignedFeeDraft);
});
click('save-fee-draft', () => { const { draft } = checkedFeeDraft(); save('presigned-offline-fee-draft.json', draft); });
click('save-fee-psbt', () => {
  const { draft, built } = checkedFeeDraft();
  const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
  const parent = draft.mode === 'funding' ? draft.request.fundingTransactionHex : draft.request.parentTransactionHex;
  psbt.updateInput(0, { nonWitnessUtxo: Buffer.from(parent, 'hex') });
  save('presigned-offline-fee-unsigned.psbt.txt', psbt.toBase64(), true);
});
click('sign-fee', async () => {
  const { draft, built, reviewDigest, revision } = requireFeeReview();
  assert(draft.mode !== 'funding', 'a funding refund requires its original external wallet, never a participant key');
  const signed = await privateAction(keys => draft.mode === 'solo'
    ? signPresignedFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys })
    : signPresignedSpendFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys }));
  const current = requireFeeReview();
  assert(current.draft === draft && current.reviewDigest === reviewDigest && current.revision === revision,
    'fee review changed during signing; rebuild before exporting');
  payoutSignatureHex = signed.payoutSignatureHex;
  show('status', 'Your detached payout signature is ready. Import the external sponsor wallet’s signed PSBT to finalize.');
});
click('import-fee-wallet', () => {
  const { draft, built } = requireFeeReview(); const signed = value('wallet-fee-psbt');
  assert(signed.length > 0 && signed.length <= 200_000, 'wallet PSBT is missing or too large');
  if (draft.mode === 'funding') {
    const contributions = authorizePresignedFundingFeeWalletPsbt({ request: draft.request,
      roles: value('funding-roles').split(',') as PresignedFundingFeeRole[], signedPsbtBase64: signed, approvalDigest: built.approvalDigest });
    const next = [...fundingFeeSignatures];
    for (const item of contributions) {
      const previous = next.find(other => other.role === item.role);
      if (previous) sameCanonical(previous, item, 'retained funding fee wallet contribution');
      else next.push(item);
    }
    fundingFeeSignatures = next;
  } else {
    assert(payoutSignatureHex, 'sign your payout portion before verifying the sponsor wallet PSBT');
    validatePresignedFeePackage({ ...draft, signatures: { payoutSignatureHex, sponsorSignedPsbtBase64: signed } });
    sponsorSignedPsbtBase64 = signed;
  }
  field('wallet-fee-psbt').value = ''; show('status', 'External wallet signature(s) verified against the exact child and explicit roles.');
});
click('finalize-fee', () => {
  const { draft } = requireFeeReview();
  const packageValue = { ...draft, signatures: draft.mode === 'funding' ? fundingFeeSignatures :
    { payoutSignatureHex, sponsorSignedPsbtBase64 } } as PresignedFeePackage;
  const checked = validatePresignedFeePackage(packageValue);
  save('presigned-offline-signed-fee-package.json', checked.package);
  save('presigned-offline-signed-fee-transactions.json', { version: requireKit().graph.version, protocol: requireKit().graph.protocol,
    format: 'presigned-offline-fee-transactions-v1', network: requireKit().graph.roster.network,
    genesisHash: requireKit().graph.roster.genesisHash, packageDigest: checked.packageDigest,
    parentTxid: checked.completed.parentTxid, childTxid: checked.completed.txid,
    transactionHexes: [checked.parentTransactionHex, checked.completed.transactionHex] });
  show('status', 'Signed parent and child saved. Independently verify their current coins and Core policy. Nothing was broadcast.');
});

// A cash-out is a NEW owner-only spend after settlement. It cannot change a
// vault parent, another member's refund, or any committed recovery destination.
file('cashout-observations', raw => {
  cashoutObservations = null; resetCashout();
  cashoutObservations = validatePresignedCoinObservations(requireKit().graph, parsePresignedOfflinePublicJson(raw));
  show('status', `Cash-out coin observations loaded at height ${cashoutObservations.tip.height}. This file cannot prove current confirmations or spendability; recheck them with your own Core.`);
});
for (const id of ['cashout-parent','cashout-vout','cashout-address','cashout-fee','cashout-fee-cap'])
  element(id).addEventListener('input', resetCashout);
click('cashout-build', () => {
  const publicKit = requireKit(); resetCashout();
  assert(cashoutObservations, 'import independently checked cash-out coin observations first');
  const parentTransactionHex = value('cashout-parent');
  assert(parentTransactionHex.length <= 800_000 && /^(?:[0-9a-f]{2})+$/u.test(parentTransactionHex),
    'enter the exact public parent transaction hex for your payout');
  const parent = bitcoin.Transaction.fromHex(parentTransactionHex);
  const report = validatePresignedCoinObservations(publicKit.graph, cashoutObservations);
  const sourceObservation = presignedObservedFeeCoin(report, parent.getId(), Number(value('cashout-vout')), null);
  const request: PresignedCashoutRequest = { publicKit, participantId: participant!, parentTransactionHex,
    sourceObservation, destinationAddress: value('cashout-address'), feeSats: Number(value('cashout-fee')),
    maxFeeSats: Number(value('cashout-fee-cap')) };
  const built = buildPresignedCashout(request);
  cashoutRequest = request; cashout = built;
  show('cashout-review', { source: built.source, sourceConfirmationBlockHash: sourceObservation.confirmationBlockHash,
    sourceConfirmations: sourceObservation.confirmations, destinationAddress: built.destinationAddress,
    destinationScriptPubKeyHex: built.destinationScriptPubKeyHex, youReceiveSats: built.payoutSats,
    additionalCashoutFeeSats: built.feeSats, maximumApprovedFeeSats: built.maxFeeSats,
    signedVsize: built.vsize, transactionId: built.txid, approvalDigest: built.digest,
    notice: 'Only your already-owned coin is spent. This does not change any vault payout or fixed refund. Offline coin observations are not a proof of current chain state.' });
  show('status', 'Cash-out rebuilt. Independently check your coin, receiving address and exact additional fee before signing.');
});
click('cashout-sign', async () => {
  requireKit(); assert(cashoutRequest && cashout && field('cashout-reviewed').checked,
    'review and explicitly approve the cash-out destination, source and additional fee first');
  const request = cashoutRequest; const approved = cashout;
  const signed = await privateAction(keys => signPresignedCashout({ request, cashout: approved,
    keys, approvedCashoutDigest: approved.digest }));
  assert(cashoutRequest === request && cashout === approved && field('cashout-reviewed').checked,
    'cash-out review changed during signing; rebuild before exporting');
  cashoutSigned = signed;
  show('cashout-result', { txid: signed.txid, destinationAddress: approved.destinationAddress,
    youReceiveSats: approved.payoutSats, feeSats: signed.feeSats, locallyVerified: true, broadcast: false });
  show('status', 'Cash-out signed locally. Nothing was broadcast. Save the signed transaction and independently verify it before broadcasting.');
});
function checkedCashout() {
  requireKit(); assert(cashoutRequest && cashout && cashoutSigned, 'sign the exact reviewed cash-out before saving it');
  const signed = authorizePresignedCashoutTransaction({ request: cashoutRequest, cashout, transactionHex: cashoutSigned.transactionHex });
  return { request: cashoutRequest, cashout, signed };
}
click('cashout-save-hex', () => {
  const { signed } = checkedCashout(); save(`presigned-cashout-${signed.txid}.hex.txt`, signed.transactionHex, true);
});
click('cashout-save-json', () => {
  const checked = checkedCashout();
  save(`presigned-cashout-${checked.signed.txid}.json`, { version: checked.cashout.version,
    protocol: checked.cashout.protocol, format: 'presigned-offline-cashout-v1', ...checked });
});

window.addEventListener('pagehide', () => { burnNonce(); field('secret').value = ''; });
try { guard(); show('status', 'Local cryptography ready. No network connection or service login is used.'); }
catch { document.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
  show('status', 'Save and open this utility as a local file in a browser with local-file WebCrypto support. Do not enter a recovery key on a remotely served page.'); }
