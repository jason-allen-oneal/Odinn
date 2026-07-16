# Odinn Sentinel

Sentinel evaluates deterministic invariants before an operation. It is code, not a model opinion. A blocked decision is persisted in `policy_evaluations` and the hash-chained ledger.

The initial policy schema accepts JSON or simple YAML-shaped documents:

```json
{
  "version": 1,
  "invariants": [
    {"id":"deny-prod","type":"command.deny-pattern","values":["terraform apply"],"enforcement":"block"}
  ]
}
```

Unknown policy shapes fail closed. The current evaluator covers denied command patterns, approval-required tools, and allowed-root filesystem checks.
