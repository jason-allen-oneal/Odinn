# Odinn Capsule

Capsules are ZIP-compatible, redacted run bundles containing the manifest, run record, events, environment metadata, verification results, snapshot index, referenced content-addressed artifacts, optional contract/policy, and checksums. Secrets are represented only as redaction categories; credentials are not exported.

```bash
odinn config experimental enable capsules
odinn capsule export <run-id> --output run.odinn
odinn capsule verify run.odinn
odinn capsule replay run.odinn --mode verification-only
odinn capsule replay run.odinn --mode tool-mocked
```

Extraction rejects absolute paths and parent traversal. Verification checks the internal content hashes when moved elsewhere. Verification-only replay validates the capsule and reports whether an acceptance contract is included. Tool-mocked replay creates a new durable replay run and records every captured model/tool boundary without executing external tools. Full replay remains fail-closed until every adapter declares a replay-safe contract; browser, remote mutation, and nondeterministic model execution are not silently replayed.

The gateway restricts capsule paths to its `.odinn/capsules` store. Direct runtime and CLI exports must remain inside the configured workspace or `.odinn/capsules`.
