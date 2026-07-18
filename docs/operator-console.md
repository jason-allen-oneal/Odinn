# Operator console

The local console at `http://127.0.0.1:18790/` is an authenticated view over the single-user gateway. Loading `/` sets the HttpOnly bootstrap cookie. Scripts should read the owner-only `.odinn/gateway.token` and use bearer authentication instead. Cookie-authenticated mutations require an exact scheme, host, and port Origin. See the [Beta 3 surface matrix](BETA-3-SURFACE-MATRIX.md) for the operator-facing classification of every console-backed surface: **verified local behavior**, **experimental and disabled by default**, **provider- or platform-dependent**, and **explicitly unsupported**.

The three hard limits are:

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Projects, sessions, goals, and usage

Projects group related sessions and goals through `/projects`. Sessions default to the built-in Workspace project and can be reassigned. Goals must belong to a project or a specific session; session-scoped goals also inherit that session's project. Sessions remain durable conversation records exposed through `/sessions` and `/sessions/<id>`.

Usage and Audit share one accounting function over the signed audit journal. Both report distinct run IDs, completed `model.chat`/`agent.run` executions, recorded token counts, and semantic failed-or-denied outcomes. Usage is operational telemetry, not a provider invoice.

## Cron Jobs

Cron Jobs are stored in `.odinn/cron-jobs.json` and evaluated by the running gateway every 30 seconds. `/cron` creates and lists jobs; `/cron/<id>` updates or deletes them; `/cron/<id>/run` starts one immediately. A scheduled job invokes an existing registered tool through the same forked crash-containment worker, policy, quota, idempotency, and audit boundary as an ordinary gateway task. The worker is crash containment, not a security sandbox. The gateway must remain running for schedules to fire.

Cron expressions contain five fields. Each job has an explicit IANA timezone, tool, and JSON input. Treat creation or editing as a privileged control-plane mutation.

## Tasks, Proof, and Audit

Tasks is the operator view over meaningful user, agent, and automation runs. Routine console reads are hidden unless **System activity** is enabled. Each task shows its actual audit timeline, duration, outcome, evidence count, and whether recorded input is declared safe to replay. The replay endpoint enforces the same retry-safe classification server-side; external effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

Audit provides server-side search, type/tool/actor/outcome/date filtering, pagination, JSON export, and integrity verification. Proof remains disabled by default and command assertions require exact operator-owned argument-vector allowlisting. Chain verification detects journal damage; it does not make a local journal tamper-proof against an attacker who controls the state directory.

## Experimental Lab

Experimental Lab is the console home for Proof, Sentinel, Capability Tokens, Rewind, Capsules, Counterfactuals, and Darwin. It reads the active startup gates from `/status`, lists recent records from the SQLite runtime ledger, and exposes a fixed set of forms backed by the existing authenticated experimental endpoints. Requests are not arbitrary URLs: each workbench action maps to a known method and route.

The lab does not weaken the disabled-by-default posture. A disabled feature stays locked, destructive operations remain explicit, Rewind and Counterfactual selection default to previews, and configuration changes require an intentional edit or `odinn experimental enable <feature>` followed by a gateway restart. The CLI equivalent is `odinn experimental status`; use `odinn experimental help <feature>` to see the real commands behind one system.

## Agent SDK packages

Agents manages declarative Agent SDK v0.3 manifests through `/agents`, `/agents/validate`, and `/agents/<id>/lifecycle`. Installation validates and records package metadata; lifecycle controls enable, disable, or quarantine a package. This beta surface is a package registry and inspector, not an Agent SDK execution engine. Package metadata is not executable trust, and registration does not bypass extension, sandbox, capability, network, secret, or policy controls.

Agent package state is stored in `.odinn/agents.json`. Keep package instructions and integrity metadata reviewable before enablement.

## Skill SDK packages

Skills is one Skill SDK v0.1 package registry and builder. `/skills/validate` validates the manifest and rendered `SKILL.md`; `/skills` installs it into managed storage; `/skills/<id>/verify` checks persisted integrity; and `/skills/<id>/lifecycle` enables, disables, or quarantines the package. New packages are disabled and untrusted. Enabling requires a clean integrity check.

The registry also discovers existing workspace and imported `SKILL.md` files as unmanaged packages. Discovery does not silently install, trust, enable, inject, or execute them. Managed package state lives under `.odinn/skills/`; legacy workshop endpoints remain compatibility-only and are not shown in the console.

## Memory

Memory shows persisted records, namespaces, scope, provenance, authority, confidence, and the runtime's actual read/write integration state. Records may be global, project-scoped, or session-scoped. Corrections supersede prior records rather than rewriting history. Automatic agent recall and learning are independently gated by `memory.read` and `memory.write` plus each concrete tool denial; `agent.run` routes those operations through the normal audited policy boundary.

## Remote hosting

The console may be reached through the dedicated TLS multi-user host. Each tenant receives a separate gateway, state root, workspace, browser profile, and quota boundary. Remote hosting is application-level tenant isolation, not hostile-user OS isolation. Mutually hostile users require separate operating-system users, containers, or machines.
