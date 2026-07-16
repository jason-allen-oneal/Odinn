# Odinn Forge Experimental Runtime Threat Model

## Trust boundaries

- The operator and local filesystem are trusted inputs only where explicitly configured.
- Models, imported contracts, policies, extension metadata, capsule contents, and tool output are untrusted.
- External services and browser sessions are untrusted, stateful side effects.

## Controls

- The default gateway is loopback-only. Remote deployments use a separate TLS-only host with exact-origin enforcement, throttled authentication, signed revocable sessions, and per-tenant gateway/state/workspace/browser boundaries.
- Unknown tools default to irreversible, approval-required safety descriptors.
- Paths are canonicalized and symlink escapes are rejected for Proof and snapshots.
- Proof commands are denied by default and require an exact operator-owned argument-vector allowlist; approved commands use no shell, a minimal environment, bounded output, and process-tree termination.
- Ledger payloads and artifact evidence are redacted and bounded.
- Sentinel decisions are deterministic and persisted before execution.
- Capability tokens are signed, short-lived, run/step/tool bound, scoped, revocable, and replay-limited.
- Capsule extraction rejects traversal and absolute paths.
- The gateway rejects hostile `Host` headers before issuing its bootstrap cookie.
- Public web fetch validates all DNS answers and uses a validated address for the connection; redirects are revalidated and oversized responses are terminated immediately under an absolute deadline.
- Browser traffic is forced through a loopback egress proxy that validates every DNS answer and connects to a pinned public address. Playwright request and WebSocket routing enforce domain policy, and service workers are disabled.
- Workspace reads resolve symlinks before opening files.
- Job shutdown sets a stopping barrier before aborting work, preventing retry/requeue races.
- State directories and records are repaired to owner-only permissions; restores reject symlinks, hardlinks, and special files before copying; idempotency keys are content-bound.
- Browser mutations are journaled before execution. Unknown outcomes block further mutation until explicitly resolved.
- Extensions and MCP adapters execute through the audited Sentinel/capability boundary; direct extension execution is rejected. Executable extensions require a content digest and explicit `unconfined-process` acknowledgement, receive a minimal environment, and have bounded output.
- Full capsule replay requires a disposable workspace, complete non-redacted inputs, an audited executor, and explicit approval for external effects.

## Residual risk

No local runtime can reverse sent email, purchases, or arbitrary remote mutations. Browser sessions and imported credentials remain high-value secrets. `unconfined-process` extensions still run as the Odinn operating-system user: capability grants authorize invocation, not filesystem or network confinement. Use a dedicated OS user or container for code that is not fully trusted. Full deterministic replay of remote services and nondeterministic models is not claimed. The multi-user host provides application-level tenant isolation, not kernel-level containment; mutually untrusted tenants require separate operating-system users or containers. Host sessions are intentionally ephemeral and users must sign in again after a host restart. Autonomous improvement is restricted to an explicit allowlist of rollback-safe reliability settings and cannot widen authority, weaken Sentinel, change credentials, or install code.
