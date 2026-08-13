import type { Metadata } from 'next';
import { HydrationReady } from '../web/components/hydration-ready';
import './styles.css';

export const metadata: Metadata = {
  title: 'Bitcoin Multiplayer Vault',
  description: 'A private, passkey-protected Bitcoin savings game for three friends.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body inert aria-busy="true">
        {children}
        <HydrationReady />
      </body>
    </html>
  );
}
