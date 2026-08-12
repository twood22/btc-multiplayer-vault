import 'server-only';

export interface WebConfig {
  rpName: string;
  rpID: string;
  origin: string;
  appOrigin: string;
}

export function webConfig(): WebConfig {
  const rpName = process.env.WEBAUTHN_RP_NAME || 'Bitcoin Multiplayer Vault';
  const rpID = required('WEBAUTHN_RP_ID');
  const origin = normalizedOrigin(required('WEBAUTHN_ORIGIN'), 'WEBAUTHN_ORIGIN');
  const appOrigin = normalizedOrigin(process.env.APP_ORIGIN || origin, 'APP_ORIGIN');
  const originUrl = new URL(origin);
  const local = originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
  if (!local && originUrl.protocol !== 'https:') {
    throw new Error('WEBAUTHN_ORIGIN must use HTTPS outside localhost');
  }
  if (originUrl.hostname !== rpID && !originUrl.hostname.endsWith(`.${rpID}`)) {
    throw new Error('WEBAUTHN_RP_ID must equal the origin host or a registrable suffix of it');
  }
  return { rpName, rpID, origin, appOrigin };
}

export function chainObservationOrigins(): string[] {
  const app = webConfig();
  const origins = required('CHAIN_OBSERVATION_ORIGINS')
    .split(',')
    .map((value) => normalizedOrigin(value.trim(), 'CHAIN_OBSERVATION_ORIGINS'));
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new Error('CHAIN_OBSERVATION_ORIGINS must contain distinct HTTPS origins');
  }
  for (const origin of origins) {
    if (new URL(origin).protocol !== 'https:') {
      throw new Error('CHAIN_OBSERVATION_ORIGINS must use HTTPS');
    }
    if (origin === app.appOrigin || origin === app.origin) {
      throw new Error('chain observation origin must be independent from the vault service');
    }
  }
  return origins;
}

export function chainConfirmationsRequired(): number {
  const raw = required('VAULT_CONFIRMATIONS_REQUIRED');
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 144) {
    throw new Error('VAULT_CONFIRMATIONS_REQUIRED must be an integer from 1 to 144');
  }
  return value;
}

function normalizedOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must be a bare origin with no path, query, credentials, or fragment`);
  }
  return url.origin;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
