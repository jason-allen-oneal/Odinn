# Repository Policy Setup

Workflow files cannot create branch protection or repository environments by themselves. Odinn includes an idempotent administration script for that one-time configuration.

Requirements:

- GitHub CLI (`gh`)
- Authentication as a repository administrator
- Node.js 24 or newer

Run:

```bash
node scripts/repository/configure-github.mjs jason-allen-oneal/Odinn 8335428
```

The script configures:

- Read-only default `GITHUB_TOKEN` permissions
- Vulnerability alerts
- Dependabot security updates where supported
- Protected `main`
- Required CI, platform, integration, package, security, and pull-request-policy checks
- Current-branch enforcement
- Linear history
- Force-push and branch-deletion prevention
- Conversation resolution
- A protected `release` environment

The default policy requests one approval. On a single-maintainer repository, administrators can bypass that review requirement because administrator enforcement is disabled. Once a second maintainer is active, remove routine bypasses and treat the review as mandatory.

Review the configured rules in GitHub after running the script. Repository plans and organization policies can affect which protection and environment features are available.
