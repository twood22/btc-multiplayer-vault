import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { PasskeySetup } from '@/web/components/passkey-setup';

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) notFound();
  return (
    <main className="shell join-shell">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true">₿</div>
        <div>
          <strong>Bitcoin Multiplayer Vault</strong>
          <span>Secure setup</span>
        </div>
      </header>
      <div className="join-grid">
        <section className="join-copy">
          <p className="eyebrow">You have been invited</p>
          <h1>Set up your side of the vault.</h1>
          <p>
            Your passkey protects your participant key. The raw key stays in this browser and is
            encrypted before anything is stored.
          </p>
          <ul>
            <li>Nothing is funded during setup.</li>
            <li>No friend or server receives your plaintext key.</li>
            <li>Unsupported passkeys fail before a vault address is approved.</li>
          </ul>
        </section>
        <PasskeySetup inviteToken={token} />
      </div>
    </main>
  );
}
