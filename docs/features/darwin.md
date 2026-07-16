# Odinn Forge Darwin

Darwin records measured outcomes in SQLite and uses a transparent weighted score. Verified success and policy compliance dominate speed and cost; a small-observation uncertainty penalty prevents a single lucky run from becoming gospel.

```bash
odinn config experimental enable darwin
odinn routing observe --run <run-id> --provider openai --model gpt --task-class bug-fix --verified true --duration-ms 1200
odinn routing stats --task-class bug-fix
odinn routing choose --task-class bug-fix
```

Prompts and secrets are not stored in observation rows.
