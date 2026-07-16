# Odinn Forge Proof

Proof is an experimental, evidence-backed verification layer. A model response cannot mark a run verified; only passing assertions can do that.

Enable it explicitly:

```bash
odinn config experimental enable proof
```

Contracts use `schemaVersion: 1` and support exact-allowlisted command arrays, root-confined file assertions, bounded HTTP `GET`/`HEAD` assertions, and fixed Git working-tree assertions. Command assertions are denied by default. An operator may place exact argument vectors in `proof.allowedCommands` in the state `config.json`; allowing an executable name alone is deliberately unsupported. Approved commands receive a minimal environment without provider credentials or the parent process environment. Command and response output is bounded and captured as content-addressed evidence, and timed-out or flooding commands have their process tree terminated.

```json
{
  "proof": {
    "allowedCommands": [["/absolute/path/to/pnpm", "test"]]
  }
}
```

```bash
odinn proof contract validate ./contract.json
odinn proof run <run-id> --contract ./contract.json
odinn proof show <run-id>
```

The authenticated gateway exposes the same path through `POST /proof`, `GET /proof/<run-id>`, and `GET /runtime/runs/<run-id>/verify`; it uses the same operator-owned exact allowlist.

HTTP proof is loopback-only by default to prevent untrusted contracts from becoming an SSRF primitive. External verification requires an explicit runtime integration decision; it is not enabled by the beta gateway.
