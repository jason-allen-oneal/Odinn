# Odinn

Odinn is a fast, stable, cross-platform personal AI agent runtime. It takes the strongest ideas from OpenClaw's multi-channel assistant model and Hermes's terminal, memory, learning, automation, and delegation experience, while keeping the core smaller and fault-isolated.

This repository is a clean-room implementation. It does not copy OpenClaw or Hermes source code.

## Current status

Odinn is at the bootstrap stage. The first vertical slice includes:

- A cross-platform TypeScript monorepo targeting Node.js 24
- A minimal HTTP and WebSocket gateway
- A SQLite WAL event store
- An explicit agent-run state machine
- Platform abstractions for paths, shells, IPC, and service installation
- A CLI with `init`, `doctor`, `gateway`, `status`, and `run`
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
pnpm build
pnpm --filter @odinn/cli start init
pnpm --filter @odinn/cli start gateway
```

In another terminal:

```bash
pnpm --filter @odinn/cli start status
pnpm --filter @odinn/cli start run "Hello, Odinn"
```

The gateway defaults to `127.0.0.1:18790`.

## Repository layout

```text
apps/
  cli/               User-facing CLI and future TUI entry point
  gateway/           Thin HTTP/WebSocket control plane
packages/
  kernel/            Run lifecycle and orchestration primitives
  platform/          Cross-platform paths, shells, IPC, and services
  protocol/          Shared schemas and wire contracts
  store-sqlite/      Durable SQLite event and run storage
```

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) and [docs/architecture.md](docs/architecture.md).

## Security

Odinn is pre-alpha and is not safe for untrusted remote exposure. See [SECURITY.md](SECURITY.md).

## License

MIT
