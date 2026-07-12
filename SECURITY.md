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

Odinn is designed around explicit capability boundaries, durable approvals, isolated workers, authenticated control surfaces, and local-first storage. These controls are still under active development.

Before the first stable release:

- Do not expose the Gateway directly to the public internet.
- Do not run untrusted tools, skills, MCP servers, or channel adapters.
- Use dedicated credentials with minimal permissions.
- Keep provider keys and channel tokens out of source control.
- Treat generated skills and imported configuration as untrusted until reviewed.

## CI security gates

The repository requires CodeQL analysis, dependency review, dependency auditing, secret scanning, and OpenSSF Scorecard reporting. Release jobs additionally generate an SPDX SBOM, SHA-256 checksums, and GitHub build provenance.
