# Odinn Counterfactual

Counterfactual branches copy a workspace into separate sibling worktrees and create independent run records, ledger relationships, and candidate plans. The source workspace is not modified by branch creation.

```bash
odinn config experimental enable counterfactual
odinn counterfactual run --source-run <run-id> --from <step-id> --plan-file plan-a.json --plan-file plan-b.json
odinn counterfactual compare <group-id>
odinn counterfactual select <group-id> --run <candidate-run-id>
```

This first slice provides isolation and comparison records. It does not execute irreversible external actions on behalf of a candidate.
