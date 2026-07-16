# Task Contract Reference

The strict Proof API currently uses:

```json
{
  "schemaVersion": 1,
  "id": "contract-id",
  "runId": "run-id",
  "assertions": [
    {"id":"tests","type":"command","command":["pnpm","test"],"expect":{"exitCode":0}},
    {"id":"marker","type":"file","path":"src/marker.txt","expect":{"exists":true}}
  ]
}
```

Command and file paths are constrained to the run workspace. `matches` accepts a bounded regular expression with `i`, `m`, `s`, and `u` flags.
