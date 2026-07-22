# Contributing to Odinn Forge

Odinn Forge is early-stage infrastructure. Changes should preserve cross-platform behavior, explicit security boundaries, durable state transitions, and a small understandable core.

## Development setup

Requirements:

- Node.js 24 or newer
- Corepack
- Git

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm check
```

The repository defaults to one concurrent workspace/build worker, one dependency
lifecycle worker, and a 1536 MB Node.js old-space limit. This keeps local checks
from exhausting a development machine. Maintainers can deliberately tune the
workspace and heap limits with `ODINN_WORKSPACE_CONCURRENCY` and
`ODINN_NODE_MAX_OLD_SPACE_MB`; CI should only raise them when the runner capacity
is known.

## Pull requests

Use a focused branch and a Conventional Commit pull request title, for example:

```text
feat(gateway): add replayable event cursor
fix(store): recover expired queue leases
ci(release): attest packaged artifacts
```

A pull request should explain the behavior being changed, security implications, cross-platform impact, and the exact verification performed.

## Required local checks

```bash
pnpm release:preflight
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm smoke:inference
pnpm benchmark:ci
node scripts/ci/audit.ts high
pnpm build
pnpm release:package
pnpm release:checksums
node scripts/release/verify.ts
pnpm release:install-smoke
pnpm storage:drill
```

The inference command launches the packaged gateway against a local OpenAI-compatible protocol provider and verifies persistence through the public API. Do not describe it as production-model or live cloud-provider validation.

When changing `.github/workflows/`, also run the pinned actionlint container described by `.github/workflows/workflow-lint.yml`. The dependency audit must return a real advisory result; scanner unavailability is a failure, not a waiver.

## Design constraints

- Keep platform-specific behavior behind platform interfaces.
- Do not acknowledge durable work before persistence succeeds.
- Do not grant a capability merely because a tool is visible to a model.
- Do not put provider secrets, channel tokens, or generated credentials in source control.
- Generated or imported skills must remain reviewable and reversible.
- Avoid hidden fallback behavior that changes security or billing semantics.
- Add failure-path tests for state transitions and recovery logic.

## Releases

Prepare every release as a normal reviewed pull request that updates
`package.json` and `CHANGELOG.md` together. The changelog heading and comparison
link must match the package version. Do not create the tag until that pull
request is merged and all required checks on `main` are green.

From an up-to-date, clean `main`, create an annotated tag that exactly matches
the package version and push only that tag:

```bash
git switch main
git pull --ff-only origin main
pnpm release:preflight
version="$(node -p "require('./package.json').version")"
tag="v$version"
git tag -a "$tag" -m "Odinn Forge $tag"
git push origin "$tag"
```

Use a signed tag when signing is configured. The tag starts the protected
release workflow, which independently verifies the version/tag/commit binding,
runs the release gates, and publishes through the `release` environment. Never
move or reuse a published tag; prepare a new patch or prerelease version instead.
