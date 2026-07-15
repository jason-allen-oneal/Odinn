# Odinn Capsule

Capsules are ZIP-compatible, redacted run bundles containing the manifest, run record, events, optional contract/policy, and checksums. Secrets are represented only as redaction categories; credentials are not exported.

```bash
odinn config experimental enable capsules
odinn capsule export <run-id> --output run.odinn
odinn capsule verify run.odinn
odinn capsule replay run.odinn --mode verification-only
```

Extraction rejects absolute paths and parent traversal. Verification checks both the archive digest when the capsule is local to its source database and the internal content hashes when moved elsewhere.
