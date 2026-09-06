/** A newly generated credential has no registered PoP signer until createKey. */
export async function readProvisioningKeys<T>(
  client: { listKeys(): Promise<T[]> }, allowNewOrganization: boolean,
): Promise<T[]> {
  try { return await client.listKeys(); }
  catch (error) {
    // Only an explicitly new, first-slot organization may proceed past the
    // provider's known pre-registration authentication response. A timeout,
    // outage, policy mismatch, or failed resume is never evidence of absence.
    if (allowNewOrganization && error instanceof Error &&
        /request signature missing or invalid/iu.test(error.message)) return [];
    throw error;
  }
}
