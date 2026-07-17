# Getting started with Ódinn Forge

Ódinn Forge needs Node.js 24 or newer. Install the release for your platform, then run:

For release downloads, checksum verification, privacy expectations, and beta support, start with the [public beta guide](public-beta.md).

```bash
odinn onboard
```

On a new installation, onboarding offers **Quick setup**, **Guided setup**, and **Blank slate**. If it finds a compatible OpenClaw or Hermes sign-in, it also offers to copy that sign-in without changing the original installation. It then asks for an explicit model, explains capabilities in plain language, tests a real AI response, and only saves after you approve the final review.

Running onboarding again does not silently rebuild an existing setup. It starts with **Open Ódinn**, **Repair connection**, **Change AI or model**, **Review capabilities**, **Advanced settings**, and a separately confirmed **Start setup over** action. Custom capability policies are labeled Custom and preserved exactly unless you explicitly replace them.

Setup changes are staged before they touch the working configuration. Existing configurations are backed up, writes are atomic, and cancellation leaves the current setup unchanged. If Ódinn is already running, onboarding opens the existing console instead of binding a second server to the same port.

Run the same real AI capability check at any time:

```bash
odinn onboard --verify --non-interactive
```

## Other provider paths

These explicit commands are intended for scripts, headless systems, and advanced configuration.

Use an OpenAI API key instead of browser sign-in:

```bash
export OPENAI_API_KEY="..."
odinn onboard --provider openai --auth api-key
```

Use a local Ollama model:

```bash
odinn onboard --provider ollama --model <installed-model>
odinn start
```

List every built-in provider preset:

```bash
odinn config provider catalog
```

## Useful commands

```bash
odinn status        # configuration and provider status
odinn onboard --verify --non-interactive # real AI response test
odinn sessions      # chat sessions
odinn runs          # recent audited runs
odinn audit verify  # verify the audit chain
odinn help --all    # advanced runtime commands
```

## Headless and custom ports

```bash
odinn start --no-open
odinn start --port 18800 --no-open
```

The standard gateway binds to loopback only. Remote and multi-user hosting require the dedicated host mode and explicit TLS configuration; do not expose the local gateway directly to a network.

## If startup fails

Run `odinn onboard` and choose **Repair connection** first. It distinguishes rejected credentials, exhausted usage, unavailable models, timeouts, offline local providers, and port conflicts. `odinn start` also detects a healthy existing console and opens it rather than starting a duplicate process.
