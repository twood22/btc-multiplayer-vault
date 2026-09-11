# Dependency security checkpoint — 2026-09-11 UTC

Current executable source:
`49e4240d66a9780a7403996e4cca96478eb50e797e158ffb38157d910c9071ae`.
This is a patched candidate, not complete software acceptance or funding approval.

The fresh frozen installation reported one critical and one high affected
package. The exact before/after audits are retained privately, including their
actual exit codes and source/lockfile hashes. The former source used Next.js
16.3.0 and sharp 0.35.3. The new manifest pins Next.js 16.3.3, and the lockfile
selects sharp 0.35.4 plus its matching optional binaries. Next.js also requires
the changed `@next` binaries/environment package and `@swc/helpers` 0.5.23.
No cryptographic, passkey, React or Playwright dependency was changed.

The reviewed upstream advisories are:

- [Next.js Windows-hosted RCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36), patched in 16.3.3. The current execution host and tested images are Linux, not Windows.
- [Next.js AVIF image-optimization RCE](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4), patched in 16.3.3.
- [sharp/libheif advisories](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c), patched by sharp 0.35.4 with libheif 1.23.2.

No exploit was attempted or compromise demonstrated. The app has no `next/image`
imports and no public exposure is authorized; neither fact justifies shipping
the affected dependency. Updating supported packages does not change host
security policy or the vault's protocol, custody, payouts or transaction gates.

Verification completed at this checkpoint:

- A real locked installation completed successfully. Loading the installed
  sharp native library reports sharp 0.35.4, libheif 1.23.2 and libvips 8.18.6.
- The exact former-source audit exited 1 with two affected packages; the exact
  current-source audit exited 0 with zero known advisories at 00:49:10 UTC.
  This is registry-advisory coverage, not universal security proof.
- All four TypeScript configurations passed. The actual offline build remains
  1,989,600 bytes with unchanged SHA-256
  `3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807`.
- Before/after audit verification SHA-256:
  `3c0d526cafac0955ed716f0986e33a12e2aecc884891ee301d7890ea566b8378`;
  raw audit hashes `fe95de9a42698b462cd2aad0c38a9d6693db00988110e4e8917fedcdad077d01`
  and `dc6e6572d840702d6f362f55d021319f2a712b2a90acec634a52ae972863fead`.

The preceding harness-correction source `1cc9f5f9` actually passed its complete
optimized browser game at 00:42:03 UTC: six virtual PRF credentials, four genuine
reauthentications, cooperative/CSV/solo/final-sweep and fee paths, zero public
broadcasts, no forbidden or sensitive-request audit findings. All three selected
artifacts (61,022 bytes) are retained and were rehashed against the originals.
This remains historical evidence for that exact dependency set. Its new full
private wrapper was never launched. CI `34547333766` was deliberately cancelled
after the dependency finding, not after an observation timeout; its mainnet-format
job had passed, but this is not a complete CI pass. The associated empty test-only
draft `386713419` remains unpublished, and its retention tooling was not pushed.

Independent dependency review found no actionable delta issue: only two of 373
executable-source files changed, and the 39 changed lock records (including the
root) are confined to the listed dependency families; 111 records are identical.
The actual installed Playwright snapshot guard and spec invocation are unchanged.
Historical narrow-byte review also checked all nine safe harness files and all
three original/copied artifacts; diagnostic SHA-256:
`9e99c6aea327ff4d11bf27712a5d4cc8857e4f9476553fd1eda7dbc889639726`.

Remaining: a fresh complete 52-command run and both exact-image profiles with
actual retained-byte review, new source-bound
operational preparation, all 19 funded real default-Signet cases and both final
assemblies. Physical passkeys remain deferred. No recovered test coins moved,
and no mainnet use, public application exposure or outreach is authorized.
