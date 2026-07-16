# Odinn Forge Counterfactual

Counterfactual branches recursively copy a workspace into separate candidate directories under `.odinn-worktrees/<group>/<plan>` and create independent run records, ledger relationships, and candidate plans. They are filesystem copies, not Git worktrees or operating-system sandboxes. The source workspace is not modified by branch creation.

```bash
odinn config experimental enable counterfactual
odinn counterfactual run --source-run <run-id> --from <step-id> --plan-file plan-a.json --plan-file plan-b.json --execute
odinn counterfactual compare <group-id>
odinn counterfactual select <group-id> --run <candidate-run-id> --apply
```

An executable plan contains a bounded `tasks` array of ordinary Odinn Forge task objects and may include a Proof contract. Read-only tasks may set `readOnly: true`; Ódinn Forge then issues a one-use, candidate-bound read capability. Mutating tasks must carry an explicitly approved capability token. `--execute` runs each candidate independently through the normal audited tool boundary, then runs the candidate contract when present. Plans without `--execute` remain dry-run branch creation only. Selection is also a dry-run unless `--apply` is supplied; applying replaces only files outside `.git`, `.odinn`, and `.odinn-worktrees`, with a temporary source backup for recovery. Irreversible external actions remain approval-gated and are not silently made safe by branching.
