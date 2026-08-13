'use client';

import { useState } from 'react';

export function SignOutButton() {
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('');

  async function signOut() {
    setWorking(true);
    setStatus('');
    try {
      const response = await fetch('/api/session/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `Sign-out failed (${response.status})`);
      clearVaultSessionStorage();
      window.location.replace('/');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sign-out failed');
      setWorking(false);
    }
  }

  return (
    <span className="sign-out-control">
      <button disabled={working} onClick={signOut} type="button">
        {working ? 'Signing out…' : 'Sign out'}
      </button>
      {status && <span role="status">{status}</span>}
    </span>
  );
}

function clearVaultSessionStorage(): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith('btc-vault:')) sessionStorage.removeItem(key);
    }
  } catch {
    // The server session is already revoked. Continue to the signed-out page
    // even when a restrictive browser makes sessionStorage unavailable.
  }
}
