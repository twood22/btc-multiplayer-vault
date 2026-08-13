import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

test('keeps the server-rendered action surface inert when hydration cannot run', async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error('browser test base URL is required');
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto('/');
    await expect(page.locator('body')).toHaveAttribute('inert', '');
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('button')).toContainText('Sign in with a passkey');
    expect(await page.locator('body').evaluate((body) => (body as HTMLElement).inert)).toBe(true);
  } finally {
    await context.close();
  }
});

test('registers, recovers, independently PRF-unlocks, and signs out one identity with two passkeys', async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error('browser test base URL is required');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the browser passkey test');
  const sql = postgres(databaseUrl, { max: 1 });
  const token = randomBytes(32).toString('base64url');
  const vaults = await sql<Array<{ id: string }>>`
    INSERT INTO vaults (name) VALUES ('Browser PRF acceptance vault') RETURNING id
  `;
  const vaultId = vaults[0]!.id;
  await sql`
    INSERT INTO invites (vault_id, participant_id, token_hash, expires_at)
    VALUES (
      ${vaultId}::uuid, 'alice', ${createHash('sha256').update(token).digest()},
      now() + interval '1 hour'
    )
  `;

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId: primaryAuthenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
      hasPrf: true,
    },
  });
  let recoveryAuthenticatorId: string | undefined;

  const serverBoundBodies: string[] = [];
  page.on('request', (request) => {
    if (/\/(envelope|unlock|authorize)\/finish$/u.test(new URL(request.url()).pathname)) {
      serverBoundBodies.push(request.postData() || '');
    }
  });

  try {
    await page.goto(`/join/${token}`);
    await expect(page.locator('body')).not.toHaveAttribute('inert', '');
    await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
    await page.getByLabel('Your name').fill('Alice Browser Test');
    await page.getByRole('button', { name: 'Create my passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Your seat is secured' })).toBeVisible();
    await expect(page.getByText('Your encrypted participant key is ready.')).toBeVisible();

    const initiallyPersisted = await sql<Array<{
      credentials: number;
      prf_credentials: number;
      envelopes: number;
      identities: number;
      plaintext_columns: number;
    }>>`
      SELECT
        (SELECT count(*)::integer FROM webauthn_credentials) AS credentials,
        (SELECT count(*)::integer FROM webauthn_credentials WHERE prf_enabled = true) AS prf_credentials,
        (SELECT count(*)::integer FROM passkey_envelopes) AS envelopes,
        (SELECT count(*)::integer FROM participant_key_material) AS identities,
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name IN ('private_key', 'participant_secret', 'prf_output')) AS plaintext_columns
    `;
    expect(initiallyPersisted[0]).toEqual({
      credentials: 1,
      prf_credentials: 1,
      envelopes: 1,
      identities: 1,
      plaintext_columns: 0,
    });
    expect(serverBoundBodies).toHaveLength(1);
    expect(serverBoundBodies[0]).not.toContain('"results"');

    await page.goto('/vault');
    await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toBeVisible();
    ({ authenticatorId: recoveryAuthenticatorId } = await cdp.send(
      'WebAuthn.addVirtualAuthenticator',
      {
        options: {
          protocol: 'ctap2',
          ctap2Version: 'ctap2_1',
          transport: 'usb',
          hasResidentKey: true,
          hasUserVerification: true,
          automaticPresenceSimulation: true,
          isUserVerified: true,
          hasPrf: true,
        },
      },
    ));
    const recoveryId = recoveryAuthenticatorId;
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
            authenticatorId: recoveryId,
            enabled: true,
          }),
        ]).then(() => resolve(), reject);
      });
    });
    await page.getByLabel('Recovery passkey name').fill('Backup browser passkey');
    await page.getByRole('button', { name: 'Add recovery passkey' }).click();
    await switched;
    await expect.poll(async () => {
      const rows = await sql<Array<{ credentials: number; envelopes: number; identities: number }>>`
        SELECT
          (SELECT count(*)::integer FROM webauthn_credentials WHERE prf_enabled = true) AS credentials,
          (SELECT count(*)::integer FROM passkey_envelopes) AS envelopes,
          (SELECT count(*)::integer FROM participant_key_material) AS identities
      `;
      return rows[0];
    }).toEqual({ credentials: 2, envelopes: 2, identities: 1 });
    await expect(page.getByRole('heading', { name: 'Add a recovery passkey' })).toHaveCount(0);
    expect(serverBoundBodies).toHaveLength(3);
    for (const body of serverBoundBodies) expect(body).not.toContain('"results"');

    const primaryCredentials = await cdp.send('WebAuthn.getCredentials', {
      authenticatorId: primaryAuthenticatorId,
    });
    const recoveryCredentials = await cdp.send('WebAuthn.getCredentials', {
      authenticatorId: recoveryId,
    });
    expect(primaryCredentials.credentials).toHaveLength(1);
    expect(recoveryCredentials.credentials).toHaveLength(1);

    // Prove the recovery passkey works with the primary authenticator absent.
    await context.clearCookies();
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page).toHaveURL(/\/vault$/u);
    await expect(page.getByRole('heading', { name: 'Your side of the vault is set up.' })).toBeVisible();
    const recoveryUnlock = page.locator('.unlock-card');
    await recoveryUnlock.getByLabel('Passkey').selectOption({ label: 'Backup browser passkey' });
    await recoveryUnlock.getByRole('button', { name: 'Verify my key' }).click();
    await expect(page.getByRole('heading', {
      name: 'Participant key unlocked and identity verified',
    })).toBeVisible();

    // Then prove the original passkey still works with the recovery device absent.
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: recoveryId,
      enabled: false,
    });
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: primaryAuthenticatorId,
      enabled: true,
    });
    await context.clearCookies();
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page).toHaveURL(/\/vault$/u);
    const primaryUnlock = page.locator('.unlock-card');
    await primaryUnlock.getByLabel('Passkey').selectOption({ index: 0 });
    await primaryUnlock.getByRole('button', { name: 'Verify my key' }).click();
    await expect(page.getByRole('heading', {
      name: 'Participant key unlocked and identity verified',
    })).toBeVisible();
    for (const body of serverBoundBodies) expect(body).not.toContain('"results"');

    // Sign out must revoke this exact server session and remove only vault-scoped
    // ephemeral signing state from the browser tab.
    await page.evaluate(() => {
      sessionStorage.setItem('btc-vault:musig2-nonce:acceptance', 'encrypted nonce fixture');
      sessionStorage.setItem('unrelated-session-key', 'preserve me');
    });
    const currentCookie = (await context.cookies()).find((cookie) =>
      cookie.name === 'vault_session_dev' || cookie.name === '__Host-vault_session');
    if (!currentCookie) throw new Error('authenticated session cookie is missing before sign-out');
    const currentTokenHash = createHash('sha256').update(currentCookie.value).digest();
    const currentSessionBefore = await sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM sessions WHERE token_hash = ${currentTokenHash}
    `;
    expect(currentSessionBefore[0]?.count).toBe(1);

    const crossOriginAttempt = await context.request.post('/api/session/logout', {
      data: {},
      headers: { origin: 'https://not-the-vault.example' },
    });
    expect(crossOriginAttempt.status()).toBe(400);
    const currentSessionAfterHostileRequest = await sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM sessions WHERE token_hash = ${currentTokenHash}
    `;
    expect(currentSessionAfterHostileRequest[0]?.count).toBe(1);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Save together. Leave on your own terms.' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('btc-vault:musig2-nonce:acceptance'))).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('unrelated-session-key'))).toBe('preserve me');
    expect((await context.cookies()).some((cookie) =>
      cookie.name === 'vault_session_dev' || cookie.name === '__Host-vault_session')).toBe(false);
    const currentSessionAfter = await sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM sessions WHERE token_hash = ${currentTokenHash}
    `;
    expect(currentSessionAfter[0]?.count).toBe(0);
    const repeatedSignOut = await page.evaluate(async () => {
      const response = await fetch('/api/session/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { status: response.status, body: await response.json() };
    });
    expect(repeatedSignOut).toEqual({ status: 200, body: { signedOut: true } });
  } finally {
    for (const authenticatorId of [recoveryAuthenticatorId, primaryAuthenticatorId]) {
      if (authenticatorId) {
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
      }
    }
    await sql.end();
  }
});
