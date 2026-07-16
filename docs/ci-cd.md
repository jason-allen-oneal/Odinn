# Odinn Forge CI/CD

Odinn Forge uses separate workflows for correctness, package integrity, workflow linting, pull-request policy, merge-queue validation, security, scheduled verification, version management, and release publication. A green release requires every applicable required workflow to succeed independently.

## Workflows

### CI

Runs on every pull request, every push to `main`, and manual dispatch.

Required jobs:

- `Quality and unit tests`
- `Platform test (ubuntu-latest)`
- `Platform test (macos-latest)`
- `Platform test (windows-latest)`
- `Integration and inference protocol`
- Three platform-specific package smoke jobs

The inference job launches the packaged Gateway, configures a local OpenAI-compatible protocol provider, and verifies a persisted model response through the public API. It is real packaged gateway behavior proof, but it is not proof of production-model quality or a live cloud-provider account.

### Security

Runs on pull requests, pushes to `main`, a weekly schedule, and manual dispatch.

It includes:

- CodeQL for JavaScript and TypeScript
- GitHub dependency review on pull requests
- Frozen-lockfile installation and a fail-closed advisory audit. The audit uses `pnpm audit` when available and queries npm's bulk advisory endpoint directly when the legacy endpoint returns its retirement response.
- Full-history Gitleaks secret scanning
- OpenSSF Scorecard reporting on trusted events

### Nightly

Runs the complete repository check, integration test, protocol smoke, performance threshold, dependency audit, and source packaging every day. Nightly artifacts are retained for seven days.

### Package Integrity

Runs on every pull request and push to `main`. Linux, macOS, and Windows each build the source archives, verify checksums and archive contents, install from the frozen lockfile, complete onboarding, and execute the packaged CLI smoke.

### Workflow and pull-request policy

Workflow Lint runs actionlint on every pull request and on workflow changes pushed to `main`. Pull Request Policy validates Conventional Commit syntax for pull-request titles. Merge Queue performs the full release-candidate suite for `merge_group` events.

### Release Please

Pushes to `main` are analyzed for Conventional Commit messages. During public beta, Release Please maintains a prerelease pull request that updates `package.json`, `CHANGELOG.md`, and the release manifest. Merging that pull request creates a beta version tag and GitHub prerelease.

GitHub deliberately does not emit a second workflow event for a tag created with the workflow `GITHUB_TOKEN`. The Release Please workflow therefore calls `release.yml` directly when `release_created` is true and passes the exact generated tag into the protected reusable release workflow. The tag-push and manual-dispatch triggers remain available for operator-created recovery runs.

### Release

A `v*` tag starts the release workflow. The workflow:

1. Checks out the exact tag.
2. Verifies that the tag matches `package.json`.
3. Runs all quality, integration, inference protocol, benchmark, and dependency-audit gates.
4. Produces ZIP and tar.gz source archives from the tagged Git tree.
5. Generates an SPDX JSON SBOM.
6. Generates SHA-256 checksums.
7. Creates GitHub build provenance attestations.
8. Publishes assets to the GitHub release through the protected `release` environment.

The workflow cannot publish from an untagged branch or a tag that disagrees with the package version.

## Required repository settings

Configure the following manually in GitHub because they are repository policy, not workflow code:

- Protect `main`.
- Require pull requests before merging.
- Require at least one approval when more than one maintainer is active.
- Dismiss stale approvals after new commits.
- Require conversation resolution.
- Require signed commits if all active maintainers can use them reliably.
- Require the CI and Security status checks listed above.
- Require branches to be current before merge.
- Block force pushes and deletion of `main`.
- Enable private vulnerability reporting.
- Create a `release` environment and require approval for stable releases.
- Limit workflow permissions to read-only by default.

## Local equivalence

Before opening a pull request:

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm release:preflight
pnpm check
pnpm test:integration
pnpm smoke:inference
pnpm benchmark:ci
node scripts/ci/audit.ts high
```

To inspect release output without publishing:

```bash
pnpm release:package
pnpm release:checksums
node scripts/release/verify.ts
pnpm release:install-smoke
```

Artifacts are written to `dist/release/`.

The audit command fails if neither advisory service can produce a valid result. A successful gate must never mean "the scanner was unavailable."

## Release conventions

Pull request titles and squash commit messages use Conventional Commits:

- `feat(scope): description`
- `fix(scope): description`
- `docs(scope): description`
- `ci(scope): description`
- `chore(scope): description`

Breaking changes use `!` before the colon or a `BREAKING CHANGE:` footer.

## Future package targets

When native binaries and containers are added, extend the release workflow with platform-specific build jobs. Each job must upload its own checksummed artifact, and the publish job must not run until Windows, macOS, and Linux package smoke tests pass.
