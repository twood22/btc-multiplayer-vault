'use client';
import { useEffect, useState } from 'react';
import { encryptPresignedOfflineBackup, generatePresignedOfflineSecret, MAX_PRESIGNED_BACKUP_FILE_BYTES,
  parsePresignedOfflineBackup, presignedBackupBinding, serializePresignedOfflineBackup,
  verifyPresignedKitRestoration, verifyPresignedOfflineBackupRestoration } from '../../src/presigned/backup';
import { authorizePresignedFundingSignedPsbt } from '../../src/presigned/funding';
import { validatePresignedOfflineTransaction } from '../../src/presigned/offline';
import { fundingFeeShare } from '../../src/presigned/graph';
import { buildPresignedRounds } from '../../src/presigned/roster';
import { createPreauthorizations } from '../../src/presigned/signing';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type PresignedParticipant } from '../../src/presigned/types';
import { assert, commitmentDigest } from '../../src/presigned/validation';
import { fromBase64url, toBase64url } from '../lib/client/base64url';
import { downloadVerifiedPresignedUtility } from '../lib/client/presigned-offline-utility';
import { approvePresignedCeremonyAction, presignedPost, verifyPresignedCeremonyView } from '../lib/client/presigned-ceremony';
import { assertPresignedFundingInputCurrent, observePresignedFundingInput } from '../lib/client/presigned-chain';
import { verifyPresignedPasskeyRestoration, withUnlockedPresignedParticipant,
  withUnregisteredPresignedParticipant } from '../lib/client/presigned-custody';
import type { PresignedCeremonyStatus } from '../lib/server/presigned-store';
import { appendPresignedLocalRecord, assertPresignedLocalRestartAllowed, emptyPresignedLocalCeremony,
  presignedLocalBinding, presignedLocalChecks, presignedLocalGraphRecord, presignedLocallyRestoredRecord,
  readPresignedLocalCeremony, withPresignedLocalCeremonyLock, type PresignedLocalRecord } from '../lib/client/presigned-local-ceremony';

type InitialIdentity = Pick<PresignedParticipant, 'id' | 'personalPublicKeyHex' | 'payoutXonlyPublicKeyHex'>;
const BASE = { version: 2 as const, protocol: PRESIGNED_PROTOCOL };

export function PresignedCeremony({ initialStatus, passkeys, expectedIdentity, chainConfig }: {
  initialStatus: PresignedCeremonyStatus; passkeys: Array<{ id: string; name: string }>; expectedIdentity: InitialIdentity;
  chainConfig: { apiUrl: string; allowedOrigins: string[] };
}) {
  const localBinding = presignedLocalBinding(initialStatus.vaultId, expectedIdentity);
  const [local, setLocal] = useState(() => emptyPresignedLocalCeremony(localBinding));
  const [status, setStatus] = useState(initialStatus);
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [message, setMessage] = useState('Rebuild and verify this protocol in your browser before each approval.');
  const [working, setWorking] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [rosterCompared, setRosterCompared] = useState<string | null>(null);
  const [graphReviewed, setGraphReviewed] = useState<string | null>(null);
  const [apiUrl, setApiUrl] = useState(chainConfig.apiUrl);
  const [chainNotice, setChainNotice] = useState('');
  const [txid, setTxid] = useState('');
  const [vout, setVout] = useState('0');
  const [signedPsbt, setSignedPsbt] = useState('');
  const [displayedOfflineSecret, setDisplayedOfflineSecret] = useState('');
  const [restoreSecret, setRestoreSecret] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restartReason, setRestartReason] = useState('');
  function expected() { return { vaultId: initialStatus.vaultId, participantId: initialStatus.participantId,
    settingsDigest: initialStatus.settingsDigest, localState: readPresignedLocalCeremony(localBinding) }; }
  const participantId = status.participantId;
  const identity = status.identities.find(item => item.id === participantId);
  const epoch = status.epoch;
  const graph = epoch?.graph;
  const economic = status.settings.economics;
  const finalPayout = economic.depositSatsPerParticipant * 3 - economic.firstWithdrawalSats -
    economic.secondWithdrawalSats - economic.soloWithdrawalFeeSats * 3;
  const disabled = working || !hydrated;
  const localChecks = presignedLocalChecks(status, local);

  function remember(record: PresignedLocalRecord) {
    setLocal(appendPresignedLocalRecord(localBinding, record));
  }

  function accept(next: PresignedCeremonyStatus) {
    const binding = expected();
    verifyPresignedCeremonyView(next, binding);
    const own = next.identities.find(item => item.id === participantId);
    if (own) assert(own.personalPublicKeyHex === expectedIdentity.personalPublicKeyHex &&
      own.payoutXonlyPublicKeyHex === expectedIdentity.payoutXonlyPublicKeyHex, 'coordinator changed your passkey identity');
    setLocal(binding.localState);
    setRosterCompared(previous => previous === next.rosterDigest ? previous : null);
    setGraphReviewed(previous => previous === next.epoch?.graph?.digest ? previous : null);
    setStatus(next);
  }
  async function refresh() { accept(await presignedPost('/api/vault/presigned/status', {})); }
  useEffect(() => {
    try { accept(initialStatus); setHydrated(true); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Protocol verification failed'); }
  // The initial server commitment is fixed for this mounted ceremony.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hydrated || working) return;
    const timer = setInterval(() => { void refresh().catch(error =>
      setMessage(error instanceof Error ? error.message : 'Status refresh failed; signing is not advanced')); }, 15_000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, working]);
  useEffect(() => {
    if (!hydrated) return;
    const sync = () => { try { accept(status); }
      catch (error) { setHydrated(false); setMessage(error instanceof Error ? error.message : 'Local ceremony history changed; signing is blocked'); } };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  // Local append-only intent from another tab must close this tab's restart path too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, status]);

  async function run(action: () => Promise<void>) {
    if (disabled) return;
    setWorking(true);
    try { await withPresignedLocalCeremonyLock(localBinding, async () => {
      verifyPresignedCeremonyView(status, expected()); await action();
    }); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Presigned ceremony action failed'); }
    finally { setWorking(false); }
  }
  async function checkFundingCoins() {
    assert(graph, 'complete funding graph is required');
    const reanchored: string[] = [];
    for (const coin of graph.funding.inputs) {
      const observed = await observePresignedFundingInput({ apiUrl, allowedOrigins: chainConfig.allowedOrigins, participantId: coin.participantId,
        txid: coin.txid, vout: coin.vout, changeScriptPubKeyHex: coin.changeScriptPubKeyHex });
      if (assertPresignedFundingInputCurrent(coin, observed)) reanchored.push(coin.participantId);
    }
    setChainNotice(reanchored.length ? `New active confirmation block observed for ${reanchored.join(', ')}. The exact unspent coins and required depth still verify; the original graph and signatures are unchanged.` : '');
  }
  function requireKit() {
    const binding = expected();
    const checked = verifyPresignedCeremonyView(status, binding);
    const own = presignedLocalChecks(status, binding.localState);
    assert(own.rosterCompared && own.graphReviewed, 'compare the roster and review this exact graph locally first');
    assert(checked.publicKit && identity, 'all twelve verified preauthorizations and your identity are required');
    return checked.publicKit;
  }
  async function verifyLocalKit() {
    const publicKit = requireKit();
    await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: status.vaultId, expectedParticipant: identity!,
      action: local => verifyPresignedKitRestoration({ publicKit, participantId, participantSecret: local.participantSecret,
        expectedBinding: presignedBackupBinding(publicKit, participantId) }) });
  }
  async function register() {
    setMessage('Unlock your passkey to derive all three vault-scoped solo keys locally…');
    const publicIdentity = await withUnregisteredPresignedParticipant({ credentialId, expectedVaultId: status.vaultId,
      expectedParticipant: expectedIdentity, action: local => local.publicIdentity });
    accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'register-identity',
      settingsDigest: status.settingsDigest, identity: publicIdentity }));
    setMessage('Your personal, payout and three solo public keys are registered. No private key was transmitted.');
  }
  async function confirmRoster() {
    assert(rosterCompared === status.rosterDigest && identity && status.rosterDigest, 'compare the exact roster with both friends first');
    await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: status.vaultId,
      expectedParticipant: identity, action: () => undefined });
    remember({ kind: 'roster-compared', settingsDigest: status.settingsDigest, rosterDigest: status.rosterDigest });
    if (!status.rosterApprovals.includes(participantId)) {
      accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'confirm-roster', rosterDigest: status.rosterDigest }));
    }
    setMessage('This browser pinned your independently compared roster. Funding inputs also require all three coordinator-recorded approvals.');
  }
  async function commitInput() {
    assert(epoch && status.rosterDigest, 'unanimous roster is required');
    assert(presignedLocalChecks(status, expected().localState).rosterCompared, 'compare and pin the roster locally first');
    setMessage('Checking the exact wallet coin against your independent chain source…');
    const previous = expected().localState.records.flatMap(record => record.kind === 'input-committed' &&
      record.epochId === epoch.epochId ? [record.input] : [])[0];
    let observed = await observePresignedFundingInput({ apiUrl, allowedOrigins: chainConfig.allowedOrigins, participantId,
      txid: previous?.txid ?? txid.trim().toLowerCase(), vout: previous?.vout ?? Number(vout),
      changeScriptPubKeyHex: previous ? previous.changeScriptPubKeyHex : null });
    if (previous) { assertPresignedFundingInputCurrent(previous, observed); observed = previous; }
    const change = observed.valueSats - economic.depositSatsPerParticipant - fundingFeeShare(status.settings.fundingFeeSats,
      PARTICIPANT_IDS.indexOf(participantId));
    assert(change >= 330, 'wallet coin must cover the deposit, fee share and at least 330 sats of same-wallet refund');
    observed.changeScriptPubKeyHex = observed.scriptPubKeyHex;
    assert(!buildPresignedRounds(status.roster!).some(round => round.outputScriptHex === observed.changeScriptPubKeyHex),
      'funding change must not recreate any current or later-round vault');
    remember({ kind: 'input-committed', epochId: epoch.epochId, rosterDigest: status.rosterDigest, input: observed });
    accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'commit-funding-input', epochId: epoch.epochId,
      rosterDigest: status.rosterDigest, input: observed }));
    setMessage('Your exact input and change are approved. The private Core backend independently rechecked them.');
  }
  async function preauthorize() {
    assert(graph && epoch && identity && graphReviewed === graph.digest, 'review all nine rebuilt exits before preauthorizing');
    assert(presignedLocalChecks(status, expected().localState).rosterCompared, 'compare and pin the roster locally first');
    // A fresh device may review an already-funded graph without emitting another preauthorization.
    // Actual wallet export and every NEW preauthorization still recheck all funding inputs.
    if (!epoch.preauthorizations.some(item => item.participantId === participantId)) await checkFundingCoins();
    const preauthorizations = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: status.vaultId,
      expectedParticipant: identity, action: unlocked => {
        remember({ kind: 'input-committed', epochId: epoch.epochId, rosterDigest: graph.rosterDigest,
          input: graph.funding.inputs.find(input => input.participantId === participantId)! });
        remember(presignedLocalGraphRecord('graph-reviewed', status));
        return epoch.preauthorizations.some(item => item.participantId === participantId) ? null
          : createPreauthorizations({ graph, participantId, privateKeys: unlocked.keys.soloPrivateKeys, approvedGraphDigest: graph.digest });
      } });
    if (preauthorizations) accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'contribute-preauthorizations',
      epochId: epoch.epochId, graphDigest: graph.digest, preauthorizations }));
    setMessage('This browser pinned the exact graph and your input/change. Your three leaver signatures remain unreleased.');
  }
  async function exportBackup() {
    const publicKit = requireKit();
    const offlineSecret = generatePresignedOfflineSecret();
    try {
      const encrypted = await withUnlockedPresignedParticipant({ credentialId, expectedVaultId: status.vaultId,
        expectedParticipant: identity!, action: local => encryptPresignedOfflineBackup({ publicKit, participantId,
          participantSecret: local.participantSecret, offlineSecret }) });
      download(`vault-${participantId}-${publicKit.graph.funding.epochId}-encrypted.json`, serializePresignedOfflineBackup(encrypted));
      setDisplayedOfflineSecret(toBase64url(offlineSecret));
      setMessage('Save the encrypted file and this random recovery key separately. Then select that saved file and re-enter its key below.');
    } finally { offlineSecret.fill(0); }
  }
  async function exportRecoveryUtility() {
    const publicKit = requireKit();
    const utility = await downloadVerifiedPresignedUtility();
    download('presigned-recovery.html', utility.bytes);
    download('presigned-independent-recovery-record.json', JSON.stringify({ ...BASE,
      format: 'presigned-independent-recovery-record-v1', binding: presignedBackupBinding(publicKit, participantId),
      utilitySha256: utility.sha256, utilityInputDigest: utility.inputDigest,
      instructions: 'Compare the graph digest and funding txid with both friends through an independent channel. Compare the utility SHA-256 with the independently reviewed release record. Keep this record and utility separately from the recovery key. A manifest from the same compromised server is not an independent trust anchor.' }, null, 2));
    setMessage(`Offline utility and public commitments saved. Utility SHA-256: ${utility.sha256}. Compare it with an independently reviewed release record, then open your saved HTML as a local file.`);
  }
  async function exportSignedFunding() {
    const publicKit = requireKit(); assert(epoch?.finalization, 'complete funding signatures are required');
    const value = validatePresignedOfflineTransaction(publicKit, { ...BASE, format: 'presigned-offline-transaction-v1',
      graphDigest: publicKit.graph.digest, kind: 'funding', proposal: null, exitId: null,
      transactionHex: epoch.finalization.transactionHex, txid: epoch.finalization.txid });
    download('presigned-signed-funding.json', JSON.stringify(value));
    setMessage('Exact signed funding saved for independent verification or offline fee rescue. Anyone holding it can broadcast; it cannot be recalled.');
  }
  async function restoreOffline() {
    const publicKit = requireKit();
    assert(restoreFile && restoreFile.size <= MAX_PRESIGNED_BACKUP_FILE_BYTES, 'select a bounded encrypted recovery file');
    const raw = await restoreFile.text();
    const offlineSecret = fromBase64url(restoreSecret.trim());
    try {
      assert(offlineSecret.length === 32 && toBase64url(offlineSecret) === restoreSecret.trim(), 'recovery key must be the exact 43-character random key');
      const proof = await verifyPresignedOfflineBackupRestoration({ envelope: parsePresignedOfflineBackup(raw), offlineSecret,
        expectedBinding: presignedBackupBinding(publicKit, participantId) });
      const backupFileDigest = commitmentDigest('vault/presigned-graph-v2/offline-file', { serialized: raw });
      remember(presignedLocallyRestoredRecord({ publicKit, participantId, proof, backupKind: 'offline',
        credentialId: null, backupFileDigest }));
      setRestoreSecret('');
      setDisplayedOfflineSecret('');
      setRestoreFile(null);
      if (!epoch!.backups.some(item => item.participantId === participantId && item.backupKind === 'offline')) {
        accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'confirm-backup', epochId: epoch!.epochId,
        graphDigest: publicKit.graph.digest, backupKind: 'offline', restoreCredentialId: null,
        backupFileDigest, proof }));
      }
      setMessage('Saved offline file independently reopened and all three owner exits verified locally. Only verification digests were sent.');
    } finally { offlineSecret.fill(0); setRestoreSecret(''); }
  }
  async function restorePasskey(id: string) {
    const publicKit = requireKit();
    const { credentialId: restoredId, ...proof } = await verifyPresignedPasskeyRestoration({ credentialId: id, publicKit,
      expectedBinding: presignedBackupBinding(publicKit, participantId) });
    remember(presignedLocallyRestoredRecord({ publicKit, participantId, proof, backupKind: 'passkey',
      credentialId: restoredId, backupFileDigest: null }));
    if (!epoch!.backups.some(item => item.participantId === participantId && item.restoreCredentialId === restoredId)) {
      accept(await approvePresignedCeremonyAction(restoredId, { ...BASE, kind: 'confirm-backup', epochId: epoch!.epochId,
        graphDigest: publicKit.graph.digest, backupKind: 'passkey', restoreCredentialId: restoredId, backupFileDigest: null, proof }));
    }
    setMessage('This exact passkey restored your identity and completed all three owner exits locally.');
  }
  async function exportFunding() {
    assert(verifyPresignedCeremonyView(status, expected()).walletSigningReady, 'complete local offline and two-passkey restores before wallet signing');
    await checkFundingCoins();
    await verifyLocalKit();
    await beginWalletSigning();
    download(`vault-funding-${epoch!.epochId}.psbt.txt`, graph!.fundingPsbtBase64);
    setMessage('Verified funding PSBT exported. Sign only your input in your external wallet, without changing any transaction field.');
  }
  async function beginWalletSigning() {
    assert(graph && epoch, 'funding graph is required');
    assert(verifyPresignedCeremonyView(status, expected()).walletSigningReady, 'local recovery checks are required before signing intent');
    remember(presignedLocalGraphRecord('wallet-signing-started', status));
    if (!epoch.walletSigningStarted.includes(participantId)) {
      accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'begin-wallet-signing',
        epochId: epoch.epochId, graphDigest: graph.digest }));
    }
  }
  async function submitWallet() {
    assert(graph && epoch && verifyPresignedCeremonyView(status, expected()).walletSigningReady,
      'wallet signatures cannot be released before every participant backup');
    await checkFundingCoins();
    await verifyLocalKit();
    await beginWalletSigning();
    const signature = authorizePresignedFundingSignedPsbt({ graph, participantId,
      signedPsbtBase64: signedPsbt.trim(), approvedGraphDigest: graph.digest });
    setMessage('Sending the exact wallet signature now. Cancelling the following passkey prompt cannot recall a signature already sent.');
    accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'submit-funding-signature',
      epochId: epoch.epochId, graphDigest: graph.digest, signature }));
    setSignedPsbt('');
    setMessage('Your exact wallet signature was released. This epoch can no longer be revoked by restarting or deleting coordinator data.');
  }
  async function approveFunding() {
    assert(graph && epoch?.finalization, 'all three wallet signatures must verify first');
    assert(verifyPresignedCeremonyView(status, expected()).walletSigningReady, 'local recovery checks are required before final approval');
    await checkFundingCoins();
    accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'approve-funding', epochId: epoch.epochId,
      graphDigest: graph.digest, finalizationDigest: epoch.finalization.finalizationDigest }));
    setMessage('Exact final funding bytes approved. Broadcast still requires the separately gated private operator release.');
  }
  async function restart() {
    assert(epoch && status.restartStateDigest, 'a wallet-signed funding epoch cannot be restarted');
    assertPresignedLocalRestartAllowed(status, expected().localState);
    const reason = restartReason.trim().replace(/\s+/gu, ' ');
    accept(await approvePresignedCeremonyAction(credentialId, { ...BASE, kind: 'restart-funding', epochId: epoch.epochId,
      stateDigest: status.restartStateDigest, reason }));
    setGraphReviewed(null);
    setMessage('Restart vote recorded. A new epoch requires unanimous approval of this exact state and reason; history is retained.');
  }

  return <section className="setup-card" data-testid="presigned-ceremony">
    <p className="eyebrow">Presigned graph v2 · {status.settings.network} · {status.phase}</p>
    <h2>Agree, preauthorize, back up, then fund</h2>
    <p>No online policy signer is involved. Each leaver retains the final signature for their own exit.</p>
    <p>Each deposit: {economic.depositSatsPerParticipant.toLocaleString()} sats. First payout: {economic.firstWithdrawalSats.toLocaleString()}.
      Second: {economic.secondWithdrawalSats.toLocaleString()}. Final remainder: {finalPayout.toLocaleString()} sats, before its optional sweep.
      Recovery delay: {economic.recoveryDelayBlocks} blocks. Additional sponsored fees are separate.</p>
    <p className="muted">Mainnet activation is separately gated. Physical-device passkey checks remain deferred to onboarding.</p>
    <label>Approval passkey<select value={credentialId} disabled={disabled} onChange={event => setCredentialId(event.target.value)}>
      {passkeys.map(key => <option value={key.id} key={key.id}>{key.name}</option>)}
    </select></label>
    <button disabled={disabled} onClick={() => void run(refresh)} type="button">Refresh ceremony</button>
    <p className="form-message" role="status">{message}</p>
    {chainNotice && <p role="status">{chainNotice}</p>}
    <p className="muted">This browser keeps public approval and recovery-check records locally. A new device or cleared storage requires a fresh roster comparison, graph review, saved-file restore and two distinct passkey restores. Keep the portable kit independently. These checks cannot protect against malicious JavaScript served by a compromised application.</p>
    {localChecks.walletSigningStarted && <p>Wallet signing has started in this browser. This local record is irreversible: coordinator rollback, a failed request or a cancelled passkey prompt cannot reopen setup restart.</p>}

    <details><summary>Immutable settings and personal identity</summary><pre>{JSON.stringify({
      settingsDigest: status.settingsDigest, settings: status.settings, expectedIdentity }, null, 2)}</pre></details>
    {!identity && <button type="button" disabled={disabled} onClick={() => void run(register)}>Register my v2 public keys</button>}
    {status.roster && <section>
      <h3>1. Confirm the roster together</h3><p>Compare this exact digest with both friends through a separate trusted channel.</p>
      <code>{status.rosterDigest}</code><p>{status.rosterApprovals.length}/3 approvals</p>
      <details><summary>All public identities and round keys</summary><pre>{JSON.stringify(status.roster, null, 2)}</pre></details>
      {(!localChecks.rosterCompared || !status.rosterApprovals.includes(participantId)) && <>
        <label><input type="checkbox" checked={rosterCompared === status.rosterDigest} disabled={disabled}
          onChange={event => setRosterCompared(event.target.checked ? status.rosterDigest : null)} />
          I compared this digest, the three identities and the exact economics with both friends.</label>
        <button disabled={disabled || rosterCompared !== status.rosterDigest} onClick={() => void run(confirmRoster)} type="button">Compare and pin exact roster locally</button>
      </>}
    </section>}
    {epoch && <section>
      <h3>2. Commit real wallet inputs</h3>
      <label>Independent chain API URL<input value={apiUrl} disabled={disabled} onChange={event => setApiUrl(event.target.value)} /></label>
      <p className="muted">Allowed HTTPS origins: {chainConfig.allowedOrigins.join(', ')}. Enter the full Esplora API base URL; this choice must match the deployment’s CSP.</p>
      <p className="muted">This browser sends the selected outpoints directly to that HTTPS service. Raw transaction bytes, genesis, unspent status and active blocks are checked.</p>
      <p>{epoch.inputs.length}/3 inputs committed · funding fee {status.settings.fundingFeeSats} sats total</p>
      {!epoch.inputs.some(input => input.participantId === participantId) && <>
        <label>Wallet coin transaction ID<input value={txid} disabled={disabled} onChange={event => setTxid(event.target.value)} /></label>
        <label>Output number<input value={vout} disabled={disabled} inputMode="numeric" onChange={event => setVout(event.target.value)} /></label>
        <p>Your refund is fixed to the same script as this wallet input. Keep at least 330 sats beyond your deposit and fee share so you can independently sponsor funding fees.</p>
        <button type="button" disabled={disabled || !localChecks.rosterCompared} onClick={() => void run(commitInput)}>Verify and commit my coin</button>
      </>}
      <details><summary>Exact committed inputs and changes</summary><pre>{JSON.stringify(epoch.inputs, null, 2)}</pre></details>
      {epoch.inputs.filter(input => input.participantId === participantId).map(input => <p key={input.txid}>
        Your same-wallet refund: {input.valueSats - economic.depositSatsPerParticipant - fundingFeeShare(status.settings.fundingFeeSats,
          PARTICIPANT_IDS.indexOf(participantId))} sats · destination script <code>{input.scriptPubKeyHex}</code></p>)}
    </section>}
    {graph && epoch && <section>
      <h3>3. Verify all nine exits</h3><p>Graph digest: <code>{graph.digest}</code></p>
      <p>Stable funding txid: <code>{graph.fundingTxid}</code></p>
      <p>Your exact wallet input and change commitment:</p><pre>{JSON.stringify(graph.funding.inputs.find(input => input.participantId === participantId), null, 2)}</pre>
      <table><thead><tr><th>Exit order</th><th>Leaver</th><th>Base fee, sats</th><th>Successor</th></tr></thead>
        <tbody>{graph.exits.map(exit => <tr key={exit.id}><td>{exit.id}</td><td>{exit.leaver}</td><td>{exit.feeSats}</td>
          <td>{exit.finalParticipant ? `${exit.finalParticipant} final payout` : 'remaining pair vault'}</td></tr>)}</tbody></table>
      <p>{epoch.preauthorizations.length}/12 verified counterparty preauthorizations</p>
      <details><summary>Entire locally rebuilt graph</summary><pre>{JSON.stringify(graph, null, 2)}</pre></details>
      {(!localChecks.graphReviewed || !epoch.preauthorizations.some(item => item.participantId === participantId)) && <>
        <label><input type="checkbox" checked={graphReviewed === graph.digest} disabled={disabled}
          onChange={event => setGraphReviewed(event.target.checked ? graph.digest : null)} />
          I reviewed the exact inputs, payouts, fees and successor vaults for every exit order.</label>
        <button disabled={disabled || !localChecks.rosterCompared || graphReviewed !== graph.digest} type="button" onClick={() => void run(preauthorize)}>
          {epoch.preauthorizations.some(item => item.participantId === participantId) ? 'Pin my graph review on this device' : 'Pin graph and preauthorize four counterparty exits'}</button>
      </>}
    </section>}
    {epoch?.preauthorizations.length === 12 && <section>
      <h3>4. Restore complete backups before funding</h3>
      <p>The file below contains an authenticated encrypted participant secret and all public exit/recovery material. Its separate random key works without this service or its passkey origin.</p>
      <button disabled={disabled || !localChecks.graphReviewed} type="button" onClick={() => void run(exportRecoveryUtility)}>Save offline recovery utility and public commitments</button>
      <p>Keep the saved HTML and public commitment record with your backup material. Independently compare the utility hash with the reviewed release, and the graph digest and funding ID with both friends. A hash downloaded from this same server is not independent proof of trustworthy code.</p>
      <button disabled={disabled || !localChecks.graphReviewed} type="button" onClick={() => void run(exportBackup)}>Create encrypted portable backup</button>
      {displayedOfflineSecret && <div><label>Keep this recovery key separately from the file<input readOnly value={displayedOfflineSecret} autoComplete="off" /></label>
        <button type="button" onClick={() => setDisplayedOfflineSecret('')}>I stored the key separately; hide it</button></div>}
      {!localChecks.offlineRestored && <>
        <label>Reopen the saved encrypted file<input type="file" accept="application/json,.json" disabled={disabled}
          onChange={event => setRestoreFile(event.target.files?.[0] || null)} /></label>
        <label>Re-enter its separate recovery key<input type="password" autoComplete="off" value={restoreSecret} disabled={disabled}
          onChange={event => setRestoreSecret(event.target.value)} /></label>
        <button type="button" disabled={disabled || !localChecks.graphReviewed || !restoreFile || !restoreSecret} onClick={() => void run(restoreOffline)}>Verify saved offline recovery</button>
      </>}
      {passkeys.map(key => {
        const restored = localChecks.passkeysRestored.includes(key.id);
        return <button type="button" key={key.id} disabled={disabled || !localChecks.graphReviewed || restored} onClick={() => void run(() => restorePasskey(key.id))}>
          {restored ? 'Verified' : 'Restore with'}: {key.name}</button>;
      })}
      <p>Before wallet signing, this browser requires its own actual saved-file restore and two distinct passkey restores. Friends’ server receipts remain attestations, not proof that their files remain safely stored.</p>
      <details><summary>Public restoration receipts</summary><pre>{JSON.stringify(epoch.backups, null, 2)}</pre></details>
    </section>}
    {status.walletSigningReady && localChecks.walletSigningReady && epoch && <section>
      <h3>5. Sign only your funding input</h3>
      <p>Starting the wallet export records a durable signing intent and closes the restart path, even if the tab later crashes. Keep this exact epoch’s recovery kit.</p>
      <button disabled={disabled} type="button" onClick={() => void run(exportFunding)}>Reverify and export funding PSBT</button>
      {!epoch.signatures.some(item => item.participantId === participantId) && <>
        <p>Releasing your signed PSBT sends its signature before the next passkey confirmation. Cancelling that prompt cannot recall it.</p>
        <label>PSBT returned by your external wallet<textarea value={signedPsbt} disabled={disabled} onChange={event => setSignedPsbt(event.target.value)} /></label>
        <button disabled={disabled || !signedPsbt.trim()} type="button" onClick={() => void run(submitWallet)}>Verify and release my wallet signature</button>
      </>}
      <p>{epoch.signatures.length}/3 wallet signatures · {epoch.fundingApprovals.length}/3 final approvals</p>
      {epoch.finalization && <>
        <button type="button" disabled={disabled} onClick={() => void run(exportSignedFunding)}>Save exact signed funding for offline recovery</button>
        <details><summary>Exact signed funding transaction for final approval</summary><pre>{JSON.stringify(epoch.finalization, null, 2)}</pre></details>
        {!epoch.fundingApprovals.includes(participantId) && <button type="button" disabled={disabled} onClick={() => void run(approveFunding)}>Approve exact final funding bytes</button>}
      </>}
    </section>}
    {epoch?.status === 'approved' && <p>All funding approvals are complete. This screen does not broadcast. The private operator release still requires the protocol’s verified acceptance evidence.</p>}
    {epoch && status.restartStateDigest && localChecks.rosterCompared && !localChecks.walletSigningStarted && <details><summary>Interrupted setup: request a unanimous restart</summary>
      <p>Only available before anyone starts wallet signing. All three people must approve the same state digest and reason; old public epochs remain retained.</p>
      <label>Shared restart reason<input value={restartReason} disabled={disabled} onChange={event => setRestartReason(event.target.value)} /></label>
      <button disabled={disabled || restartReason.trim().length < 10} type="button" onClick={() => void run(restart)}>Approve this restart request</button>
    </details>}
    <details><summary>Retained funding epochs</summary><pre>{JSON.stringify(status.epochHistory, null, 2)}</pre></details>
  </section>;
}

function download(name: string, contents: string | Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
