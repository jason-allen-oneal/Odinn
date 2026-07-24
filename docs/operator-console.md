# Operator console

The local console at `http://127.0.0.1:18790/` is an authenticated view over the single-user gateway. Loading `/` sets the HttpOnly bootstrap cookie. Scripts should read the owner-only `.odinn/gateway.token` and use bearer authentication instead. Cookie-authenticated mutations require an exact scheme, host, and port Origin. See the [Beta 3 surface matrix](BETA-3-SURFACE-MATRIX.md) for the operator-facing classification of every console-backed surface: **verified local behavior**, **experimental and disabled by default**, **provider- or platform-dependent**, and **explicitly unsupported**.

The three hard limits are:

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Projects, sessions, goals, and activity

Projects group related sessions and goals through `/projects`. Sessions default to the built-in Workspace project and can be reassigned. Goals must belong to a project or a specific session; session-scoped goals also inherit that session's project. Sessions remain durable conversation records exposed through `/sessions` and `/sessions/<id>`.

The Activity page combines the usage overview and searchable history in two tabs over the same signed audit journal. It reports distinct run IDs, completed `model.chat`/`agent.run` executions, recorded token counts, and semantic failed-or-denied outcomes. The overview shows only the four latest model conversations. Activity is operational telemetry, not a provider invoice.

## Cron Jobs

Cron Jobs are stored in `.odinn/cron-jobs.json` and evaluated by the running gateway every 30 seconds. `/cron` creates and lists jobs; `/cron/<id>` updates or deletes them; `/cron/<id>/run` starts one immediately. A scheduled job invokes an existing registered tool through the same forked crash-containment worker, policy, quota, idempotency, and audit boundary as an ordinary gateway task. The worker is crash containment, not a security sandbox. The gateway must remain running for schedules to fire.

Cron expressions contain five fields. Each job has an explicit IANA timezone, tool, and JSON input. Treat creation or editing as a privileged control-plane mutation.

## Tasks, Proof, and activity history

Tasks is the operator view over meaningful user, agent, and automation runs. Routine console reads are hidden unless **System activity** is enabled. Server-side search, filtering, and pagination keep the list bounded. Operators can select tasks, stop active supervised jobs, and run tasks again only when recorded input is declared retry-safe. The replay endpoint enforces the same classification server-side; external effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

The History tab in Activity provides server-side search, type/tool/actor/outcome/date filtering, pagination, JSON export, and integrity verification. Proof remains disabled by default and command assertions require exact operator-owned argument-vector allowlisting. Chain verification detects journal damage; it does not make a local journal tamper-proof against an attacker who controls the state directory.

Runtime errors return a stable request correlation ID in the `x-odinn-request-id`
header and JSON body. Audit entries retain run, task/step, provider-attempt,
approval, and browser-recovery identifiers where applicable. Use `odinn doctor`
or `GET /diagnostics` for a redacted health snapshot rather than collecting the
raw state directory.

## Labs

Labs is a collapsible navigation group, not a landing page. Run Checks, Safety Preview, Temporary Access, Restore Points, Portable Runs, Compare Approaches, and Smart Routing each have a dedicated page with a guided workflow. Developer input and raw endpoint details stay collapsed under Advanced options.

The seven Labs feature flags remain off by default. A disabled feature stays locked, destructive operations remain explicit, and restore or comparison selection defaults to a preview. Configuration changes require an intentional edit or `odinn experimental enable <feature> --confirm-impact` followed by a gateway restart.

Automatic improvements has its own page and runs by default. It uses the configured model for plain-language assessment and applies only reversible, allowlisted reliability adjustments.

## Agent SDK packages

The Agent SDK page manages declarative Agent SDK v0.3 manifests through `/agents`, `/agents/validate`, and `/agents/<id>/lifecycle`. Installation validates and records package metadata; lifecycle controls enable, disable, or quarantine a package. This beta surface is a package registry and inspector, not an Agent SDK execution engine. Package metadata is not executable trust, and registration does not bypass extension, sandbox, capability, network, secret, or policy controls.

Agent package state is stored in `.odinn/agents.json`. Keep package instructions and integrity metadata reviewable before enablement.

## Skills SDK packages

The Skills SDK page is one Skill SDK v0.1 package registry and builder. `/skills/validate` validates the manifest and rendered `SKILL.md`; `/skills` installs it into managed storage; `/skills/<id>/verify` checks persisted integrity; and `/skills/<id>/lifecycle` enables, disables, or quarantines the package. New packages are disabled and untrusted. Enabling requires a clean integrity check.

The registry also discovers existing workspace and imported `SKILL.md` files as unmanaged packages. Discovery does not silently install, trust, enable, inject, or execute them. Managed package state lives under `.odinn/skills/`; legacy workshop endpoints remain compatibility-only and are not shown in the console.

## Memory

Memory automatically extracts durable candidates from conversations and recalls accepted context when relevant. Candidates remain pending until the user keeps or dismisses them in the Memory page; keeping one can use the suggested scope, make it global, or place it in one project. Saved memories may be global, project-scoped, or session-scoped. Edits supersede prior records rather than rewriting history, and forgetting appends a deactivation record so the memory immediately stops participating in search and recall. Automatic suggestion, recall, compaction, and user decisions remain gated by `memory.read`/`memory.write` and the concrete tool policy; `agent.run` routes them through the normal audited boundary.

## Remote hosting

The console may be reached through the dedicated TLS multi-user host. Each tenant receives a separate gateway, state root, workspace, browser profile, and quota boundary. Remote hosting is application-level tenant isolation, not hostile-user OS isolation. Mutually hostile users require separate operating-system users, containers, or machines.
