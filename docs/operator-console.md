# Operator console

The local console at `http://127.0.0.1:18790/` is an authenticated view over the single-user gateway. Loading `/` sets the HttpOnly bootstrap cookie. Scripts should read the owner-only `.odinn/gateway.token` and use bearer authentication instead. Cookie-authenticated mutations require an exact scheme, host, and port Origin.

## Sessions and usage

Sessions are durable conversation records exposed through `/sessions` and `/sessions/<id>`. The Sessions view creates, filters, inspects, updates, and deletes those records. Usage is derived from persisted audit and run events; it reports model calls, recorded token counts, failures, routes, and recent runs. It is operational telemetry, not a provider invoice.

## Cron Jobs

Cron Jobs are stored in `.odinn/cron-jobs.json` and evaluated by the running gateway every 30 seconds. `/cron` creates and lists jobs; `/cron/<id>` updates or deletes them; `/cron/<id>/run` starts one immediately. A scheduled job invokes an existing registered tool through the same isolated-worker, policy, quota, idempotency, and audit boundary as an ordinary gateway task. The gateway must remain running for schedules to fire.

Cron expressions contain five fields. Each job has an explicit IANA timezone, tool, and JSON input. Treat creation or editing as a privileged control-plane mutation.

## Tasks, Proof, and audit

Tasks is the operator view over durable runs, Proof results, audit-chain verification, uncertain outcomes, and replayable evidence. It is not a general-purpose arbitrary tool runner. Proof remains disabled by default and command assertions require exact operator-owned argument-vector allowlisting. The audit view verifies integrity; it does not make a local journal tamper-proof against an attacker who controls the state directory.

## Agent SDK packages

Agents manages declarative Agent SDK v0.3 manifests through `/agents`, `/agents/validate`, and `/agents/<id>/lifecycle`. Installation validates and records package metadata; lifecycle controls enable, disable, or quarantine a package. This beta surface is a package registry and inspector, not an Agent SDK execution engine. Package metadata is not executable trust, and registration does not bypass extension, sandbox, capability, network, secret, or policy controls.

Agent package state is stored in `.odinn/agents.json`. Keep package instructions and integrity metadata reviewable before enablement.

## Skills and Skill Workshop

Skills discovers `SKILL.md` files in the workspace and validated drafts under `.odinn/skill-workshop/`, plus registered skill extensions. This beta surface is discovery and review only; it does not inject skills into model context, activate them, or grant execution authority.

Skill Workshop validates a package name, trigger description, and workflow instructions, then stages a real `SKILL.md` draft through `/skills/workshop/validate` and `/skills/workshop/save`. Saved drafts remain reviewable files and appear in Skills with draft status. Workshop does not silently install, enable, or execute a skill.

## Remote hosting

The console may be reached through the dedicated TLS multi-user host. Each tenant receives a separate gateway, state root, workspace, browser profile, and quota boundary. This remains application-level separation. Mutually hostile users require separate operating-system users, containers, or machines.
