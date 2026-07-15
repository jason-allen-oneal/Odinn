# Odinn Experimental Runtime Threat Model

## Trust boundaries

- The operator and local filesystem are trusted inputs only where explicitly configured.
- Models, imported contracts, policies, extension metadata, capsule contents, and tool output are untrusted.
- External services and browser sessions are untrusted, stateful side effects.

## Controls

- Loopback gateway and single-user scope remain the beta boundary.
- Unknown tools default to irreversible, approval-required safety descriptors.
- Paths are canonicalized and symlink escapes are rejected for Proof and snapshots.
- Commands use argument arrays with shell execution disabled.
- Ledger payloads and artifact evidence are redacted and bounded.
- Sentinel decisions are deterministic and persisted before execution.
- Capability tokens are signed, short-lived, run/step/tool bound, scoped, revocable, and replay-limited.
- Capsule extraction rejects traversal and absolute paths.

## Residual risk

No local runtime can reverse sent email, purchases, or arbitrary remote mutations. Browser sessions and imported credentials remain high-value secrets. Public or multi-user hosting is out of scope. Full deterministic replay of remote services and nondeterministic models is not claimed.
