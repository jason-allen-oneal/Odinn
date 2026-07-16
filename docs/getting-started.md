# Getting started with Ódinn Forge

Ódinn Forge needs Node.js 24 or newer. Install the release for your platform, then run:

```bash
odinn onboard --provider openai
odinn start
```

The first command opens the provider sign-in flow. The second starts the private local gateway and opens the chat console at `http://127.0.0.1:18790/`.

## Other provider paths

Use an OpenAI API key instead of OAuth:

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
