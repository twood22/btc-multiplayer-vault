import 'server-only';
import { NextResponse } from 'next/server';
import { webConfig } from './config';

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin !== webConfig().origin) throw new Error('request origin is not allowed');
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Error('content-type must be application/json');
  }
}

export function jsonError(error: unknown, status = 400): NextResponse {
  const message = error instanceof Error ? error.message : 'request failed';
  const errorStatus = error && typeof error === 'object' &&
    (error as { statusCode?: unknown }).statusCode === 429 ? 429 : status;
  const retryAfter = errorStatus === 429 && error && typeof error === 'object'
    ? (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
    : undefined;
  return NextResponse.json(
    { error: message },
    {
      status: errorStatus,
      ...(typeof retryAfter === 'number'
        ? { headers: { 'retry-after': String(retryAfter) } }
        : {}),
    },
  );
}
