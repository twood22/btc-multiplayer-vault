# Private-beta deployment runbook

This runbook packages the real round-based Bitcoin multiplayer vault. It does
not authorize deployment or funding. Do not deploy the service until an
independent predeployment command has obtained and locally authorized a real
Sigbash mainnet signature. All nine in-product readiness proofs remain a later
funding gate. Funding is always a separate decision.

## Runtime shape

Use the reviewed `Dockerfile` as one immutable image with three execution
roles:

1. **Migration job** — run once per release: `npm run web:migrate`.
2. **Web service** — run `node server.js` as the image's unprivileged `node`
   user. Start with one replica for the three-person beta.
3. **Private chain watcher** — run `npm run web:watch-chain` on a private
   scheduler. Never expose this command as an HTTP endpoint.

The image uses Next.js standalone output, includes the reviewed operator
scripts, and receives configuration only at runtime. Do not pass credentials as
Docker build arguments or bake `.env.local` into an image. The `.dockerignore`
excludes every `.env*` file except the empty example.

The base is the official Node 22.23.2 Debian Bookworm slim multi-architecture
image pinned by manifest digest. Update its version and digest together, rerun
the complete suite under the new runtime, and update the release checker before
building a later release.

The web role exposes:

- `GET /api/health/live`: process liveness only.
- `GET /api/health/ready`: database reachability and exact migration-set
  readiness. It always returns `fundingAuthorized: false`.

Neither endpoint checks or bypasses Sigbash, passkey, roster, broadcast, or
funding gates. Configure the platform's health probe to use the readiness path.

## Required runtime configuration

Set the variables documented in `.env.example`, including:

- exact HTTPS `WEBAUTHN_ORIGIN` and matching `APP_ORIGIN`;
- the exact WebAuthn relying-party host in `WEBAUTHN_RP_ID`;
- a PostgreSQL 16+ `DATABASE_URL` on a non-local host with
  `sslmode=verify-full`;
- one or more independent HTTPS `CHAIN_OBSERVATION_ORIGINS`;
- a mainnet Bitcoin Core or Esplora backend;
- reviewed Sigbash runtime URLs and SHA-384 pins;
- explicit tiny-mainnet economics, recovery delay, and confirmation depth.

The user-facing service does not need participant Sigbash API keys in server
environment variables. Each browser creates its own Sigbash credential triplet
and stores only passkey-derived ciphertext in PostgreSQL. The legacy unsuffixed
Sigbash variables remain for command-line audit tooling and must not be used as
shared production custody.

For any non-local database, the process refuses to start, migrate, or create
invites unless `sslmode=verify-full` is present. `sslmode=require` is rejected
because it encrypts traffic without authenticating the database certificate and
hostname. Local loopback is allowed only for isolated acceptance testing and is
rejected by the release report.

## Release sequence

1. Before deployment, provision a reviewed live Sigbash key and run the
   explicit one-nullifier proof. It first requires the live service to reject
   every hostile PSBT, then requires a real signature and independently checks
   the exact consensus transaction:

   ```bash
   SIGBASH_MODE=live npm run live-predeployment-proof -- \
     --round alice,bob,carol --leaver alice
   ```

   The command must end with `passed: true` and a non-null consensus
   authorization. The current external service result is unproven; no local or
   dry-run success substitutes for this command.
2. Build the immutable image in CI and record its digest. Do not inject runtime
   secrets during the build.
3. Restore the latest encrypted database backup into an isolated database and
   run `npm run web:migrate`; verify the application and rollback procedure.
4. Run the migration job once against the selected production database. The
   migrator takes a PostgreSQL advisory lock and refuses migration files that do
   not exactly match the reviewed manifest.
5. Only after step 1 has passed, start the web role behind HTTPS and private
   access control. Forward the original host without rewriting it; the
   application verifies WebAuthn assertions against the configured origin and
   RP ID, not proxy headers.
6. Confirm liveness and operational readiness. A green health endpoint is not
   a green funding report.
7. Complete the physical two-passkey, three-person roster, nine-key Sigbash,
   and all nine live mainnet readiness ceremonies on the exact HTTPS origin.
8. Exercise backup/restore and mainnet-backend rejection, retry, mempool,
   confirmation, and reorganization behavior without a funded vault.
9. Run `npm run web:release-status`. Only after its automated funding checks and
   manual review are complete may funding be considered. Funding still requires
   a new, explicit approval.

## Backup and monitoring minimums

- Use encrypted automated PostgreSQL backups with point-in-time recovery, and
  perform a real restore drill before the private beta.
- Alert on web readiness failures, watcher failures, repeated broadcast
  failures, database saturation, and sustained rate-limit activity. Do not log
  request bodies, invite tokens, passkey assertions, session cookies, Sigbash
  ciphertext, recovery kits, or database URLs.
- Keep the watcher private and single-scheduled for the initial beta. Database
  transaction claims make retries safe, but a duplicate scheduler provides no
  benefit at this scale.
- Keep the service private to the three invited participants. No health probe,
  invite, operator command, or deployment platform setting may make the funding
  recorder or watcher publicly callable.

## Operator commands

Run these only in a private job or shell attached to the same immutable image:

```bash
npm run web:migrate
npm run web:create-invite -- --vault-name '<reviewed name>' --participant alice
npm run web:release-status
npm run web:watch-chain
```

After a separately approved funding transaction reaches the configured
confirmation depth, the only initial activation command is:

```bash
npm run web:record-funding -- --vault-id <uuid> --txid <txid> --vout <index>
```

Do not run that command merely because the service is deployed or healthy. It
rechecks the exact mainnet P2TR output and the database's nine-proof ready state,
but the human funding approval remains mandatory.
