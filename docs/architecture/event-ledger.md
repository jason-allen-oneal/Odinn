# Ódinn runtime event ledger

The event ledger is the durable runtime spine used by the experimental Proof, Rewind, Sentinel, Capsule, Darwin, Capability, and Counterfactual features. Each remote-host tenant receives an independent state root and ledger.

## Storage

Each state directory contains:

```text
.odinn/
  db/odinn.sqlite
  artifacts/sha256/<prefix>/<digest>
```

The SQLite database enables foreign keys and WAL mode. Migrations are versioned in `schema_migrations`. The initial schema stores:

- `runs` — durable objective, status, model/provider, workspace, and feature flags;
- `run_steps` — ordered tool boundaries with input/output artifact digests;
- `ledger_events` — append-only per-run events with a previous-hash link;
- `artifacts` — content-addressed metadata for files stored outside SQLite.

Large or sensitive values are redacted before persistence. API keys, bearer tokens, cookies, passwords, and private keys are replaced with `[redacted]`; JSON tool inputs and outputs are stored as content-addressed artifacts rather than embedded in ledger rows.

## Event integrity

Every event has a run-local sequence, timestamp, payload, previous hash, and SHA-256 hash. The hash covers the canonical event envelope. `odinn run verify <run-id>` recomputes the chain and reports whether it is intact.

The ledger is an integrity journal, not a blockchain. It does not provide remote replication or tamper-proof storage against an attacker who controls the state directory.

## Tool interception

`runTask` remains the runtime interception boundary. When given a `RunLedger`, it creates a run and `tool-request` step before policy evaluation, records a `policy-check`, and records a `tool-result` after execution. Unknown tools receive the most restrictive descriptor: all effects, irreversible, capability-required, and approval-required.

Built-in descriptors currently classify reads, local record writes, model/provider calls, and browser mutations. This is the shared interception boundary for Sentinel and Capability enforcement when those flags are enabled. Extension and MCP adapters must enter through this boundary; direct extension execution is rejected.

## Feature flags

The seven candidate features are stored as explicit booleans on every run:

```json
{
  "proof": false,
  "rewind": false,
  "sentinel": false,
  "capsules": false,
  "darwin": false,
  "capabilities": false,
  "counterfactual": false
}
```

They are disabled by default and are not silently inferred from model output or tool metadata.

## Current limitations

The ledger now backs Proof, Rewind, Sentinel, Capability, Capsule, Darwin, and Counterfactual slices. It does not make remote side effects reversible, make model output deterministic, or provide tamper resistance against an attacker who controls a tenant's state directory. Counterfactual plans execute bounded tasks in isolated candidate roots and selection supports dry-run or explicit apply. Full capsule replay executes only in a disposable workspace through an audited executor; external effects require explicit approval and redacted inputs cannot be replayed.
