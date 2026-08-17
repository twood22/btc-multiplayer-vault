import 'server-only';
import { createHash } from 'node:crypto';
import { db } from './db';

export class RateLimitError extends Error {
  readonly statusCode = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('too many attempts; wait before trying again');
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Atomically consume one attempt without storing the raw subject identifier. */
export async function consumeRateLimit(input: {
  action: string;
  subject: string;
  limit: number;
  windowSeconds: number;
}): Promise<void> {
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(input.action)) throw new Error('rate-limit action is invalid');
  if (!input.subject || input.subject.length > 4096) throw new Error('rate-limit subject is invalid');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
    throw new Error('rate-limit count is invalid');
  }
  if (!Number.isSafeInteger(input.windowSeconds) || input.windowSeconds < 1 || input.windowSeconds > 86_400) {
    throw new Error('rate-limit window is invalid');
  }
  const subjectHash = createHash('sha256')
    .update(input.action)
    .update('\0')
    .update(input.subject)
    .digest();
  const rows = await db()<Array<{ attempts: number; retry_after_seconds: number }>>`
    INSERT INTO security_rate_limits (
      action, subject_hash, window_started, attempts
    ) VALUES (
      ${input.action}, ${subjectHash}, now(), 1
    )
    ON CONFLICT (action, subject_hash) DO UPDATE SET
      attempts = CASE
        WHEN security_rate_limits.window_started <=
          now() - make_interval(secs => ${input.windowSeconds})
        THEN 1 ELSE security_rate_limits.attempts + 1
      END,
      window_started = CASE
        WHEN security_rate_limits.window_started <=
          now() - make_interval(secs => ${input.windowSeconds})
        THEN now() ELSE security_rate_limits.window_started
      END,
      updated_at = now()
    RETURNING attempts,
      GREATEST(1, ceil(extract(epoch FROM (
        window_started + make_interval(secs => ${input.windowSeconds}) - now()
      )))::integer) AS retry_after_seconds
  `;
  const result = rows[0];
  if (!result) throw new Error('rate-limit counter was not recorded');
  if (result.attempts > input.limit) throw new RateLimitError(result.retry_after_seconds);
}
