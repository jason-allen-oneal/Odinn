# Beta 4 UAT findings proof log

Branch: `fix/beta4-uat-findings`

Date: 2026-07-21

All local commands ran with one-CPU cgroup limits, bounded task counts, and a
maximum 2 GB cgroup memory limit. Node.js old space was capped at 1024 MB or
less. The real Ollama verification separately capped the daemon at 6 GB,
1.5 CPUs, and 256 tasks, then restored its original runtime properties.

## Commands and observed results

```text
systemd-run --user --scope --quiet -p MemoryMax=2G -p CPUQuota=100% \
  -p TasksMax=256 env NODE_OPTIONS=--max-old-space-size=1024 \
  ODINN_BROWSER_HEADLESS=1 corepack pnpm exec node --test \
  --test-concurrency=1 \
  tests/cli.test.ts tests/installer.test.ts tests/onboarding.test.ts \
  tests/gateway.test.ts

54 tests passed; 0 failed; duration 109.4 seconds.
```

This includes direct one-shot browser execution, browser execution inside a
plan, persistent gateway browser reuse, clean profile reopen, approval gating,
uncertain-outcome lockout, and operator recovery.

The CLI lifecycle assertion allows a shared runner up to 60 seconds to launch
Chromium, then fails if the command remains alive more than 10 seconds after
producing valid JSON. This measures the profile-lock regression independently
of browser startup speed.

```text
sudo systemctl set-property --runtime ollama.service \
  MemoryMax=6G CPUQuota=150% TasksMax=256
systemd-run --user --scope --quiet -p MemoryMax=1536M \
  -p CPUQuota=100% -p TasksMax=128 \
  env NODE_OPTIONS=--max-old-space-size=1024 \
  corepack pnpm exec node apps/cli/src/cli.ts onboard --verify \
  --state /tmp/odinn-uat-v040b1.RYJ0UN/workspace/.odinn

AI connection verified with qwen3-vl:4b.
```

The model began unloaded and completed in roughly 50 seconds using the new
60-second default.

```text
systemd-run --user --scope --quiet -p MemoryMax=2G -p CPUQuota=100% \
  -p TasksMax=192 env NODE_OPTIONS=--max-old-space-size=1024 \
  ODINN_WORKSPACE_CONCURRENCY=1 corepack pnpm typecheck
systemd-run --user --scope --quiet -p MemoryMax=1536M -p CPUQuota=100% \
  -p TasksMax=128 env NODE_OPTIONS=--max-old-space-size=768 \
  ODINN_WORKSPACE_CONCURRENCY=1 corepack pnpm format:check
systemd-run --user --scope --quiet -p MemoryMax=2G -p CPUQuota=100% \
  -p TasksMax=192 env NODE_OPTIONS=--max-old-space-size=1024 \
  ODINN_WORKSPACE_CONCURRENCY=1 corepack pnpm lint

typecheck contract passed
format contract passed
repository lint passed
```

## Not tested in this proof pass

- Windows installation and rollback.
- Live cloud OAuth and API-key providers.
- Multi-day daily-use behavior.
- Direct console clicking through the OpenClaw controller, which correctly
  blocks loopback/private navigation; authenticated console APIs and browser
  recovery were tested directly.

The complete artifact-level Linux and macOS acceptance record is in
`docs/uat/v0.4.0-beta.1.md`.
