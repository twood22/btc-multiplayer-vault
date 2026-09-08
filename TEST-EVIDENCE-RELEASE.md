# Test-only evidence archives — not a production release

These are permanently public **synthetic-test artifacts**, not deployment images,
funding authorization, or a completed mainnet release dossier. Never use these
images with real funds, participant custody material, or operational credentials.
The `mainnet` label denotes address/build-format testing only; it does not mean
mainnet transactions were made or that production use is safe.

The candidate is `d5ff8e8677fc2ed39a9f35d2f260cf060650bd7c`, with source fingerprint
`536935c274261a11f18d9a798cc385770c878681842cfe0fc8e89aec724c2069`.
Retention tooling lives on a separate branch and is not part of that image's
source fingerprint. Each retention record identifies both commits and the run.

The image archives retain the exact OCI manifest/config/layer bytes, browser and
runtime evidence, and all seven required execution transcripts. The candidate's
existing verifier checks the image actually executed, archive membership,
checksums, and restored bytes. The separate publication review examines actual
archive contents, including historical layers, without extracting an image onto
the host. It is a bounded content review, not a universal secret-detection claim.

Builds use fresh hosted rootless runners, locked dependencies, no operational
build keys, and no publication token in the build/test/review environment. Public
third-party source/test fixtures and disposable runner metadata may be present.
Any unused framework-generated test-build key is permanently public; these
artifacts must never be promoted into production.

Assets are uploaded only to an existing test-only draft, without overwriting.
Publication requires a separate download and verification of the actual assets.
No application is deployed, listener exposed, registry image pushed, or paid
Actions artifact storage used.

Still outstanding: real default-Signet lifecycle completion and final retained
release assembly. Physical-device passkey checks remain deferred to onboarding.
