# Odinn Forge Capsule

Capsules are ZIP-compatible, redacted run bundles containing the manifest, run record, events, environment metadata, verification results, snapshot index, referenced content-addressed artifacts, optional contract/policy, and checksums. Secrets are represented only as redaction categories; credentials are not exported.

```bash
odinn config experimental enable capsules
odinn capsule export <run-id> --output run.odinn
odinn capsule verify run.odinn
odinn capsule replay run.odinn --mode verification-only
odinn capsule replay run.odinn --mode tool-mocked
odinn capsule replay run.odinn --mode full --workspace ./disposable --approve-external
```

Extraction rejects absolute paths and parent traversal. Verification checks internal content hashes. Verification-only replay validates the capsule. Tool-mocked replay records captured boundaries without executing tools. Full replay re-executes recorded requests only through an audited executor in a disposable workspace. Redacted inputs fail closed. Network, credential, irreversible, and external-state effects require `--approve-external`; approval does not make a remote action deterministic or reversible.

The gateway restricts capsule paths to its `.odinn/capsules` store. Direct runtime and CLI exports must remain inside the configured workspace or `.odinn/capsules`.
