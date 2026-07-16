# Ódinn self-improvement

Ódinn has a review-gated evidence loop, not autonomous self-modifying code.

The `improve.learn` tool reads bounded audit history, groups repeated failures or policy blocks, and creates a deduplicated improvement proposal with run IDs as evidence:

```bash
pnpm odinn improve learn --limit 1000
pnpm odinn improvements
```

The gateway exposes the same operation at `POST /improvements/learn`, and the console's Skill Workshop page presents it as **Analyze activity**. Proposals can be approved, rejected, or marked applied through the existing human decision path.

The loop does not write source files, alter policy, install or enable skills, change provider routing, or approve its own proposal. Any future autonomous optimization must remain behind a separate experimental flag and preserve an auditable approval boundary.
