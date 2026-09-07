import 'server-only';

/** Bound public JSON before parsing; never accept recovery ciphertext or secret inputs here. */
export async function readPresignedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('JSON body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 96 * 1024) throw new Error('presigned request is too large');
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
