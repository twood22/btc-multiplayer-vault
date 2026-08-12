import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { sigbashRuntimeConfig } from '@/web/lib/server/sigbash-runtime';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireSessionUser();
    const config = sigbashRuntimeConfig();
    return Response.json({
      serverUrl: config.serverUrl,
      wasmUrl: config.wasmUrl,
      wasmSha384: config.wasmSha384,
      sdkVersion: config.sdkVersion,
    });
  } catch (error) {
    return jsonError(error);
  }
}
