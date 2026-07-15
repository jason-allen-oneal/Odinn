# P0 beta gates

This is the release ledger for the first local, single-user Ódinn beta. A checked item has code and regression coverage. A partial item is intentionally not described as production-ready.

## Current state

- [x] Durable queued jobs with persisted state, cancellation, timeouts, retry limits, restart recovery, idempotent submission, and graceful supervisor shutdown.
- [ ] Process-isolated workers for every untrusted job. The current supervisor isolates lifecycle state, but the built-in registry still executes inside the gateway process.
- [x] Extension manifests with type, version, digest, provenance, sandbox declaration, capability grants, enable/disable, and rollback. Installed extensions remain disabled and untrusted by default.
- [ ] Extension/MCP execution adapters. No imported extension is executable merely because its manifest exists.
- [x] Provider retries for transient failures, rate-limit backoff, generic chat SSE normalization, OAuth refresh path, and provider transport tests.
- [ ] Full provider conformance matrix across every catalog preset, including provider-specific tool-call quirks and token accounting.
- [x] Loopback-only gateway default, per-state bearer token, browser bootstrap cookie, same-origin mutation checks, request limits, idempotency keys, graceful shutdown, and reconnectable audit SSE.
- [ ] Remote or multi-user hosting. Explicitly out of scope for beta.
- [x] Browser approval gate, domain/private-network policy, input redaction, and stale snapshot checks when an action is based on a snapshot.
- [ ] Durable approval transactions across gateway restarts and full page-action recovery matrix.
- [x] Store schema versions, atomic job writes, explicit corruption recovery, state backup, guarded restore, and persisted task output for replay.
- [ ] Automated scheduled backup/restore drills and audit-journal key rotation.
- [x] Packaged gateway/provider smoke, onboarding smoke, checksums, SBOM/provenance workflow hooks, and cross-platform package tests.
- [ ] Native installers and upgrade rollback testing on clean machines.
- [x] Structured audit events, run timelines, persisted output, replay endpoint, provider failure tests, and failure categorization for task lifecycle.

## Required release proof

The CI integration test launches `apps/gateway/src/server.mjs`, configures an OpenAI-compatible provider endpoint, calls the gateway, and verifies the response is present in the persisted run record. It does not call a cloud provider or pretend a direct fixture request is an end-to-end test.

The cross-platform CI matrix runs the CLI onboarding smoke on Linux, macOS, and Windows. The smoke uses a fresh state directory and completes without credentials; provider-specific auth remains an explicit onboarding path.

Until the unchecked items above are closed, beta remains local and single-user. Do not bind it to a public interface or treat extension manifests as executable trust.
