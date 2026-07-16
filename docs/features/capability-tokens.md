# Odinn Forge Capability Tokens

Capability tokens bind one short-lived operation to a run, step, tool, resource constraints, and a use count. The signing key is local-only with restrictive permissions. Raw credentials are never placed in token claims, ledger payloads, or normal CLI output.

```bash
odinn config experimental enable capabilities
odinn capability issue --run <run-id> --step <step-id> --tool github.create --scope pull_request:create
odinn capability list <run-id>
odinn capability revoke <capability-id>
```

The broker validates signature, expiration, run/tool binding, resource constraints, revocation, and replay count before recording a use.

Enabling this experimental feature changes direct CLI execution immediately:
ordinary tool runs require a matching scoped token after capability enforcement is
active. Issue the token first, or disable the feature before returning to normal
manual runs. Counterfactual read-only execution issues its own one-use token.
