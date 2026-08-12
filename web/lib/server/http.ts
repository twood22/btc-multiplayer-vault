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
  return NextResponse.json({ error: message }, { status });
}
