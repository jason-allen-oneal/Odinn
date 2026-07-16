# Ódinn Forge

![Ódinn Forge — local-first agent runtime](docs/odinn-header.png)

> A local-first personal AI agent runtime with durable memory, model freedom, real-world tools, and security controls that make dangerous choices explicit.

Ódinn Forge is a cross-platform agent runtime for people who want an assistant that can do more than generate text without turning the machine into an unattended blast radius. It provides the kernel, policy layer, model/provider adapters, browser and web capabilities, sessions, audit trails, and a chat-first local console in one small Node.js workspace.

The project is a clean-room implementation. It does not copy OpenClaw, Hermes, OpenViking, or any other agent framework. It takes architectural inspiration from the problems those projects solve and implements Ódinn Forge's own contracts, storage, and security model.

## Beta status

Ódinn Forge is an initial local beta. The core loop is usable:

- chat with configured models through API keys, OAuth, imported OAuth sessions, local servers, or CLI adapters;
- recall durable user and project context across sessions;
- search the public web and fetch pages;
- operate an isolated browser profile for accounts you sign into manually;
- ask for approval before browser actions that can change external state;
- inspect sessions, memory, runs, goals, improvements, providers, and audit events;
- run deterministic tools and bounded model/tool loops through one audited kernel path.

The default gateway remains single-user and loopback-only. An opt-in multi-user host is available for remote deployments; it terminates TLS and routes each authenticated user into an independent loopback gateway, state root, workspace, audit ledger, OAuth store, and browser profile.

The verified beta foundation includes restart-safe queued jobs, forked gateway workers, durable approval and browser-recovery journals, provider retries and usage normalization, universally audited process/MCP extension execution, DNS-pinned public web fetches, symlink-safe workspace reads, owner-only state repair, versioned native installers with pointer rollback, signed audit-key rotation, bounded counterfactual execution, approved full capsule replay in disposable workspaces, autonomous rollback-safe reliability tuning, and tenant-isolated remote hosting. See [the P0 beta ledger](docs/P0-BETA-GATES.md).

## Quick start

Requirements: Node.js 24+ and Corepack.

```bash
corepack enable
pnpm install
pnpm check
pnpm odinn onboard
pnpm gui:start
```

Open [http://127.0.0.1:18790/](http://127.0.0.1:18790/).

For a deterministic smoke test:

```bash
pnpm odinn run --tool text.echo --input-json '{"text":"ODINN_OK"}'
pnpm odinn plan --file examples/local-smoke.plan.json
pnpm odinn runs
pnpm odinn audit
```

The packaged release gate is stronger than the local echo smoke: CI launches the gateway as a child process, configures a local OpenAI-compatible provider endpoint, sends a model request through the gateway, and verifies the assistant response was written to the run record. See [the P0 beta ledger](docs/P0-BETA-GATES.md) for what is implemented and what is still deliberately blocked.

### Phase 0 runtime ledger

Every CLI and gateway tool boundary can now write a durable SQLite run ledger with ordered steps, redacted content-addressed artifacts, conservative tool-safety metadata, experimental feature flags, and a SHA-256 event chain. Inspect a run without reading raw JSONL:

```bash
pnpm odinn run show <run-id> --state .odinn
pnpm odinn run events <run-id> --state .odinn
pnpm odinn run verify <run-id> --state .odinn
```

This is the shared foundation for the experimental Proof, Rewind, Sentinel, Capsule, Darwin, Capability, and Counterfactual slices. They are disabled by default and must be enabled individually:

```bash
pnpm odinn config experimental enable proof
pnpm odinn config experimental enable sentinel
pnpm odinn config experimental enable capabilities
```

Use `pnpm odinn config experimental show` to inspect the posture. Read the feature notes under [docs/features](docs/features/) before enabling them. See [the event-ledger architecture note](docs/architecture/event-ledger.md).

### Experimental runtime slices

- **Proof** runs shell-free command and file acceptance assertions, stores bounded evidence, and is the only path that can mark a run verified.
- **Sentinel** evaluates deterministic command, filesystem-root, and approval invariants before an operation.
- **Capability Tokens** bind short-lived, one-use authority to a run, step, tool, and resource constraint.
- **Rewind** snapshots selected local files and defaults to a dry-run restore preview.
- **Capsules** export redacted ZIP-compatible run bundles with checksum verification and safe extraction.
- **Counterfactual** creates physically isolated candidate workspaces and compares their durable run records; candidate execution and branch commit are still operator-driven.
- **Darwin** scores models from recorded verification, reliability, speed, cost, and policy outcomes.
- **Self-improvement** mines repeated audited failures into reviewable proposals. It does not rewrite code, change policy, install skills, or approve its own changes.

These are initial local slices, not a claim that arbitrary remote effects can be reversed or perfectly replayed. Browser sessions, external mutations, nondeterministic models, automatic counterfactual execution, and public hosting remain outside the safe beta boundary.

The authenticated gateway exposes the same experimental surfaces through `/runtime/runs`, `/proof`, `/policy/evaluate`, `/capabilities/*`, `/checkpoints`, `/rewind/*`, `/capsules/*`, `/counterfactual/*`, and `/routing/*`. Each surface remains disabled until its matching experimental flag is enabled in `.odinn/config.json`.

## Model providers

The normal provider path is intentionally short:

```bash
pnpm odinn onboard --provider openai
```

That uses the ChatGPT/Codex OAuth flow. API-key setup is explicit:

```bash
export OPENAI_API_KEY="..."
pnpm odinn onboard --provider openai --auth api-key
```

Local models work without a cloud account:

```bash
pnpm odinn onboard --provider ollama --model <installed-model>
```

Ódinn Forge does not assume a particular local model. Pass the model name already served by your Ollama instance.

Ódinn Forge also includes URL-free presets for OpenRouter, Groq, Together, Mistral, DeepSeek, xAI, Moonshot, Fireworks, Cerebras, Cohere, DeepInfra, NVIDIA, Z.ai, Qianfan, Volcengine, Xiaomi, Hugging Face, Venice, Chutes, LiteLLM, vLLM, SGLang, LM Studio, GitHub Copilot, xAI device OAuth, and Antigravity.

Inspect the catalog with:

```bash
pnpm odinn config provider catalog
```

Reuse an existing OpenClaw OAuth session without signing in again:

```bash
pnpm odinn auth import openclaw --state .odinn
```

Framework state and skills can be imported into an isolated state directory:

```bash
pnpm odinn import openclaw --state .odinn
pnpm odinn import hermes --state .odinn
```

Secrets stay outside `config.json`. OAuth tokens live in `.odinn/oauth/` with restrictive permissions.

Gateway API clients bootstrap a per-state bearer token by requesting `/` once, which sets an `HttpOnly` same-site cookie. Browser clients use that cookie automatically; scripts should send `Authorization: Bearer <token>` or the bootstrap cookie. The token is stored in `.odinn/gateway.token` with mode `0600`. Mutating requests also require a valid same-origin request.

## Memory

Ódinn Forge's memory is an original local context system built around an append-only journal and explicit provenance. It is not a proprietary database clone and does not depend on a closed memory service.

The current memory spine provides:

- durable typed records for preferences, people, projects, decisions, procedures, artifacts, corrections, and system facts;
- ranked lexical recall with subject, tag, confidence, and recency signals;
- hierarchical namespaces such as `user/preferences`, `project/decisions`, and `sessions/<id>`;
- three context tiers: L0 summaries, L1 durable facts, and L2 supporting evidence;
- automatic recall injected into bounded agent turns as clearly marked context;
- automatic extraction of strong user statements such as “remember that…”, “I prefer…”, and “we decided…”;
- session compaction into durable L0 summaries once conversations become long;
- namespace browsing and record inspection through the gateway, GUI, and CLI;
- duplicate suppression, corrections/supersession, and expiry enforcement;
- explicit `memory.recall`, `memory.remember`, `memory.search`, `memory.correct`, and `memory.curate` tools;
- session provenance linking learned facts back to the originating turn.

Manual memory commands remain available:

```bash
pnpm odinn memory remember \
  --kind preference \
  --subject cli \
  --text "Prefer exact runnable commands with concise context." \
  --tags commands,ux

pnpm odinn memory search --query "runnable commands"
pnpm odinn memory recall --query "how should CLI output behave?"
pnpm odinn memory browse --namespace user
pnpm odinn memory open --id <memory-id>
pnpm odinn memory compact --session <session-id>
pnpm odinn memory curate
```

The memory layer is deliberately transparent: inspect the journal, inspect the recall result, correct bad records, and audit the agent path. Embedding-backed retrieval and a pluggable vector index are planned extensions, not hidden magic pretending to exist today.

## Web, browser, and real-world actions

Public web access is available through `web.search` and `web.fetch`.

Private-account access uses Ódinn Forge's isolated persistent browser profile. The user logs in manually; Ódinn Forge does not silently extract cookies from another browser. Browser reads are available to the agent, while clicks, typing, and keypresses require approval by default.

Security controls are configurable:

```bash
pnpm odinn config security show
pnpm odinn config security set --surface web --allowed-domains docs.example.com
pnpm odinn config security set --surface browser --require-approval false
```

The last command weakens the default posture. That is intentional: the user owns the dangerous decision, and the configuration makes the decision visible.

State lifecycle commands are explicit and recoverable:

```bash
pnpm odinn state backup --output /secure/path/odinn-backup
pnpm odinn state restore --input /secure/path/odinn-backup --confirm
```

Extension manifests are inert until reviewed and enabled with explicit grants:

```bash
pnpm odinn extension install --manifest ./extension.json
pnpm odinn extension enable --id example-tool --grant web.read --trust
pnpm odinn extension run --id example-tool --capability web.read --input-json '{"query":"hello"}'
pnpm odinn extension disable --id example-tool
pnpm odinn extension rollback --id example-tool
```

Only explicitly trusted `process` extensions can execute. Tool extensions use Ódinn Forge's JSONL call contract; MCP extensions use a JSON-RPC `tools/call` JSONL contract. Container execution, unsandboxed execution, automatic installation, and implicit trust are not enabled by this beta.

## Architecture

```text
chat / CLI / plans
          │
          ▼
  audited gateway or CLI
          │
          ▼
 policy-gated kernel ─── model/provider adapters
          │              ├─ API key
          │              ├─ OAuth / device OAuth
          │              ├─ local OpenAI-compatible servers
          │              └─ CLI adapters
  ├── web and isolated browser tools
  ├── durable sessions, goals, improvements
  ├── original memory journal and ranked recall
          ├── SQLite run ledger, artifacts, snapshots, and verification evidence
          ├── Proof, Sentinel, capabilities, rewind, capsules, branches, and routing
          └── append-only audit events
```

Repository layout:

```text
apps/cli/              user-facing CLI and TUI
apps/gateway/          local HTTP gateway and web console
packages/kernel/       policy-gated execution, providers, memory, sessions
packages/policy/       capability and security policy evaluation
packages/protocol/     shared request and audit contracts
packages/store-file/   append-only local stores
tests/                 kernel, gateway, CLI, integration, and platform coverage
```

## Local state

By default, runtime state lives under `.odinn/`:

- `config.json` — provider and policy metadata;
- `records.jsonl` — memory, session, goal, and improvement records;
- `audit.jsonl` — policy decisions and execution events;
- `oauth/` — refreshable OAuth tokens;
- `browser-profile/` — the isolated Chromium profile;
- `imports/` and `skills/imported/` — reviewed framework imports.

Never put API keys, bearer tokens, or private account exports into plans, commits, or audit payloads.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

The beta currently targets Node.js 24 and supports Linux, macOS, and Windows paths through the platform layer.

Release-package validation extracts both source archives, installs with the frozen lockfile, completes onboarding in a fresh state directory, and executes a real CLI tool from the extracted tree. Run it locally with:

```bash
pnpm release:package
pnpm release:checksums
node scripts/release/verify.mjs
pnpm release:install-smoke
pnpm storage:drill
```

## Security

Read [SECURITY.md](SECURITY.md) before enabling remote access, autonomous improvement, disabling approvals, allowing private networks, or installing imported skills. Never bind the single-user gateway publicly. Remote deployments must use the separate multi-user host with TLS and explicit user provisioning.

Versioned install and rollback:

```bash
./scripts/install.sh --prefix "$HOME/.local/share/odinn"
node scripts/install.mjs upgrade --source . --prefix "$HOME/.local/share/odinn"
node scripts/install.mjs rollback --prefix "$HOME/.local/share/odinn"
```

Opt-in multi-user host:

```bash
ODINN_HOST_STATE=/srv/odinn ODINN_USER_PASSWORD='use-a-password-manager' \
  node apps/gateway/src/host.mjs user-add --id alice --workspace /srv/workspaces/alice

ODINN_HOST=0.0.0.0 ODINN_PORT=443 ODINN_HOST_STATE=/srv/odinn \
ODINN_PUBLIC_ORIGIN=https://odinn.example.com \
ODINN_TLS_CERT=/etc/letsencrypt/live/odinn.example.com/fullchain.pem \
ODINN_TLS_KEY=/etc/letsencrypt/live/odinn.example.com/privkey.pem \
  pnpm host:start
```

## License

MIT
