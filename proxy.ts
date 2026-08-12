import { NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const sigbashConnectSources = sigbashConnectSource();
  const chainConnectSources = chainObservationConnectSources();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-inline'" : ''}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${sigbashConnectSources} ${chainConnectSources}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    'upgrade-insecure-requests',
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return response;
}

function chainObservationConnectSources(): string {
  try {
    const appOrigins = new Set([
      process.env.WEBAUTHN_ORIGIN,
      process.env.APP_ORIGIN,
    ].filter(Boolean).map((value) => new URL(value!).origin));
    return [...new Set((process.env.CHAIN_OBSERVATION_ORIGINS || '')
      .split(',')
      .filter(Boolean)
      .map((value) => externalHttpsUrl(value.trim()).origin))]
      .filter((origin) => !appOrigins.has(origin))
      .join(' ');
  } catch {
    return '';
  }
}

function sigbashConnectSource(): string {
  try {
    const serverUrl = externalHttpsUrl(
      process.env.SIGBASH_SERVER_URL || 'https://www.sigbash.com',
    );
    const wasmUrl = externalHttpsUrl(
      process.env.SIGBASH_WASM_URL || 'https://www.sigbash.com/sigbash.wasm',
    );
    return [...new Set([
      serverUrl.origin,
      wasmUrl.origin,
      `wss://${serverUrl.host}`,
    ])].join(' ');
  } catch {
    // Fail closed: an invalid operator URL receives no external CSP access.
    return '';
  }
}

function externalHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('invalid Sigbash URL');
  }
  return url;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
