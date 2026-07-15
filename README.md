# Ódinn

Ódinn is a fast, stable, cross-platform personal AI agent runtime. It takes the strongest ideas from OpenClaw's multi-channel assistant model and Hermes's terminal, memory, learning, automation, and delegation experience, while keeping the core smaller and fault-isolated.

This repository is a clean-room implementation. It does not copy OpenClaw or Hermes source code.

## Current status

Ódinn is at the initial local beta milestone. The current implementation includes:

- A small Node.js 24 workspace with protocol, policy, file-store, kernel, and CLI packages
- A deterministic built-in tool registry for boring local work
- Capability policy checks before execution
- Append-only JSONL audit events for policy decisions, starts, completions, and failures
- Workspace-confined text reads
- Typed, provenance-bearing local memory records with search, curation, and correction/supersession
- Local sessions, goals, and auditable self-improvement proposals
- Local HTTP gateway with status, run, plan, runs, run detail, audit, and GUI endpoints
- OpenAI-compatible model providers through the audited `model.chat` capability
- Bounded `agent.run` tool loops with public web search/fetch and persistent browser access
- Browser/private-account actions behind explicit, auditable approval records
- Secure-by-default web/browser policy with domain allowlists, private-network blocking, and configurable action approval
- CLI commands for `init`, `onboard`, `config`, `doctor`/`status`, `tui`, `run`, `plan`, `audit`, `runs`, `show`, `memory`, `session`, `goal`, and `improve`
- A dependency-free local web console served by the gateway
- A chat-first web console with a Web & Browser capability workspace
- A read-only terminal dashboard for local status and recent runs
- CI coverage for Linux, macOS, and Windows

## Design goals

1. **Stable by isolation**: channels, model execution, tools, and storage will run behind explicit process boundaries.
2. **Durable by default**: accepted work, state changes, and events are persisted before acknowledgment.
3. **Cross-platform intentionally**: Windows, macOS, and Linux behavior is implemented behind a dedicated platform layer.
4. **Learn safely**: generated skills are versioned, scanned, evaluated, and reversible.
5. **Remain extensible**: skills, MCP servers, channel adapters, provider adapters, and execution backends use narrow contracts.
6. **Stay understandable**: compatibility and migration code stays outside the hot runtime path.

## Quick start

Requirements:

- Node.js 24 or newer
- Corepack

```bash
corepack enable
pnpm install
pnpm check
pnpm odinn onboard
pnpm onboard
pnpm tui
```

`pnpm odinn onboard` is the local workspace form of the eventual installed command, `odinn onboard`. `pnpm onboard` is a shorthand for the same onboarding flow. It creates the local `.odinn/config.json` state directory if needed and prints the next commands. `pnpm tui` shows the current workspace, policy, tools, and recent runs.

Run a deterministic tool:

```bash
pnpm --filter @odinn/cli start -- run --tool text.echo --input-json '{"text":"Hello, Odinn"}'
```

Run the local smoke plan:

```bash
pnpm --filter @odinn/cli start -- plan --file examples/local-smoke.plan.json
```

Inspect what happened:

```bash
pnpm --filter @odinn/cli start -- runs
pnpm --filter @odinn/cli start -- audit
```

Store and recall local memory:

```bash
pnpm odinn memory remember \
  --kind preference \
  --subject cli \
  --text "Prefer exact runnable commands with concise context." \
  --tags commands,ux

pnpm odinn memory search --query "runnable commands"
pnpm odinn memory curate
```

Track a session, goal, and improvement proposal:

```bash
pnpm odinn session create --title "Beta test"
pnpm odinn goal create --title "Reach local beta"
pnpm odinn improve propose \
  --title "Add install smoke test" \
  --rationale "Beta should prove the installed command path."
```

A deterministic plan is plain JSON:

```json
{
  "name": "local-smoke",
  "steps": [
    { "id": "health", "tool": "job.healthcheck" },
    { "id": "echo", "tool": "text.echo", "input": { "text": "ODINN_OK" } }
  ]
}
```

Run it with:

```bash
pnpm --filter @odinn/cli start -- plan --file examples/local-smoke.plan.json
```

Start the local gateway and GUI:

```bash
pnpm gui:start
```

Then open:

```text
http://127.0.0.1:18790/
```

You can also use the gateway directly:

```bash
curl http://127.0.0.1:18790/status
curl -X POST http://127.0.0.1:18790/run \
  -H 'content-type: application/json' \
  --data '{"tool":"text.echo","input":{"text":"Hello through gateway"}}'
```

## Model Providers

Onboarding supports both API keys and OAuth 2.0 with PKCE. Provider metadata is stored in `.odinn/config.json`; API keys and OAuth bearer tokens are never written there. OAuth tokens are stored in `.odinn/oauth/` with restrictive file permissions and refreshed automatically.

Use the local Ollama preset:

```bash
pnpm odinn onboard --provider ollama
```

Use OpenAI:

```bash
pnpm odinn onboard --provider openai
```

That uses the ChatGPT/Codex OAuth flow and opens the browser. For the direct API-key route:

```bash
export OPENAI_API_KEY="..."
pnpm odinn onboard --provider openai --auth api-key --model gpt-4.1-mini
```

To reuse an existing OpenClaw ChatGPT OAuth session without signing in again:

```bash
pnpm odinn auth import openclaw --state .odinn
```

The importer reads OpenClaw's local auth store read-only, selects its active
OpenAI profile, and writes only Odinn's own 0600 refreshable token file. Use
`--profile <id-or-email>` to select another account or `--source <path>` to
point at a copied `auth-profiles.json` or `openclaw-agent.sqlite`.

The same OpenAI-compatible path works with OpenRouter, LM Studio, or another compatible server:

```bash
pnpm odinn config provider add local \
  --base-url http://127.0.0.1:1234/v1 \
  --model my-model \
  --api-key-env LOCAL_MODEL_API_KEY
pnpm odinn config model default local:my-model
pnpm odinn config provider list
```

Odinn also ships URL-free presets for:

`openrouter`, `groq`, `together`, `mistral`, `deepseek`, `xai`, `moonshot`,
`moonshot-cn`, `fireworks`, `cerebras`, `cohere`, `deepinfra`, `nvidia`,
`zai`, `zai-cn`, `zai-coding`, `zai-coding-cn`, `qianfan`, `volcengine`,
`volcengine-plan`, `xiaomi`, `huggingface`, `venice`, `arcee`, `chutes`,
`featherless`, `gmi`, `kilocode`, `longcat`, `novita`, `litellm`, `vllm`,
`sglang`, `ollama`, `lmstudio`, `github-copilot`, `xai-oauth`, and
`antigravity` (`google-antigravity` alias).

Set the provider's documented API-key environment variable, then use the same
one-command flow:

```bash
export GROQ_API_KEY="..."
pnpm odinn onboard --provider groq
```

OAuth/device login is also URL-free:

```bash
pnpm odinn onboard --provider openrouter
pnpm odinn onboard --provider chutes
pnpm odinn onboard --provider github-copilot
pnpm odinn onboard --provider xai-oauth
pnpm odinn onboard --provider antigravity
```

`antigravity` uses the installed `agy` CLI for Google sign-in and inference.
Override the executable with `ODINN_ANTIGRAVITY_CLI` when needed. The hosted
flows store refreshable credentials under `.odinn/oauth/`; no bearer token is
written to the provider config.

See every preset's endpoint, environment variable, transport, and default model:

```bash
pnpm odinn config provider catalog
```

Qwen Portal remains token-import only, and Gemini CLI is intentionally not used;
Antigravity is the local Google alternative.

For an OAuth provider that is not built into the preset catalog:

```bash
pnpm odinn onboard \
  --provider my-oauth-provider \
  --auth oauth \
  --base-url https://api.example.test/v1 \
  --model my-model \
  --authorization-url https://auth.example.test/authorize \
  --token-url https://auth.example.test/token \
  --client-id odinn-local \
  --scope chat,offline
```

This starts a loopback callback listener, opens the authorization URL, validates the OAuth `state`, exchanges the code with PKCE, and saves the refreshable token locally. Add `--client-secret-env PROVIDER_CLIENT_SECRET` when the OAuth client requires a secret. Use `--no-open` to print the URL without launching a browser.

Import framework state and skills into an isolated Odinn state directory:

```bash
pnpm odinn import openclaw --state .odinn
pnpm odinn import hermes --state .odinn
```

Both commands support `--source <path>`, `--dry-run`, `--auth-only`,
`--skills-only`, and `--keep-default`. OAuth credentials are normalized into
Odinn's provider token store; imported skills are copied under
`.odinn/skills/imported/<framework>/`, with a manifest and selected persona or
memory support files under `.odinn/imports/<framework>/`. The source framework
is never modified. Imported skill execution is intentionally not enabled by
the import itself.

The chat landing page reads the configured models from `/status`. Every response runs through `model.chat`, so provider failures and policy decisions appear in the audit log.

## Local State

Odinn stores local runtime state in `.odinn/` by default:

- `.odinn/config.json` contains local policy and audit settings.
- `.odinn/audit.jsonl` records policy decisions, task starts, completions, failures, and plan events.
- `.odinn/records.jsonl` stores typed local records such as memory facts, corrections, sessions, goals, and improvement proposals.
- `.odinn/oauth/` stores refreshable OAuth tokens with restrictive permissions.
- `.odinn/imports/` stores framework import manifests and support files.
- `.odinn/skills/imported/` stores copied skills awaiting explicit review and activation.
- `.odinn/browser-profile/` stores the isolated Chromium profile used for private-account work.

## Capabilities and security posture

The beta can search and fetch public web pages, and it can operate a user-managed browser profile for sites where the user has logged in. It does not silently import cookies from another browser. The user opens the browser workspace, signs in manually, and Ódinn can then read the visible page. Actions that can change external state stop for approval by default.

The default posture is loopback-only, public-network-only web access, no private-network access, domain restrictions available but empty, and approval required for browser actions. Configure it in `.odinn/config.json` or with the CLI:

```json
{
  "policy": {
    "security": {
      "web": {
        "enabled": true,
        "allowPrivateNetwork": false,
        "allowedDomains": [],
        "blockedDomains": []
      },
      "browser": {
        "enabled": true,
        "allowPrivateNetwork": false,
        "allowedDomains": [],
        "blockedDomains": [],
        "requireApproval": true
      }
    }
  }
}
```

Useful commands:

```bash
pnpm odinn config security show
pnpm odinn config security set --surface web --allowed-domains docs.example.com,example.org
pnpm odinn config security set --surface browser --require-approval false
pnpm odinn config security set --surface browser --allow-private-network true
```

The last two commands deliberately weaken the default posture. Only use them for a controlled local environment. `browser.click`, `browser.type`, and `browser.press` remain auditable; with approval enabled they appear in the console's Capabilities page and must be approved individually. The gateway refuses non-loopback binding unless `ODINN_ALLOW_REMOTE=1` is explicitly set, and remote exposure is not a supported beta deployment.

Reset local state with:

```bash
node -e "require('node:fs').rmSync('.odinn', { recursive: true, force: true })"
```

## Beta Safety

Ódinn is an initial local beta, not a hardened multi-user service. Do not expose the gateway to the public internet, do not run untrusted adapters or tools, and do not put secrets into plan files or audit logs. The gateway binds to `127.0.0.1` by default and refuses non-loopback hosts unless `ODINN_ALLOW_REMOTE=1` is explicitly set. Private-account access means a manually logged-in isolated browser profile, not credential extraction.

The runtime keeps deterministic local tools alongside the first OpenAI-compatible model path. SQLite storage, richer adapters, WebSocket events, schedulers, and long-running workers are still future work.

## Memory

Odinn memory is local, append-only JSONL for now. It is designed around reviewed records rather than hidden inference:

- `memory.remember` stores typed facts with `kind`, `subject`, `text`, `tags`, `source`, `authority`, `confidence`, `safeToAct`, and `avoid`.
- `memory.search` performs fast local lexical search over active records.
- `memory.correct` writes a correction record that supersedes an earlier memory without deleting history.
- `memory.curate` returns a compact grouped view of active records.

Supported memory kinds are `project`, `person`, `artifact`, `correction`, `procedure`, `decision`, `preference`, and `system`.

## Sessions, Goals, and Improvements

Odinn stores local operational records in the same append-only record log:

- `session.create`, `session.message`, `session.list`, and `session.read` provide a basic conversation/event lane.
- `goal.create`, `goal.update`, and `goal.list` provide durable task state without hiding state in chat.
- `improve.propose`, `improve.decide`, and `improve.list` provide a safe self-improvement loop: proposals are recorded first, then explicitly approved, rejected, or marked applied.

These are deliberately record-keeping tools right now. They do not autonomously edit files, install packages, send messages, or mutate policy.

## Repository layout

```text
apps/
  cli/               User-facing CLI and local TUI entry point
  gateway/           Local HTTP control plane and web console
packages/
  kernel/            Policy-gated task execution and built-in tool registry
  policy/            Capability policy evaluator
  protocol/          Shared schemas and wire contracts
  store-file/        Append-only JSONL audit store
```

## Roadmap

- WebSocket gateway events
- SQLite WAL event store
- More provider-specific adapters and model discovery
- Schedulers and deterministic automation jobs
- Plugin and skill package loading with signed manifests
- State machine for long-running agent tasks

## Security

Odinn is pre-alpha and is not safe for untrusted remote exposure. See [SECURITY.md](SECURITY.md).

## License

MIT
