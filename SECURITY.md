# Security Policy

## Supported versions

Until Odinn reaches a stable 1.0 release, security fixes are applied only to the latest commit on `main` and the newest published prerelease.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting or security advisory feature for this repository. Include:

- A concise description of the issue
- Affected commit, tag, or package version
- Reproduction steps or a minimal proof of concept
- Expected and observed behavior
- Potential impact
- Any suggested mitigation

Reports will be acknowledged as soon as practical. Disclosure timing will be coordinated after impact and remediation are understood.

## Security boundaries

Ódinn's initial beta has explicit capability boundaries, append-only audit events, expiring approval records, an isolated browser profile, and local-first storage. It does not yet provide multi-user authentication or a remotely hardened control plane.

Before the first stable release:

- Do not expose the Gateway directly to the public internet.
- Do not run untrusted tools, skills, MCP servers, or channel adapters.
- Use dedicated credentials with minimal permissions.
- Keep provider keys and channel tokens out of source control.
- Treat generated skills and imported configuration as untrusted until reviewed.

### Secure defaults

The default policy enables public web reading while blocking private-network URLs, leaves domain allowlists empty, uses a separate Chromium profile for browser work, and requires explicit approval before `browser.click`, `browser.type`, or `browser.press` can execute. Gateway approval records expire after five minutes and are stored in the state directory with mode `0600`; the corresponding request and decision are written to the audit log. The gateway requires a per-state bearer token or same-site bootstrap cookie for control-plane access and rejects cross-origin mutations.

The policy is configurable because local operators have different trust boundaries. The dangerous switches are intentionally explicit:

```bash
pnpm odinn config security show
pnpm odinn config security set --surface web --allow-private-network true
pnpm odinn config security set --surface browser --require-approval false
```

Private-network access can expose local services and metadata endpoints. Disabling browser approval allows the model to drive external accounts without a human checkpoint. Those settings are operator decisions, not safe defaults.

The web tools follow redirects through the same URL policy and enforce blocked/allowed domains at each hop. Browser navigation and post-action snapshots are checked against the same network and domain rules. The beta does not expose file upload or download tools.

### Trust model

- The local operator controls the config, provider credentials, browser login, and approval decisions.
- Model output and imported skills are untrusted input; they cannot bypass the kernel policy evaluator.
- Extension and MCP manifests are metadata, not trust. They are disabled by default, require provenance review, and receive only explicit capability grants when enabled.
- Public web content is untrusted data and may contain prompt injection. Ódinn must not treat page instructions as operator authorization.
- Browser read access is not action authorization. An external side effect requires the approval gate unless the operator explicitly disables it.
- Loopback binding is the supported deployment. `ODINN_ALLOW_REMOTE=1` is an escape hatch for controlled experiments, not a security boundary.

## CI security gates

The repository requires CodeQL analysis, dependency review, dependency auditing, secret scanning, and OpenSSF Scorecard reporting. Release jobs additionally generate an SPDX SBOM, SHA-256 checksums, and GitHub build provenance.
