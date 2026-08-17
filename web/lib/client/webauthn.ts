import { fromBase64url, toBase64url } from './base64url';

type JsonRecord = Record<string, unknown>;

interface PrfOutput {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer; second?: ArrayBuffer };
  };
}

export async function createPasskey(optionsJSON: JsonRecord): Promise<JsonRecord> {
  requireWebAuthn();
  const user = optionsJSON.user as JsonRecord;
  const exclude = (optionsJSON.excludeCredentials as JsonRecord[] | undefined) || [];
  const publicKey = {
    ...optionsJSON,
    challenge: fromBase64url(String(optionsJSON.challenge)),
    user: { ...user, id: fromBase64url(String(user.id)) },
    excludeCredentials: exclude.map((credential) => ({
      ...credential,
      id: fromBase64url(String(credential.id)),
    })),
  } as unknown as PublicKeyCredentialCreationOptions;
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('browser did not return a passkey credential');
  return credentialToJson(credential);
}

export async function assertPasskeyWithPrf(optionsJSON: JsonRecord): Promise<{
  response: JsonRecord;
  prfOutput: Uint8Array;
}> {
  requireWebAuthn();
  const allow = (optionsJSON.allowCredentials as JsonRecord[] | undefined) || [];
  const extensions = structuredClone((optionsJSON.extensions || {}) as JsonRecord);
  const prf = extensions.prf as { evalByCredential?: Record<string, { first: string; second?: string }> } | undefined;
  if (!prf?.evalByCredential) throw new Error('server did not bind a PRF salt to this passkey');
  const evalByCredential = Object.fromEntries(
    Object.entries(prf.evalByCredential).map(([credentialId, values]) => [
      credentialId,
      {
        first: fromBase64url(values.first),
        ...(values.second ? { second: fromBase64url(values.second) } : {}),
      },
    ]),
  );
  const publicKey = {
    ...optionsJSON,
    challenge: fromBase64url(String(optionsJSON.challenge)),
    allowCredentials: allow.map((credential) => ({
      ...credential,
      id: fromBase64url(String(credential.id)),
    })),
    extensions: { ...extensions, prf: { evalByCredential } },
  } as unknown as PublicKeyCredentialRequestOptions;
  const credential = await navigator.credentials.get({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('browser did not return a passkey assertion');
  const extensionResults = credential.getClientExtensionResults() as PrfOutput;
  const first = extensionResults.prf?.results?.first;
  if (!first) {
    throw new Error(
      'This passkey does not provide the PRF protection required to encrypt a Bitcoin key. Use a current platform passkey or compatible security key.',
    );
  }
  const prfOutput = new Uint8Array(first.slice(0));
  const response = credentialToJson(credential);
  stripPrfSecrets(response);
  return { response, prfOutput };
}

export async function assertPasskey(optionsJSON: JsonRecord): Promise<JsonRecord> {
  requireWebAuthn();
  const allow = (optionsJSON.allowCredentials as JsonRecord[] | undefined) || [];
  const publicKey = {
    ...optionsJSON,
    challenge: fromBase64url(String(optionsJSON.challenge)),
    allowCredentials: allow.map((credential) => ({
      ...credential,
      id: fromBase64url(String(credential.id)),
    })),
  } as unknown as PublicKeyCredentialRequestOptions;
  const credential = await navigator.credentials.get({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('browser did not return a passkey assertion');
  return credentialToJson(credential);
}

/** Defense in depth: a PRF result is an encryption key and must never cross the network. */
export function stripPrfSecrets(response: JsonRecord): void {
  const extensions = response.clientExtensionResults as JsonRecord | undefined;
  const prf = extensions?.prf as JsonRecord | undefined;
  if (prf) delete prf.results;
}

function credentialToJson(credential: PublicKeyCredential): JsonRecord {
  const response = credential.response;
  const extensionResults = jsonify(credential.getClientExtensionResults()) as JsonRecord;
  if (response instanceof AuthenticatorAttestationResponse) {
    return {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: extensionResults,
      response: {
        clientDataJSON: toBase64url(response.clientDataJSON),
        attestationObject: toBase64url(response.attestationObject),
        transports: response.getTransports(),
      },
    };
  }
  if (response instanceof AuthenticatorAssertionResponse) {
    return {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: extensionResults,
      response: {
        clientDataJSON: toBase64url(response.clientDataJSON),
        authenticatorData: toBase64url(response.authenticatorData),
        signature: toBase64url(response.signature),
        userHandle: response.userHandle ? toBase64url(response.userHandle) : undefined,
      },
    };
  }
  throw new Error('unsupported WebAuthn response type');
}

function jsonify(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return toBase64url(value);
  if (ArrayBuffer.isView(value)) {
    return toBase64url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map(jsonify);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonify(item)]));
  }
  return value;
}

function requireWebAuthn(): void {
  if (!window.isSecureContext || !window.PublicKeyCredential) {
    throw new Error('Passkeys require a secure HTTPS context (localhost is allowed for development).');
  }
}
