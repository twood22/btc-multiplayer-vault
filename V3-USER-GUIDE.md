# Three-person vault: participant guide

This guide describes V3 (`presigned-graph-v3`). Implementation and acceptance
are still in progress; see `V3-ACCEPTANCE-CHECKLIST.md`. It is not a statement
that this build is ready for real deposits. Never reuse V2 release evidence to
approve V3. Existing V2 vaults retain their original, different recovery rules.

## What you are agreeing to

Three people deposit equal amounts. In a completed normal solo game, the first
person receives less than the second, and the last receives the largest payout,
after the fees committed during setup. Each participant can initiate their own
eligible exit without asking the coordinator to hold their Bitcoin key.

Emergency recovery is different: after the current vault coin's waiting period,
two of the original three people can trigger the exact equal refund agreed at
setup. The absent person's refund is included. Once only two people remain,
either can trigger the agreed equal refund of that remaining coin after its own
waiting period. The small indivisible-satoshi remainder follows the displayed
fixed order. These refunds go only to the members' committed payout addresses;
a quorum cannot replace the destinations or amounts with its own choices.

All current members can also cooperate to exit. The app displays every amount
before signing. Emergency or cooperative settlement does not award a
last-person bonus. Separate fee rescue and later wallet-transfer fees are not
part of the normal game's committed payout comparison.

## Before anyone deposits

1. Each person opens their own private invitation. Do not share invitation URLs
   in screenshots, public issues or support messages.
2. Create your own participant identity and register two passkeys. The app must
   successfully restore the same identity with each passkey. A registered
   passkey count alone is not sufficient.
3. Compare the public roster commitment with both friends through a channel you
   already trust. Check the network, equal deposit amount, normal payouts,
   recovery delay, fee limits and payout identities.
4. Commit an eligible, confirmed native P2WPKH or P2TR coin from an external
   wallet. The app independently checks the transaction and unspent output.
5. All three compare the exact graph commitment. Review the four fixed recovery
   refund tables as well as normal payouts. Each person supplies four setup
   exit signatures and three fixed-refund approvals. All 21 must verify.
6. Download the self-contained offline recovery utility, public commitments and
   your encrypted portable kit. Keep the recovery key separately from the
   encrypted kit. Before opening the downloaded HTML, use a trusted SHA-256
   file-hash tool to compare its hash with the independently reviewed release
   record obtained through a trusted channel. A utility and commitment record
   from the same server alone are not an independent trust check. Each person
   must then reopen their actual downloaded file and complete the app's
   restoration checks before funding signing is enabled.
7. Preserve a separate copy of the kit and offline utility outside this browser
   profile. The coordinator, browser storage and one passkey are not substitutes
   for the portable recovery material.

The kit is private even though it contains public transaction material: its
encrypted participant secret and recovery key together control your Bitcoin
signatures. Never send either to support. Never upload an unlocked kit, recovery
key, passkey PRF output or private key to a block explorer.

## Fund the exact vault

Use **Reverify and export funding PSBT**, sign the exported file in your external
wallet, then import the returned PSBT into the app. Check the wallet's exact
inputs, vault destination, change and fee. Do not sign an unrelated transaction
or send an extra informal payment to a displayed vault address.

Each person releases only their own checked wallet signature and approves the
same final transaction. Broadcasting is a separate step. Until confirmation,
do not treat a pending transaction or a coordinator status label as a completed
deposit. If setup was interrupted after a funding signature may have escaped,
do not silently reuse or discard that epoch; use the retained-state workflow.

Mainnet funding remains separately gated by exact release evidence and explicit
protocol-specific operator authorization. The implementation goal does not
enable that gate.

## Leave normally, then move your payout

In **Exit and recovery transactions**, refresh the chain state and choose your
eligible solo exit, or the final-owner sweep if you are last. Review the exact
transaction, use your passkey to sign locally, and separately approve sending.
Wait for confirmation. Reorganizations can undo a displayed confirmation.

Your confirmed payout is now individually controlled by your payout key; it is
not yet in your everyday wallet. In **Send your payout to your wallet**:

1. Choose **Find my confirmed payouts**. This shares your public payout address
   with the independent chain source, not your private keys.
2. Select your payout coin and enter an address from your receiving wallet.
   Verify the complete address in that wallet, the network and additional fee.
3. Preview and approve the exact amount and destination. Changing an input,
   destination or fee cancels the previous review.
4. Sign and download the withdrawal. Downloading does not broadcast it.
5. Save the signed withdrawal, then explicitly broadcast it. After interruption,
   restore the saved signed file or review the retained withdrawal; the same
   bytes can be retried without signing a different payment.

The transfer spends only that owner's individual coin. It cannot modify a
fixed vault refund or spend another participant's money. The additional network
fee is deducted from the selected payout. The offline utility can also sign and
export this owner-only wallet transfer without the coordinator.

## Recover without the website or a missing friend

Before opening your saved recovery HTML, verify its SHA-256 with a trusted
file-hash tool against both the saved commitment record and the independently
reviewed release record obtained through a trusted channel. Do not rely only on
files supplied by the same server. Open the verified file on a trusted computer,
preferably with network access disabled while unlocking. Import your encrypted
kit and enter its separate recovery key locally. The utility does not make
network requests.

Independently obtain the exact current coin, its full parent transaction and
active-chain confirmation facts from your own node or chosen independent
source. Imported facts are not a self-proving chain-inclusion proof. A reorg
changes the current coin's waiting period; an old maturity estimate is not
permission to bypass it.

For recovery, run the read-only observation command shown below with
`--protocol presigned-graph-v3` and the current shared outpoint: funding output
`0`, or output `1` of the confirmed first withdrawal. Import its JSON under
**Recovery source observations**. Each signer obtains and checks their own
report; never treat a peer's contribution file as a chain report. The page
allows only the one reported shared graph coin, checks current membership, and
shows its block, confirmations, remaining delay and earliest candidate spend
height. It refuses missing/ambiguous reports and premature signing. A pending
spender is shown as a conflict, not as confirmed settlement.

After more blocks, a reorg or a changed source, obtain and import a new report.
Importing/replacing observations clears local recovery approval and contributions;
review again and exchange the newly reviewed public files. Changing the source
or approval during signing discards that pending result. Previously exported
signatures cannot be revoked. The page still cannot prove report freshness or
the honesty of the node that produced it.

For fixed recovery, the required remaining members exchange only the utility's
public contribution files. The complete setup approvals in the kits constrain
the fixed refunds, including the missing participant's refund. Review and
export the completed transaction, then submit its public signed bytes through
your own Bitcoin node. A missing participant can later unlock their own kit
and cash out their confirmed refund without the triggering participants.

If a cooperative signing session loses a secret nonce, abandon that session and
start a fresh one. Never recreate or reuse an old nonce. An interrupted public
signature exchange is not authority to change the agreed transaction.

## If a transaction needs a higher fee

Fee rescue adds a child transaction; it never replaces the agreed parent or
reduces anyone's fixed payout/refund. A separate, confirmed native P2WPKH or
P2TR coin from an external wallet pays the entire additional child fee. Never
use vault money, an unconfirmed coin, or a coin already promised elsewhere as
that sponsor. Unused sponsor money returns as change to the same wallet script;
this is separate from the preserved payout or funding-wallet refund.

In the website's **Adapt fees without changing the game** panel:

1. Choose **Refresh fee rescue**, then the **Approved parent needing fee
   rescue**. Enter the sponsor transaction ID/output index, exact additional
   child fee, and rate limits. Choose **Build exact fee rescue**.
2. Review the unchanged payout/refund, sponsor change, exact fee and both
   inputs. Approve the review checkbox and **Download unsigned fee PSBT**.
   Have the external wallet sign only its sponsor input. A funding-refund child
   also needs the refund owner's wallet signature; approve the explicit
   both-role option only if the same wallet owns both inputs.
3. Import the appropriate signed PSBT(s), choose **Verify wallet signatures
   and approve exact fee package**, and complete the required passkey prompts.
   Keep the downloaded public package. **Broadcast exact approved package**
   is a separate action. Sharing signed bytes already permits broadcasting;
   canceling a later passkey prompt cannot revoke those signatures.

Without the website, use the verified recovery HTML's **Optional exact-payout
fee rescue** section after verifying the exact signed parent. Import **Public
coin observations JSON**, enter the sponsor/fee limits and choose **Build fee
child for the reviewed signed parent**. Save the complete public draft and
unsigned external-wallet PSBT. Review and approve the exact child. For a game
payout, use **Sign my payout portion locally**; import the external wallet's
sponsor signature and **Verify wallet signatures**. A funding-refund child uses
the stated external-wallet roles instead. Finish with **Finalize and save signed
parent + fee child**. The utility does not broadcast.

The reviewed source package supplies the read-only observation helper at
`scripts/presigned-observe-coins.mts`. On the computer connected to your own
private Core, replace these placeholders with the reviewed network (`signet`
or `mainnet`), a credential-free private RPC URL, your owner-only Core cookie-file
path and the exact coins:

```sh
npm run presigned:observe-coins -- --protocol presigned-graph-v3 --network REVIEWED_NETWORK \
  --rpc-url PRIVATE_RPC_URL --cookie-file OWNER_ONLY_COOKIE_FILE \
  --coin PARENT_SOURCE_TXID:PARENT_SOURCE_VOUT \
  --coin SPONSOR_TXID:SPONSOR_VOUT --output NEW_OBSERVATIONS_JSON
```

For an unconfirmed parent, repeat `--coin` for every confirmed input it spends
(all three funding inputs for a funding parent), plus the sponsor. The helper
does not supply the full signed parent transaction: obtain that separately.
Move only the public observation file to the offline computer, never the Core
cookie. Observations are facts to recheck, not chain-inclusion proofs.
The protocol must match your saved kit. The helper retains a V2 default for
legacy callers; always pass the explicit V3 option shown here for a V3 vault.
The offline utility rejects mismatched protocols instead of converting them.

A rejected fee-draft import clears the previous draft, approval and signatures.
Editing fee inputs also requires rebuilding and reviewing again. Only a
successfully reviewed, unchanged draft can be signed or finalized.

If a saved fee child needs replacement, use **Prepare child-only fee
replacement** in the website, or supply the prior signed child hex offline,
then review and sign the higher-fee child using the same parent and sponsor.
Recheck current inputs before relay. Submit parent plus child while the parent
is unconfirmed; if it confirms while signing, submit only the child and do not
replace the parent or try to re-observe its now-spent original inputs. Relay
and confirmation are not guaranteed.

## Important limits

This software cannot recover a participant secret when every working passkey
and the portable kit/recovery-key combination are lost. A compromised device or
malicious replacement client can mislead its user. Confirmation time and relay
are not guaranteed, and additional fees may be necessary. Keep recovery
materials for old signed epochs even after changing devices or restarting setup.

Automated tests use virtual passkeys and isolated wallets. They do not establish
compatibility with your physical devices or a particular external-wallet product.
Independent AI review is not a professional security audit. Do not interpret
passing software tests as a guarantee that real funds are safe.
