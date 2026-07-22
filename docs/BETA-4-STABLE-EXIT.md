# Beta 4 stable-exit plan

Beta 4 is a stabilization and real-world validation release. It does not add a
new runtime subsystem. A gate is complete only when its evidence is linked from
the release pull request or recorded in the release artifacts.

## 1. Security closeout

- [ ] No unresolved production CodeQL alerts.
- [ ] Test-only and intentional cryptographic findings are fixed or documented
  as reviewed false positives.
- [ ] OpenSSF Scorecard findings are either corrected or triaged with a written
  rationale; a green scanner run alone does not close this gate.
- [ ] Proxy and CLI failures expose useful errors without returning internal
  network details, credentials, tokens, or stack traces.
- [ ] The release workflow uses least-privilege job permissions.

## 2. Dependency and toolchain policy

- [ ] Merge routine GitHub Actions updates after required review and green checks.
- [ ] Keep Node.js 24 and TypeScript 5.9 as the Beta 4 compatibility baseline.
- [ ] Treat Node.js type-definition 26 and TypeScript 6 updates as explicit
  migrations with cross-platform evidence, not routine patch upgrades.
- [ ] Dependency and secret-scanning alerts are clear at the release commit.

## 3. Resource-bounded development and release checks

- [x] Recursive workspace jobs default to one worker.
- [x] Dependency lifecycle scripts default to one worker.
- [x] Node.js package scripts default to a 1536 MB old-space limit.
- [x] A clean source archive install and release soak complete with the limits in
  effect on a representative developer machine.

The defaults can be deliberately changed with
`ODINN_WORKSPACE_CONCURRENCY` and `ODINN_NODE_MAX_OLD_SPACE_MB` when runner
capacity is known. Validation evidence must record any override.

## 4. Clean-machine validation

Record the exact OS, architecture, Node.js version, package-manager version,
archive checksum, provider path, result, and sanitized failure evidence.

| Platform | Install | Onboarding | Provider run | Restart/recovery | Rollback |
| --- | --- | --- | --- | --- | --- |
| Linux | [x] | [x] | [x] | [x] | [ ] |
| macOS | [x] | [x] | [ ] | [ ] | [x] |
| Windows | [ ] | [ ] | [ ] | [ ] | [ ] |

At least one cloud OAuth path, one API-key path, and one local Ollama path must
be exercised across the matrix. Synthetic CI-provider success does not count as
real-provider evidence.

## 5. Daily-use beta evidence

- [ ] At least three users complete onboarding without maintainer intervention.
- [ ] At least one user exercises Projects, Sessions, Goals, Memory, and audited
  tool execution for several days.
- [ ] Browser approval, interrupted-action recovery, gateway restart, job
  recovery, audit verification, and installer rollback are exercised outside the
  synthetic release soak.
- [ ] Usability failures are captured as reproducible issues and release-blocking
  failures are closed.
- [ ] Feedback confirms the documented security and privacy boundaries are
  understandable to a new operator.

## 6. Stable-release decision

The stable-release candidate requires all preceding gates, a green protected CI
run, verified release archives/checksums/SBOM/provenance, no unresolved P0 or P1
defects, and an explicit maintainer go/no-go decision. Embedding/vector retrieval,
major UI expansion, and additional experimental subsystems remain follow-up work
unless validation identifies them as necessary to fix a release-blocking workflow.
