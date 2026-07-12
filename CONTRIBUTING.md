# Contributing to Odinn

Odinn is early-stage infrastructure. Changes should preserve cross-platform behavior, explicit security boundaries, durable state transitions, and a small understandable core.

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
pnpm build
```

The inference command is currently a deterministic provider-protocol fixture. Do not describe it as production-model validation.

## Design constraints

- Keep platform-specific behavior behind platform interfaces.
- Do not acknowledge durable work before persistence succeeds.
- Do not grant a capability merely because a tool is visible to a model.
- Do not put provider secrets, channel tokens, or generated credentials in source control.
- Generated or imported skills must remain reviewable and reversible.
- Avoid hidden fallback behavior that changes security or billing semantics.
- Add failure-path tests for state transitions and recovery logic.

## Releases

Do not edit release tags manually. Release Please maintains the version and changelog pull request. Merging that pull request creates the tag consumed by the protected release workflow.
