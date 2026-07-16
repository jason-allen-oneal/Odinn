# Odinn Forge Experimental Runtime Threat Model

## Trust boundaries

- The operator and local filesystem are trusted inputs only where explicitly configured.
- Models, imported contracts, policies, extension metadata, capsule contents, and tool output are untrusted.
- External services and browser sessions are untrusted, stateful side effects.

## Controls

- The default gateway is loopback-only. Remote deployments use a separate TLS-only host with exact-origin enforcement, throttled authentication, signed revocable sessions, and per-tenant gateway/state/workspace/browser boundaries.
- Unknown tools default to irreversible, approval-required safety descriptors.
- Paths are canonicalized and symlink escapes are rejected for Proof and snapshots.
- Commands use argument arrays with shell execution disabled.
- Ledger payloads and artifact evidence are redacted and bounded.
- Sentinel decisions are deterministic and persisted before execution.
- Capability tokens are signed, short-lived, run/step/tool bound, scoped, revocable, and replay-limited.
- Capsule extraction rejects traversal and absolute paths.
- The gateway rejects hostile `Host` headers before issuing its bootstrap cookie.
- Public web fetch validates all DNS answers and uses a validated address for the connection; redirects are revalidated.
- Workspace reads resolve symlinks before opening files.
- Job shutdown sets a stopping barrier before aborting work, preventing retry/requeue races.
- State directories and records are repaired to owner-only permissions; idempotency keys are content-bound.
- Browser mutations are journaled before execution. Unknown outcomes block further mutation until explicitly resolved.
- Extensions and MCP adapters execute through the audited Sentinel/capability boundary; direct extension execution is rejected.
- Full capsule replay requires a disposable workspace, complete non-redacted inputs, an audited executor, and explicit approval for external effects.

## Residual risk

No local runtime can reverse sent email, purchases, or arbitrary remote mutations. Browser sessions and imported credentials remain high-value secrets. Full deterministic replay of remote services and nondeterministic models is not claimed. The multi-user host provides application-level tenant isolation, not kernel-level containment; mutually untrusted tenants require separate operating-system users or containers. Host sessions are intentionally ephemeral and users must sign in again after a host restart. Autonomous improvement is restricted to an explicit allowlist of rollback-safe reliability settings and cannot widen authority, weaken Sentinel, change credentials, or install code.
