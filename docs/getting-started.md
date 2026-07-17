# Getting started with Ódinn Forge

Ódinn Forge needs Node.js 24 or newer. Install the release for your platform, then run:

For release downloads, checksum verification, privacy expectations, and beta support, start with the [public beta guide](public-beta.md).

```bash
odinn onboard
```

Onboarding walks through the AI connection and access level in plain language, then offers to open the private local chat console. If you choose not to open it immediately, run `odinn start` later.

Running onboarding again does not discard an existing setup. It shows the current AI, connection health, and access level first. You can keep those settings and open Ódinn, review them with the current choices preselected, or show technical details.

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

Run `odinn status` first. Common causes are a missing provider credential, a provider that has not completed OAuth, or port `18790` already being used. Choose another port with `odinn start --port <port>`.
