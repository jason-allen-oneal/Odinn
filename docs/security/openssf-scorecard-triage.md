# OpenSSF Scorecard triage

This record covers the five open Scorecard code-scanning alerts observed on
July 22, 2026. The scan evaluated `main` at
[`31c3034`](https://github.com/jason-allen-oneal/Odinn/commit/31c3034f287932cc157d622d39df5632c2b127bd).
It is a point-in-time triage record, not a claim that every Scorecard check
scores 10.

## Production alert snapshot

At the time of this review, the GitHub APIs reported no open CodeQL, Dependabot,
or secret-scanning alerts. The corresponding
[Security workflow](https://github.com/jason-allen-oneal/Odinn/actions/runs/29892689978)
also completed successfully. Recheck all three alert classes at the release
commit; this snapshot does not close the stable-release security gate.

## Scorecard dispositions

| Finding | Current disposition | Exit evidence |
| --- | --- | --- |
| Security Policy | Open pending the next default-branch scan. The policy now links directly to private reporting and defines response and coordinated-disclosure targets. | A later Scorecard scan recognizes the updated [`SECURITY.md`](../../SECURITY.md). |
| Fuzzing | Open pending the next default-branch scan. Generated-input property tests must be merged into the normal test path, and this record does not pre-empt the scanner's result. | A later Scorecard scan recognizes the merged property-test evidence. |
| Code Review | Accepted sole-maintainer limitation; not remediated. GitHub contributor metadata currently lists one human contributor, and [`CODEOWNERS`](../../.github/CODEOWNERS) names one owner. `main` requires one approving code-owner review, but [administrator enforcement remains disabled](../repository-policy.md) because the owner cannot independently approve their own change. Retain the administrator bypass until an independent maintainer is active. | Add an independent maintainer, require their review, enforce the rule for administrators, and confirm the result in a later scan. |
| Maintained | Age-bound; not evidence of maintainer inactivity. The repository was created on July 12, 2026, so the check cannot clear its 90-day age guard before October 10, 2026. | Re-run on or after October 10, 2026, with continued maintenance activity. |
| CII Best Practices | Deferred during prerelease; unresolved. No OpenSSF Best Practices badge is claimed, and this disposition does not treat the gap as fixed. | Reconsider badge enrollment after prerelease stabilization. |

The live [Scorecard result](https://api.scorecard.dev/projects/github.com/jason-allen-oneal/Odinn)
and GitHub's [security overview](https://github.com/jason-allen-oneal/Odinn/security)
remain the authoritative current status.
