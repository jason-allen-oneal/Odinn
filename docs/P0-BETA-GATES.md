# P0 beta gates

This is the release ledger for the Ódinn Forge beta. A checked item has code and regression coverage. The default remains local and single-user; remote multi-user operation is an explicit TLS-only host mode. Use the [Beta 3 surface matrix](BETA-3-SURFACE-MATRIX.md) for the authoritative operator classifications: **verified local behavior**, **experimental and disabled by default**, **provider- or platform-dependent**, and **explicitly unsupported**.

The three hard limits are:

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Current state

- [x] Durable queued jobs with persisted state, cancellation, timeouts, restart recovery, content-bound idempotent submission, and graceful supervisor shutdown. Retries require an explicit safe/idempotent tool descriptor; interrupted unsafe work stops in `needs-review` instead of replaying an unknown external outcome.
- [x] Forked crash-containment workers for every gateway-submitted task. These workers retain the parent OS identity, environment, filesystem, and network authority and are not described as a security sandbox; the local CLI remains an explicitly local operator path.
- [x] Extension manifests with type, version, digest, provenance, sandbox declaration, capability grants, enable/disable, and rollback. Installed extensions remain disabled and untrusted by default.
- [x] Extension/MCP execution adapters. Container extensions require a whole-bundle digest and execute with read-only mounts, no network, dropped capabilities, no-new-privileges, CPU/memory/PID/tmpfs limits, and bounded output. Trusted `unconfined-process` extensions still require an entrypoint digest and explicit unsafe acknowledgement. Both cross the audited Sentinel/capability boundary. MCP manifests use an explicit JSON-RPC `tools/call` JSONL adapter.
- [x] Provider retries for transient failures, rate-limit backoff, generic chat SSE normalization, OAuth refresh path, and provider transport tests.
- [x] Provider catalog conformance contract across every preset, generic chat/Responses/SSE/tool-call fixtures, retry behavior, and canonical token accounting. Live provider-account and provider-specific service behavior remains an external release test, not a fake local green check.
- [x] Loopback-only gateway default, strict localhost/127.0.0.1/[::1] Host validation, per-state bearer token, browser bootstrap cookie, exact scheme/host/port checks for cookie-authenticated mutations, missing-Origin rejection for cookie mutations, request limits, content-bound idempotency keys, graceful shutdown, and reconnectable audit SSE.
- [x] Opt-in remote multi-user host with mandatory TLS/public-origin configuration for non-loopback binds, scrypt password verification, login throttling, signed revocable sessions, logout, and separate state/workspace/gateway/browser boundaries per tenant.
- [x] Browser approval gate, DNS-pinned local egress proxy, request/WebSocket interception, blocked service workers, domain/private-network policy, input redaction, and stale snapshot checks when an action is based on a snapshot.
- [x] Durable approval transactions survive restart and duplicate approval claims idempotently; persistent tab handles recover after restart. Browser mutations use a pre-action recovery journal and block subsequent mutations until interrupted/unknown outcomes are explicitly resolved.
- [x] Store schema versions, atomic job writes, explicit corruption recovery, owner-only state permissions, atomic replacement restore with symlink/hardlink/special-file rejection, and persisted task output for replay.
- [x] Audit-journal key rotation and cross-process append serialization. Signed journal records retain retired verification keys; `odinn audit rotate-key` rotates the active key and `odinn audit verify` validates the single signed chain. Legacy unsigned records are reported and can be rejected without silently rewriting history.
- [x] Packaged gateway/provider smoke, onboarding smoke, checksums, SBOM/provenance workflow hooks, and cross-platform package tests.
- [x] Versioned POSIX/PowerShell installers with atomic current/previous pointers and tested application rollback, alongside source archive extraction, frozen dependency installation, onboarding, and CLI release smoke.
- [x] Structured audit events, run timelines, persisted output, replay endpoint, provider failure tests, and failure categorization for task lifecycle.

## Experimental runtime slices

These are implemented as local vertical slices and remain disabled by default:

- [x] One gateway Proof verification path with strict schema validation, exact operator-controlled command allowlists, minimal command environments, process-tree termination, file assertions, evidence artifacts, persisted assertion results, and verified/failed run transitions. Legacy arbitrary-command assertions are rejected.
- [x] Sentinel policy validation and pre-operation invariant decisions for denied commands, allowed roots, and approval-required tools.
- [x] Capability tokens with local signing keys, expiry, run/step/tool binding, resource constraints, revocation, and one-use enforcement.
- [x] Rewind snapshots with content-addressed file artifacts, dry-run previews, symlink rejection, and actual local restoration.
- [x] Capsules with redaction, ZIP path validation, checksums, verification-only contract metadata, tool-mocked durable boundary replay, tamper detection, and full replay through the audited executor in disposable workspaces. External effects require explicit approval and redacted inputs remain fail-closed.
- [x] Counterfactual workspace copies with independent runs, bounded task execution through the audited tool boundary, optional shared Proof runs, candidate comparison, and dry-run/apply branch selection with source backup. Irreversible external actions remain approval-gated and full remote rollback is not claimed.
- [x] Darwin observations and transparent routing scores with uncertainty penalties and human-readable selection reasons.

These slices do not claim to reverse arbitrary remote mutations or make nondeterministic model and remote-service results deterministic. Built-in tools and extension/MCP adapters route through the shared audited execution boundary; direct extension execution is rejected. Forked workers are crash containment, not a security sandbox. Remote hosting is application-level tenant isolation, not hostile-user OS isolation. External effects and nondeterministic provider behavior are outside full replay/rollback guarantees. See the [Beta 3 surface matrix](BETA-3-SURFACE-MATRIX.md) for the complete surface classification.

The self-improvement loop runs automatically by default. It applies only allowlisted reliability tuning, captures a rollback snapshot, and cannot widen permissions, disable safeguards, change credentials, install extensions, or weaken Sentinel.

## Required release proof

The CI integration test launches `apps/gateway/src/server.ts`, configures an OpenAI-compatible provider endpoint, calls the gateway, and verifies the response is present in the persisted run record. It exercises the packaged gateway/provider path with a local protocol provider; it does not call a cloud provider or pretend a direct fixture request is production-model validation.

The cross-platform CI matrix runs the CLI onboarding smoke on Linux, macOS, and Windows. The smoke uses a fresh state directory and completes without credentials; provider-specific auth remains an explicit onboarding path.

Package integrity CI extracts both source archives, installs dependencies with the locked toolchain, completes onboarding in a clean state directory, and runs a real CLI tool through the extracted tree. Native installer integration tests separately prove immutable version installation, atomic current/previous pointer changes, and application rollback.

The single-user gateway remains loopback-only. Remote operation must use the TLS-only multi-user host. Extension manifests remain untrusted until explicitly enabled and grant-scoped.
