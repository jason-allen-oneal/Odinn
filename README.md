# Ódinn

![Ódinn — local-first agent runtime](docs/odinn-header.png)

> A local-first personal AI agent runtime with durable memory, model freedom, real-world tools, and security controls that make dangerous choices explicit.

Ódinn is a cross-platform agent runtime for people who want an assistant that can do more than generate text without turning the machine into an unattended blast radius. It provides the kernel, policy layer, model/provider adapters, browser and web capabilities, sessions, audit trails, and a chat-first local console in one small Node.js workspace.

The project is a clean-room implementation. It does not copy OpenClaw, Hermes, OpenViking, or any other agent framework. It takes architectural inspiration from the problems those projects solve and implements Ódinn's own contracts, storage, and security model.

## Beta status

Ódinn is an initial local beta. The core loop is usable:

- chat with configured models through API keys, OAuth, imported OAuth sessions, local servers, or CLI adapters;
- recall durable user and project context across sessions;
- search the public web and fetch pages;
- operate an isolated browser profile for accounts you sign into manually;
- ask for approval before browser actions that can change external state;
- inspect sessions, memory, runs, goals, improvements, providers, and audit events;
- run deterministic tools and bounded model/tool loops through one audited kernel path.

It is not a hosted multi-user service. Do not expose the gateway to the public internet yet. The default posture is loopback-only, private-network blocking, and approval-required browser actions.

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
pnpm odinn onboard --provider ollama
```

Ódinn also includes URL-free presets for OpenRouter, Groq, Together, Mistral, DeepSeek, xAI, Moonshot, Fireworks, Cerebras, Cohere, DeepInfra, NVIDIA, Z.ai, Qianfan, Volcengine, Xiaomi, Hugging Face, Venice, Chutes, LiteLLM, vLLM, SGLang, LM Studio, GitHub Copilot, xAI device OAuth, and Antigravity.

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

## Memory

Ódinn's memory is an original local context system built around an append-only journal and explicit provenance. It is not a proprietary database clone and does not depend on a closed memory service.

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

Private-account access uses Ódinn's isolated persistent browser profile. The user logs in manually; Ódinn does not silently extract cookies from another browser. Browser reads are available to the agent, while clicks, typing, and keypresses require approval by default.

Security controls are configurable:

```bash
pnpm odinn config security show
pnpm odinn config security set --surface web --allowed-domains docs.example.com
pnpm odinn config security set --surface browser --require-approval false
```

The last command weakens the default posture. That is intentional: the user owns the dangerous decision, and the configuration makes the decision visible.

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

## Security

Read [SECURITY.md](SECURITY.md) before enabling remote access, disabling approvals, allowing private networks, or installing imported skills. The default gateway binds to `127.0.0.1`; remote binding requires an explicit environment override and is not a supported deployment mode yet.

## License

MIT
