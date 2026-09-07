export function presignedSourceDigest(repository?: string): string;
export function recordPresignedBuildIdentity(): {
  version: number; protocol: string; network: string; sourceDigest: string;
};
