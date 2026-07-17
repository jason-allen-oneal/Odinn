# Ódinn Forge Beta 3 Stabilization Plan

Target release line: `0.3.0-beta.N`

Beta 3 is a stabilization release. It should increase confidence in the
existing runtime without adding another major experimental subsystem. The
base version remains `0.3.0`; only the beta suffix advances.

## Objective

Make the current beta easier to trust, operate, diagnose, recover, and roll
back across Linux, macOS, and Windows.

The release is successful when a new operator can install a verified package,
configure a provider, run the normal local workflow, survive common failures,
inspect what happened, and roll back without guessing.

## Non-goals

- No new major experimental runtime slice.
- No claim of hostile-code containment.
- No claim that remote browser or provider mutations are deterministically
  reversible.
- No broadening of default capabilities, network access, or approval policy.
- No change to the `0.3.0` base version.
- No automatic activation of extensions, skills, agents, or experimental flags.

## Workstreams

### 1. Beta surface and safety claims

Create one operator-facing matrix that classifies every surface as:

- verified local behavior;
- experimental and disabled by default;
- provider- or platform-dependent;
- explicitly unsupported.

Use the same terminology in `README.md`, `docs/public-beta.md`,
`docs/P0-BETA-GATES.md`, CLI help, and the console. Keep the following claims
prominent:

- forked workers are crash containment, not a security sandbox;
- remote hosting provides application-level tenant isolation, not hostile-user
  OS isolation;
- external effects and nondeterministic provider behavior are outside full
  replay and rollback guarantees.

### 2. Release candidate soak

Add a repeatable release-candidate workflow that runs the packaged artifact,
not only the source checkout.

Required sequence:

1. Install from the generated archive with the frozen lockfile.
2. Complete fresh onboarding with a local protocol provider.
3. Run a deterministic tool and a multi-step plan.
4. Restart the gateway during normal operation.
5. Exercise provider failure, retry, timeout, and recovery paths.
6. Queue work, stop the process, restart it, and verify recovery state.
7. Interrupt a browser mutation and verify recovery blocking.
8. Verify the audit chain and inspect persisted run output.
9. Restore a modified workspace through Rewind in dry-run mode.
10. Roll back the installed version and repeat the smoke path.

The soak must record duration, restart count, recovered jobs, unresolved
approvals, audit verification result, and final state. A green exit code alone
is not sufficient evidence.

### 3. Operator confirmation for dangerous features

Before enabling any of the following, show a concise impact summary:

- multi-user host;
- unconfined-process extensions;
- network-enabled capabilities;
- autonomous self-improvement;
- external browser mutations;
- experimental replay, rewind, capsule, or counterfactual actions.

The summary must state what authority changes, what approval gates remain,
what can be rolled back, what cannot be rolled back, and where the audit record
will be stored. The confirmation must be explicit and must not be inferred
from package installation or discovery.

### 4. Runtime state separation

Keep mutable runtime state outside the source checkout in documented examples
and release workflows. The default state path must remain owner-only and must
not be included in source archives or diagnostics.

Verify that these are never bundled or uploaded:

- `.odinn/oauth/`;
- gateway tokens;
- audit signing keys;
- browser profiles;
- raw prompts and provider responses containing private data;
- runtime databases and recovery journals.

### 5. Release and rollback hygiene

Treat every release as an immutable artifact identified by its exact commit,
version, archive checksum, lockfile state, and Node/pnpm toolchain.

The release proof must include:

- source archive contents;
- ZIP and tarball checksums;
- SBOM and provenance output;
- installed version path;
- current and previous installer pointers;
- successful rollback;
- post-rollback onboarding and deterministic-tool smoke.

Remove or explain noisy optional-workspace messages such as:
`No projects matched .../adapters/**`.

### 6. Observability and diagnostics

Add stable correlation identifiers to runtime logs and operator views:

- run ID;
- job ID;
- session ID;
- task/step ID;
- provider attempt number;
- recovery or approval record ID.

Errors should report a useful category and next action without exposing
secrets, prompts, OAuth tokens, cookies, or private filesystem details.

Add a concise diagnostic command or report that summarizes:

- Odinn version and commit;
- operating system and Node version;
- provider mode, without credentials;
- active experimental flags;
- audit verification status;
- pending approvals and unresolved browser recovery;
- queued, running, failed, and needs-review jobs.

### 7. Experimental-surface contract tests

For every experimental feature, verify all of the following:

- disabled means unreachable or rejected;
- enablement is explicit and persisted;
- the feature cannot broaden unrelated capabilities;
- failure leaves a durable audit record;
- restart preserves the correct state;
- rollback or disable behavior is documented;
- unsupported remote guarantees are not implied by the API response.

Do not add features to the default policy while doing this work.

## Exit gates

Beta 3 cannot ship until all gates pass:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm smoke:onboarding`
- `pnpm test:integration`
- `pnpm smoke:inference`
- `pnpm benchmark:ci`
- `pnpm release:preflight`
- `pnpm release:package`
- `pnpm release:checksums`
- `node scripts/release/verify.ts`
- `pnpm release:install-smoke`
- dependency audit with a valid scanner result
- release-candidate soak with captured evidence
- Linux, macOS, and Windows package smoke
- protected release-environment approval

## Order of operations

1. Freeze the current beta surface and write the claim matrix.
2. Add diagnostics and dangerous-feature confirmation summaries.
3. Build the packaged release-candidate soak.
4. Harden runtime-state and artifact boundaries.
5. Remove noisy or expired temporary paths.
6. Run the full release gates on the exact candidate artifact.
7. Publish only after rollback and post-rollback smoke succeed.

## Stop conditions

Stop the release and investigate if any of these occur:

- audit verification fails or silently skips records;
- a queued job is replayed after an unsafe or unknown outcome;
- an approval or browser recovery record disappears across restart;
- a disabled feature changes runtime behavior;
- an installer pointer changes non-atomically;
- a package contains runtime state or credentials;
- a test passes only from the source tree but fails from the packaged artifact;
- a remote-host test suggests OS-level isolation that has not been proven.

## Release principle

Beta 3 should make Ódinn boring in the best possible way: fewer surprises,
clearer boundaries, recoverable failures, and evidence that survives contact
with a real machine.
