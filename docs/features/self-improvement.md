# Ódinn Forge self-improvement

Ódinn Forge includes a configurable autonomous evidence loop. It observes signed audit history, groups repeated failures, creates deduplicated proposals, and can apply allowlisted runtime tuning without waiting for a human decision.

The default remains review-gated:

```bash
pnpm odinn config self-improvement show
pnpm odinn config self-improvement set --enabled true --mode propose
```

Enable autonomous application explicitly:

```bash
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

When the gateway is running in `auto` mode it performs a bounded analysis cycle on the configured interval. `improve.learn` can also run a cycle immediately. Applied changes capture the prior configuration under `.odinn/improvements/` and can be rolled back:

```bash
pnpm odinn improve learn --limit 1000
pnpm odinn improve rollback --improvement <id>
```

Autonomy is deliberately narrow. The controller may tune only explicitly allowlisted reliability settings. It cannot disable approvals, expand network domains, grant capabilities, weaken Sentinel, install extensions, change credentials, edit source code, or approve arbitrary model-generated actions. Unknown recommendations remain proposals. Every application, failure, and rollback is persisted in the record and audit stores.
