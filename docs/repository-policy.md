# Repository Policy Setup

Workflow files cannot create branch protection or repository environments by themselves. Odinn Forge includes an idempotent administration script for that one-time configuration.

Requirements:

- GitHub CLI (`gh`)
- Authentication as a repository administrator
- Node.js 24 or newer

Run:

```bash
node scripts/repository/configure-github.ts jason-allen-oneal/Odinn 8335428
```

The script configures:

- Read-only default `GITHUB_TOKEN` permissions
- Vulnerability alerts
- Private vulnerability reporting where supported
- Dependabot security updates where supported
- Protected `main`
- Required CI, platform, integration, package-integrity, workflow-lint, security, and pull-request-policy checks
- Current-branch enforcement
- Linear history
- Force-push and branch-deletion prevention
- Conversation resolution
- A protected `release` environment

The default policy requests one approval. On a single-maintainer repository, administrators can bypass that review requirement because administrator enforcement is disabled. Once a second maintainer is active, remove routine bypasses and treat the review as mandatory.

Review the configured rules in GitHub after running the script. Repository plans and organization policies can affect which protection and environment features are available.

The event-specific `Merge queue validation` job is not a normal pull-request status context. GitHub runs it for `merge_group` events when merge queue is enabled; do not add it as a pull-request-required context unless the workflow is also changed to run for pull requests.
