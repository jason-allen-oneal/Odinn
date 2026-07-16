# P0 beta gates

This is the release ledger for the first local, single-user Ódinn beta. A checked item has code and regression coverage. A partial item is intentionally not described as production-ready.

## Current state

- [x] Durable queued jobs with persisted state, cancellation, timeouts, retry limits, restart recovery, idempotent submission, and graceful supervisor shutdown.
- [x] Process-isolated workers for every gateway-submitted task. The supervisor and direct gateway control paths use a forked task worker; the local CLI remains an explicitly local operator path.
- [x] Extension manifests with type, version, digest, provenance, sandbox declaration, capability grants, enable/disable, and rollback. Installed extensions remain disabled and untrusted by default.
- [x] Extension/MCP execution adapters. Explicitly trusted, grant-scoped `process` manifests can run through the bounded Odinn JSONL adapter; MCP manifests use an explicit JSON-RPC `tools/call` JSONL adapter. Disabled, untrusted, ungranted, container, and unsandboxed manifests remain blocked.
- [x] Provider retries for transient failures, rate-limit backoff, generic chat SSE normalization, OAuth refresh path, and provider transport tests.
- [x] Provider catalog conformance contract across every preset, generic chat/Responses/SSE/tool-call fixtures, retry behavior, and canonical token accounting. Live provider-account and provider-specific service behavior remains an external release test, not a fake local green check.
- [x] Loopback-only gateway default, strict localhost/127.0.0.1/[::1] Host validation, per-state bearer token, browser bootstrap cookie, same-origin mutation checks, request limits, content-bound idempotency keys, graceful shutdown, and reconnectable audit SSE.
- [ ] Remote or multi-user hosting. Explicitly out of scope for beta.
- [x] Browser approval gate, domain/private-network policy, input redaction, and stale snapshot checks when an action is based on a snapshot.
- [x] Durable approval transactions survive restart and duplicate approval claims idempotently; the persistent browser worker reopens its profile after gateway restart and cleans up without orphan workers. Full failed-action/tab-loss recovery remains open.
- [x] Store schema versions, atomic job writes, explicit corruption recovery, owner-only state permissions, atomic replacement restore, and persisted task output for replay.
- [x] Audit-journal key rotation. Signed journal records retain retired verification keys; `odinn audit rotate-key` rotates the active key and `odinn audit verify` validates the signed chain. Legacy unsigned records are reported and can be rejected without silently rewriting history.
- [x] Packaged gateway/provider smoke, onboarding smoke, checksums, SBOM/provenance workflow hooks, and cross-platform package tests.
- [ ] Native installers and upgrade rollback testing on clean machines. Source archive extraction, dependency installation, onboarding, and CLI execution are now covered by `release:install-smoke`; native installers and upgrade rollback remain open.
- [x] Structured audit events, run timelines, persisted output, replay endpoint, provider failure tests, and failure categorization for task lifecycle.

## Experimental runtime slices

These are implemented as local vertical slices and remain disabled by default:

- [x] Proof contract validation, shell-free command/file assertions, evidence artifacts, persisted assertion results, and verified/failed run transitions.
- [x] Sentinel policy validation and pre-operation invariant decisions for denied commands, allowed roots, and approval-required tools.
- [x] Capability tokens with local signing keys, expiry, run/step/tool binding, resource constraints, revocation, and one-use enforcement.
- [x] Rewind snapshots with content-addressed file artifacts, dry-run previews, symlink rejection, and actual local restoration.
- [x] Capsules with redaction, ZIP path validation, checksums, verification-only replay metadata, and tamper detection.
- [x] Counterfactual workspace copies with independent runs, bounded task execution through the audited tool boundary, optional shared Proof runs, candidate comparison, and dry-run/apply branch selection with source backup. Irreversible external actions remain approval-gated and full remote rollback is not claimed.
- [x] Darwin observations and transparent routing scores with uncertainty penalties and human-readable selection reasons.

These slices do not claim to reverse arbitrary remote mutations, replay nondeterministic model calls, or provide multi-user isolation. Kernel tool execution now applies Sentinel and capability checks when the experimental flags are enabled; unintegrated third-party adapters remain outside that guarantee.

The self-improvement loop is deliberately review-gated. `improve.learn` mines repeated audited failures into deduplicated proposals and records the evidence. It never applies a code, policy, provider, or skill change by itself.

## Required release proof

The CI integration test launches `apps/gateway/src/server.mjs`, configures an OpenAI-compatible provider endpoint, calls the gateway, and verifies the response is present in the persisted run record. It exercises the packaged gateway/provider path with a local protocol provider; it does not call a cloud provider or pretend a direct fixture request is production-model validation.

The cross-platform CI matrix runs the CLI onboarding smoke on Linux, macOS, and Windows. The smoke uses a fresh state directory and completes without credentials; provider-specific auth remains an explicit onboarding path.

Package integrity CI now extracts both source archives, installs dependencies with the locked toolchain, completes onboarding in a clean state directory, and runs a real CLI tool through the extracted tree. This proves source-package installability; it is not a native installer or upgrade rollback proof.

Until the unchecked items above are closed, beta remains local and single-user. Do not bind it to a public interface or treat extension manifests as executable trust.
