# Public beta guide

Ódinn Forge's public beta is for real users running a local-first personal agent on a machine they control. Expect rough edges, incomplete provider-specific behavior, and breaking changes between beta releases. Do not use it as a safety-critical service or as a hostile-code sandbox.

Use the [Beta 3 surface matrix](BETA-3-SURFACE-MATRIX.md) as the operator-facing source for the four classifications: **verified local behavior**, **experimental and disabled by default**, **provider- or platform-dependent**, and **explicitly unsupported**.

The three hard limits are:

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Supported beta boundary

- Linux, macOS, or Windows with Node.js 24 or newer and Corepack.
- One local operator using the loopback gateway at `127.0.0.1`.
- Public web reading, an isolated browser profile, scoped durable memory, audited tools, projects, sessions, goals, and cron jobs. The console can register and inspect declarative Agent SDK packages and build integrity-checked Skill SDK packages; both install disabled, and registration and discovery do not execute or activate them.
- Explicit approval for browser mutations and other external side effects.
- Experimental Proof, Rewind, Sentinel, Capsules, Darwin, Capability, and Counterfactual features remain disabled until individually enabled.
- Automatic improvements runs by default and is limited to reversible, allowlisted reliability tuning.

The TLS multi-user host is available to experienced operators, but remote hosting is application-level tenant isolation, not hostile-user OS isolation. It is not the default public-beta path. Do not expose the single-user gateway to a network.

## Install a verified release

Download the newest prerelease from the repository's Releases page. Release assets include ZIP and tar.gz source archives, `SHA256SUMS.txt`, an SPDX SBOM, and a release manifest. GitHub also exposes build-provenance attestations for the workflow-built assets.

### Linux and macOS

Replace `<tag>` with the exact prerelease tag shown on the Releases page:

```bash
tag=<tag>
curl -fLO "https://github.com/jason-allen-oneal/Odinn/releases/download/$tag/odinn-$tag.tar.gz"
curl -fLO "https://github.com/jason-allen-oneal/Odinn/releases/download/$tag/SHA256SUMS.txt"
grep "  odinn-$tag.tar.gz$" SHA256SUMS.txt | sha256sum -c -
tar -xzf "odinn-$tag.tar.gz"
cd "odinn-$tag"
corepack enable
./scripts/install.sh --prefix "$HOME/.local/share/odinn"
export PATH="$HOME/.local/share/odinn/bin:$PATH"
odinn onboard
```

In a terminal, onboarding provides Quick, Guided, Blank Slate, and detected
OpenClaw/Hermes import paths. Existing installs get separate Open, Repair,
Change AI, Review capabilities, Advanced, and confirmed reset actions. Changes
are staged and backed up, custom policies are preserved by default, and a real
model response must succeed before a connected setup is accepted. For automated
or headless setup, pass explicit provider flags such as
`odinn onboard --provider openai --auth api-key`. Run
`odinn onboard --verify --non-interactive` for a standalone capability check.

On macOS, use `shasum -a 256 -c` instead of `sha256sum -c` when GNU coreutils is unavailable.

### Windows PowerShell

Replace `<tag>` with the published tag:

```powershell
$Tag = "<tag>"
$Archive = "odinn-$Tag.zip"
Invoke-WebRequest "https://github.com/jason-allen-oneal/Odinn/releases/download/$Tag/$Archive" -OutFile $Archive
Invoke-WebRequest "https://github.com/jason-allen-oneal/Odinn/releases/download/$Tag/SHA256SUMS.txt" -OutFile SHA256SUMS.txt
$Expected = ((Select-String -Path SHA256SUMS.txt -Pattern "  $([regex]::Escape($Archive))$").Line -split "  ")[0]
$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw "checksum mismatch for $Archive" }
Expand-Archive $Archive -DestinationPath . -Force
Set-Location "odinn-$Tag"
corepack enable
./scripts/install.ps1 -Prefix "$HOME/.local/share/odinn"
$env:Path = "$HOME/.local/share/odinn/bin;$env:Path"
odinn.cmd onboard
odinn.cmd start
```

The installer keeps immutable version directories and a previous-version pointer. Inspect or roll back with:

```bash
node scripts/install.ts status --prefix "$HOME/.local/share/odinn"
node scripts/install.ts rollback --prefix "$HOME/.local/share/odinn"
```

## Privacy and external services

Ódinn Forge has no built-in product telemetry. Runtime state, browser profiles, audit records, memory, and credentials stay in the configured local state directory unless you deliberately use a remote host or external provider.

Model providers receive the prompts, recalled context, and tool results sent to their configured API. Websites receive normal browser or fetch traffic. Imported skills, MCP servers, extensions, and browser pages are untrusted input. Review them before enabling them and never post `.odinn`, OAuth files, gateway tokens, browser profiles, or raw diagnostic bundles publicly. External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

## Before reporting a bug

Capture the smallest safe reproduction:

```bash
odinn doctor
odinn status
odinn audit verify
odinn runs
```

The diagnostic report includes the Odinn version and commit, platform and Node
version, provider mode without credentials, experimental flags, audit status,
pending approvals, browser recovery, and job counts. It deliberately omits
state paths, tokens, prompts, cookies, and provider secrets. The running
gateway exposes the same safe report at `GET /diagnostics`.

Include the operating system, Node.js version, Odinn Forge version, provider name, exact command or UI action, expected result, observed result, and sanitized logs. Remove API keys, OAuth tokens, cookies, prompts containing private data, local usernames, private hostnames, and filesystem paths that identify people or clients.

Use the repository's bug-report form for ordinary defects. Suspected vulnerabilities must use GitHub private vulnerability reporting as described in `SECURITY.md`; never disclose an unpatched security issue in a public ticket.

## Beta feedback

Useful reports describe an actual workflow: what you tried, whether onboarding succeeded, where the interface became confusing, which provider or tool was involved, and whether restart or rollback recovered cleanly. Feature requests should explain the outcome needed rather than prescribing a large architecture from the void.
