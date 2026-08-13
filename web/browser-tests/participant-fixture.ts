import { expect, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import postgres from 'postgres';
import {
  base58CheckEncode,
  deriveXpubChildPubkey,
  deterministicKeypair,
  sha256Hex,
  xpubRootXonly,
} from '../../src/crypto.js';
import { participantLeaveRounds } from '../../src/vault.js';

export type ParticipantId = 'alice' | 'bob' | 'carol';

export interface ParticipantBrowser {
  id: ParticipantId;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  primaryAuthenticatorId: string;
  recoveryAuthenticatorId: string;
}

export const participants: ParticipantId[] = ['alice', 'bob', 'carol'];

export async function createParticipantBrowser(input: {
  browser: Browser;
  baseURL: string;
  id: ParticipantId;
  invitationToken: string;
  onRequest: (requestUrl: string) => void;
}): Promise<ParticipantBrowser> {
  const context = await input.browser.newContext({ baseURL: input.baseURL });
  const page = await context.newPage();
  page.on('request', (request) => input.onRequest(request.url()));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId: primaryAuthenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    { options: virtualAuthenticator('internal', true) },
  );
  await page.goto(`/join/${input.invitationToken}`);
  await page.getByLabel('Your name').fill(`${capitalize(input.id)} Browser Acceptance`);
  await page.getByRole('button', { name: 'Create my passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Your seat is secured' })).toBeVisible();

  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toBeVisible();
  const { authenticatorId: recoveryAuthenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    { options: virtualAuthenticator('usb', false) },
  );
  let switchedToRecovery = false;
  const switched = new Promise<void>((resolve, reject) => {
    cdp.on('WebAuthn.credentialAsserted', (event) => {
      if (switchedToRecovery || event.authenticatorId !== primaryAuthenticatorId) return;
      switchedToRecovery = true;
      void Promise.all([
        cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
          authenticatorId: primaryAuthenticatorId,
          enabled: false,
        }),
        cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
          authenticatorId: recoveryAuthenticatorId,
          enabled: true,
        }),
      ]).then(() => resolve(), reject);
    });
  });
  await page.getByLabel('Recovery passkey name').fill(`${capitalize(input.id)} recovery key`);
  await page.getByRole('button', { name: 'Add recovery passkey' }).click();
  await switched;
  await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toHaveCount(0);
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: recoveryAuthenticatorId,
    enabled: false,
  });
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: primaryAuthenticatorId,
    enabled: true,
  });

  await expect(page.getByRole('heading', { name: 'Create your Sigbash identity' })).toBeVisible();
  await page.getByRole('button', { name: 'Create protected identity' }).click();
  await expect(page.getByRole('heading', { name: 'Sigbash identity protected' })).toBeVisible();
  return {
    id: input.id,
    context,
    page,
    cdp,
    primaryAuthenticatorId,
    recoveryAuthenticatorId,
  };
}

export async function seedPublicSigbashRegistrations(
  sql: ReturnType<typeof postgres>,
  vaultId: string,
  members: Array<{ user_id: string; participant_id: ParticipantId }>,
): Promise<void> {
  for (const member of members) {
    const rounds = participantLeaveRounds(member.participant_id, participants);
    for (const [keyIndex, round] of rounds.entries()) {
      const xpub = syntheticMainnetXpub(`${vaultId}:${member.participant_id}:${round}`);
      await sql`
        INSERT INTO participant_sigbash_keys (
          vault_id, user_id, participant_id, round_id, network, key_id, key_index,
          bip328_xpub, policy_leaf_xonly, identification_leaf_xonly, policy_root, policy_id
        ) VALUES (
          ${vaultId}::uuid, ${member.user_id}::uuid, ${member.participant_id}, ${round},
          'mainnet', ${`browser-public-fixture:${member.participant_id}:${round}`}, ${keyIndex},
          ${xpub}, ${Buffer.from(deriveXpubChildPubkey(xpub, [0, 0]).xonlyPubKeyHex, 'hex')},
          ${Buffer.from(xpubRootXonly(xpub), 'hex')},
          ${Buffer.from(sha256Hex(`browser-policy-root:${vaultId}:${member.participant_id}:${round}`), 'hex')},
          ${`${round}:${member.participant_id}`}
        )
      `;
    }
  }
}

function virtualAuthenticator(
  transport: 'internal' | 'usb',
  automaticPresenceSimulation: boolean,
) {
  return {
    protocol: 'ctap2',
    ctap2Version: 'ctap2_1',
    transport,
    hasResidentKey: true,
    hasUserVerification: true,
    automaticPresenceSimulation,
    isUserVerified: true,
    hasPrf: true,
  } as const;
}

function syntheticMainnetXpub(label: string): string {
  const root = deterministicKeypair('browser-vault-acceptance', `${label}:root`);
  return base58CheckEncode(Buffer.concat([
    Buffer.from('0488b21e', 'hex'),
    Buffer.from([0]),
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from(sha256Hex(`${label}:chain-code`), 'hex'),
    Buffer.from(root.publicKeyHex, 'hex'),
  ]));
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}
