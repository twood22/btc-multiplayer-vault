import 'server-only';
import { cookies } from 'next/headers';
import { db } from './db';
import { randomToken, tokenHash } from './encoding';

const SESSION_SECONDS = 15 * 60;

function cookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-vault_session' : 'vault_session_dev';
}

export async function createSession(userId: string): Promise<void> {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000);
  await db()`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash(token)}, ${userId}::uuid, ${expires})
  `;
  const jar = await cookies();
  jar.set(cookieName(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}

export async function requireSessionUser(): Promise<string> {
  const token = (await cookies()).get(cookieName())?.value;
  if (!token) throw new Error('authentication required');
  const rows = await db()<Array<{ user_id: string }>>`
    SELECT user_id
    FROM sessions
    WHERE token_hash = ${tokenHash(token)} AND expires_at > now()
  `;
  const userId = rows[0]?.user_id;
  if (!userId) throw new Error('session expired');
  return userId;
}
