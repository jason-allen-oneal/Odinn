# Odinn Forge Rewind / Norn Transactions

Rewind snapshots selected local files before mutation. Snapshots store content-addressed artifacts and original existence, mode, and digest metadata. The default CLI operation is a dry-run; `--apply` performs restoration.

```bash
odinn config experimental enable rewind
odinn checkpoint create <run-id> --path src,tests --label before-change
odinn rewind <snapshot-id>
odinn rewind <snapshot-id> --apply
```

Symlinks are rejected. External effects are not silently reversed; they require a compensation handler or remain a manual-resolution item.
