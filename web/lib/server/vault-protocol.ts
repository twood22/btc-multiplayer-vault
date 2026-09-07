import 'server-only';
import { LEGACY_PROTOCOL, PRESIGNED_PROTOCOL } from '../../../src/presigned/types';
import { db } from './db';

/** Resolve the durable discriminator before invoking any protocol-specific store. */
export async function getUserVaultProtocol(userId: string): Promise<typeof LEGACY_PROTOCOL | typeof PRESIGNED_PROTOCOL> {
  const rows = await db()<Array<{ protocol: string }>>`
    SELECT v.protocol FROM vaults v JOIN vault_members m ON m.vault_id = v.id
    WHERE m.user_id = ${userId}::uuid
  `;
  if (rows.length !== 1 || ![LEGACY_PROTOCOL, PRESIGNED_PROTOCOL].includes(rows[0]!.protocol as typeof LEGACY_PROTOCOL)) {
    throw new Error('exactly one explicitly versioned vault membership is required');
  }
  return rows[0]!.protocol as typeof LEGACY_PROTOCOL | typeof PRESIGNED_PROTOCOL;
}

export async function assertLegacyVault(vaultId: string): Promise<void> {
  const rows = await db()<Array<{ protocol: string }>>`SELECT protocol FROM vaults WHERE id = ${vaultId}::uuid`;
  if (rows.length !== 1 || rows[0]!.protocol !== LEGACY_PROTOCOL) {
    throw new Error('legacy protocol cannot operate on a presigned vault');
  }
}
