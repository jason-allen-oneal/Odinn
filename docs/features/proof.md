# Odinn Proof

Proof is an experimental, evidence-backed verification layer. A model response cannot mark a run verified; only passing assertions can do that.

Enable it explicitly:

```bash
odinn config experimental enable proof
```

Contracts use `schemaVersion: 1` and currently support shell-free command arrays and root-confined file assertions. Command output is bounded and captured as content-addressed evidence. Assertions, evidence references, and status transitions are written to the SQLite ledger.

```bash
odinn proof contract validate ./contract.json
odinn proof run <run-id> --contract ./contract.json
odinn proof show <run-id>
```

HTTP and Git assertions are available in the broader runtime contract adapter; the strict `ProofVerifier` API intentionally accepts only command and file assertions until those schemas are promoted.
