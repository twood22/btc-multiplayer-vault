import { connection } from 'next/server';
import { PasskeySignIn } from '@/web/components/passkey-sign-in';
import { BITCOIN_NETWORK_CONFIG, BITCOIN_NETWORK_NAME } from '@/src/network';

export default async function HomePage() {
  await connection();
  return (
    <main className="shell">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true">₿</div>
        <div className="brand-copy">
          <strong>Bitcoin Multiplayer Vault</strong>
          <span>Private beta</span>
        </div>
      </header>
      <section className="hero">
        <p className="eyebrow">Three friends. One Bitcoin game.</p>
        <h1>Save together. Leave on your own terms.</h1>
        <p className="lede">
          Each friend controls their own key. Cooperative exits never depend on Sigbash. Solo exits
          follow the agreed haircut-and-bonus rules.
        </p>
        <div className="status-grid">
          <article>
            <span>01</span>
            <h2>Your own key</h2>
            <p>A passkey unlocks an encrypted participant key created in your browser.</p>
          </article>
          <article>
            <span>02</span>
            <h2>Verify together</h2>
            <p>All three people confirm one roster and one vault address before funding.</p>
          </article>
          <article>
            <span>03</span>
            <h2>{BITCOIN_NETWORK_NAME === 'mainnet' ? 'Mainnet gated' : 'Signet validation'}</h2>
            <p>Funding stays off until live Sigbash signing and every {BITCOIN_NETWORK_CONFIG.addressLabel} check pass.</p>
          </article>
        </div>
        <div className="invite-callout">
          <strong>Invitation required</strong>
          <p>Use the private link sent by the person creating your vault.</p>
        </div>
        <PasskeySignIn />
      </section>
    </main>
  );
}
