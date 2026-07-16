# Odinn Proof

Proof is an experimental, evidence-backed verification layer. A model response cannot mark a run verified; only passing assertions can do that.

Enable it explicitly:

```bash
odinn config experimental enable proof
```

Contracts use `schemaVersion: 1` and support shell-free command arrays, root-confined file assertions, bounded HTTP `GET`/`HEAD` assertions, and Git working-tree assertions. Command and response output is bounded and captured as content-addressed evidence. Assertions, evidence references, and status transitions are written to the SQLite ledger.

```bash
odinn proof contract validate ./contract.json
odinn proof run <run-id> --contract ./contract.json
odinn proof show <run-id>
```

The authenticated gateway exposes the same path through `POST /proof`, `GET /proof/<run-id>`, and `GET /runtime/runs/<run-id>/verify`.

HTTP proof is loopback-only by default to prevent untrusted contracts from becoming an SSRF primitive. External verification requires an explicit runtime integration decision; it is not enabled by the beta gateway.
