import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Bitcoin Multiplayer Vault',
  description: 'A private, passkey-protected Bitcoin savings game for three friends.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
