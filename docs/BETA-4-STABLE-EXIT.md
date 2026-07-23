# Beta 4 stable-exit plan

Beta 4 is a stabilization and real-world validation release. It does not add a
new runtime subsystem.

## Evidence model

A checked beta-evidence item means the behavior is implemented and has
regression, CI, release-artifact, or recorded UAT evidence. It does not
automatically close a stable-release gate. A stable gate is complete only when
its exact-candidate or real-world evidence is linked from the release pull
request, attached to the release artifacts, or recorded in its tracking issue.
Synthetic providers and hosted CI runners do not count as live-provider,
daily-use, or clean-machine evidence.

Four issues collect the remaining release-blocking evidence:

| Gate | Required external evidence | Tracking |
| --- | --- | --- |
| Windows artifact validation | Real Windows installation, onboarding, restart/recovery, and rollback | [release blocker](https://github.com/jason-allen-oneal/Odinn/issues/49) |
| Live-provider validation | At least one cloud OAuth path and one API-key path | [release blocker](https://github.com/jason-allen-oneal/Odinn/issues/50) |
| Three-user, multi-day validation | Projects, Sessions, Goals, Memory, and audited tool execution | [release blocker](https://github.com/jason-allen-oneal/Odinn/issues/51) |
| Final security review and go/no-go | Exact-candidate security evidence, P0/P1 audit, and maintainer decision | [release blocker](https://github.com/jason-allen-oneal/Odinn/issues/52) |

## 1. Security closeout

Verified beta evidence:

- [x] Production CodeQL, dependency-audit, and secret-scanning checks are clear
  on the current beta candidate.
- [x] The release workflow grants write permissions only to the jobs that need
  provenance or release publication.

Stable-exit evidence is tracked in the
[final security review and go/no-go issue](https://github.com/jason-allen-oneal/Odinn/issues/52):

- [ ] No unresolved production CodeQL alerts at the exact stable candidate;
  recheck dependency and secret-scanning alerts at the same commit.
- [ ] Test-only and intentional cryptographic findings are fixed or documented
  as reviewed false positives.
- [ ] OpenSSF Scorecard findings are either corrected or recorded in the
  [written triage](security/openssf-scorecard-triage.md); a green scanner run
  alone does not close this gate.
- [ ] Proxy and CLI failures expose useful errors without returning internal
  network details, credentials, tokens, or stack traces.

## 2. Dependency and toolchain policy

- [ ] Merge routine GitHub Actions updates after required review and green checks.
- [x] Keep Node.js 24 and TypeScript 5.9 as the Beta 4 compatibility baseline.
- [ ] Treat Node.js type-definition 26 and TypeScript 6 updates as explicit
  migrations with cross-platform evidence, not routine patch upgrades.
- [ ] Dependency and secret-scanning alerts are clear at the exact stable
  release commit; record the recheck in the
  [final security review and go/no-go issue](https://github.com/jason-allen-oneal/Odinn/issues/52).

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
The [Beta 4 artifact UAT record](uat/v0.4.0-beta.1.md) supplies the checked
Linux/macOS and local Ollama evidence below. Cross-platform package CI is
supporting beta evidence; it does not check a clean-machine box by itself.

| Platform | Install | Onboarding | Provider run | Restart/recovery | Rollback |
| --- | --- | --- | --- | --- | --- |
| Linux | [x] | [x] | [x] | [x] | [ ] |
| macOS | [x] | [x] | [ ] | [ ] | [x] |
| Windows ([tracker](https://github.com/jason-allen-oneal/Odinn/issues/49)) | [ ] | [ ] | [ ] | [ ] | [ ] |

The local Ollama path has been exercised. At least one cloud OAuth path and one
API-key path remain open in the
[live-provider validation issue](https://github.com/jason-allen-oneal/Odinn/issues/50).
Synthetic CI-provider success does not count as real-provider evidence.
The remaining non-Windows restart/recovery and rollback observations are
collected with the daily-use evidence below.

## 5. Daily-use beta evidence

The following gates are tracked together in the
[three-user, multi-day validation issue](https://github.com/jason-allen-oneal/Odinn/issues/51):

- [ ] At least three users complete onboarding without maintainer intervention.
- [ ] Those users exercise Projects, Sessions, Goals, Memory, and audited tool
  execution over multiple days.
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
defects, and an explicit maintainer go/no-go decision recorded in the
[final security review and go/no-go issue](https://github.com/jason-allen-oneal/Odinn/issues/52).
Embedding/vector retrieval, major UI expansion, and additional experimental
subsystems remain follow-up work unless validation identifies them as necessary
to fix a release-blocking workflow.
