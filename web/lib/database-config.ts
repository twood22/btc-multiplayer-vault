export interface DatabaseEndpointCheck {
  ok: boolean;
  detail: string;
}

export function assertDatabaseUrl(
  raw: string | undefined,
  options: { production: boolean },
): string {
  if (!raw) throw new Error('DATABASE_URL is required');
  const checked = inspectDatabaseUrl(raw, options.production);
  if (!checked.ok) throw new Error(checked.error!);
  return raw;
}

export function databaseEndpointCheck(raw: string): DatabaseEndpointCheck {
  const checked = inspectDatabaseUrl(raw, true);
  if (checked.ok && isLocalHostname(new URL(raw).hostname)) {
    return { ok: false, detail: 'local database endpoint' };
  }
  return { ok: checked.ok, detail: checked.detail };
}

function inspectDatabaseUrl(
  raw: string,
  production: boolean,
): { ok: boolean; detail: string; error?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return failure('database URL is malformed');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
      !url.pathname || url.pathname === '/' || url.hash) {
    return failure('DATABASE_URL must be a PostgreSQL URL with a host and database name');
  }
  if (!production) return { ok: true, detail: 'development database URL accepted' };

  if (isLocalHostname(url.hostname)) {
    // Loopback never leaves the host and is needed for isolated production-build
    // acceptance tests. The release gate separately rejects local endpoints.
    return { ok: true, detail: 'local database endpoint' };
  }
  const sslModes = url.searchParams.getAll('sslmode');
  if (sslModes.length !== 1 || sslModes[0] !== 'verify-full') {
    return failure(
      'production DATABASE_URL must set sslmode=verify-full so the server certificate and hostname are verified',
      `sslmode=${sslModes.length === 1 ? sslModes[0] : sslModes.length ? 'ambiguous' : 'absent'}`,
    );
  }
  return { ok: true, detail: 'non-local endpoint; sslmode=verify-full' };
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' ||
    normalized.endsWith('.localhost');
}

function failure(error: string, detail = error): { ok: false; detail: string; error: string } {
  return { ok: false, detail, error };
}
