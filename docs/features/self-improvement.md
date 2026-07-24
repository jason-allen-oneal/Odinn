# Ódinn Forge self-improvement

Ódinn Forge includes an automatic reliability loop. It watches audit history for repeated failures, asks the configured model for a plain-language assessment, and can apply narrowly allowlisted reliability tuning without waiting for a review decision.

It runs automatically by default:

```bash
pnpm odinn config self-improvement show
pnpm odinn config self-improvement set \
  --enabled true \
  --mode auto \
  --interval-ms 300000 \
  --max-changes 1
```

Disable the loop:

```bash
pnpm odinn config self-improvement set --enabled false --mode disabled
```

When the gateway is running it performs a bounded analysis cycle on the configured interval. `improve.learn` can also run a cycle immediately. Applied changes capture the prior configuration under `.odinn/improvements/` and can be rolled back:

```bash
pnpm odinn improve learn --limit 1000
pnpm odinn improve rollback --improvement <id>
```

No embedded model is currently bundled with Ódinn, so the loop uses the configured provider. Model output can improve the title, explanation, and priority of an observation, but it cannot choose or invent a configuration change.

Autonomy is deliberately narrow. The controller may tune only explicitly allowlisted reliability settings. It cannot disable safeguards, expand network domains, grant permissions, install extensions, change credentials, edit source code, or apply arbitrary model-generated actions. Every application, failure, and rollback is persisted in the record and audit stores.
