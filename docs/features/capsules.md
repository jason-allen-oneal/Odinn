# Odinn Capsule

Capsules are ZIP-compatible, redacted run bundles containing the manifest, run record, events, environment metadata, verification results, snapshot index, referenced content-addressed artifacts, optional contract/policy, and checksums. Secrets are represented only as redaction categories; credentials are not exported.

```bash
odinn config experimental enable capsules
odinn capsule export <run-id> --output run.odinn
odinn capsule verify run.odinn
odinn capsule replay run.odinn --mode verification-only
```

Extraction rejects absolute paths and parent traversal. Verification checks the internal content hashes when moved elsewhere. Verification-only replay validates the capsule and loads its recorded boundaries without executing model calls or external tools; full replay is intentionally not implemented yet.

The gateway restricts capsule paths to its `.odinn/capsules` store. Direct runtime and CLI exports must remain inside the configured workspace or `.odinn/capsules`.
