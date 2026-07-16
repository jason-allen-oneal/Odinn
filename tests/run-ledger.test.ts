import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, createRunLedger, normalizeExperimentalFlags, runTask } from "../packages/kernel/src/index.ts";

test("Phase 0 records a real tool call as a durable redacted hash chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-phase0-ledger-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root, featureFlags: { proof: true } });
  try {
    const result = await runTask({
      task: { id: "run_phase0_echo", tool: "text.echo", input: { text: "ODINN_PHASE0_OK", apiKey: "sk-do-not-persist-this" }, actor: "test" },
      auditStore: createAuditStore(join(stateDir, "audit.jsonl")),
      registry: createBuiltInRegistry({ workspaceRoot: root, stateDir }),
      runLedger: ledger
    });

    assert.equal(result.output.text, "ODINN_PHASE0_OK");
    const run = ledger.getRun("run_phase0_echo");
    assert.equal(run.status, "completed-unverified");
    assert.equal(run.featureFlags.proof, true);
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0].type, "tool-request");
    assert.equal(run.steps[0].status, "succeeded");
    assert.deepEqual(run.events.map((event: any) => event.type), ["tool-request", "policy-check", "tool-result"]);
    assert.equal(ledger.verify("run_phase0_echo").valid, true);
    assert.ok(run.steps[0].input_digest);

    const artifact = join(stateDir, "artifacts", "sha256", run.steps[0].input_digest.slice(0, 2), run.steps[0].input_digest);
    await access(artifact);
    assert.doesNotMatch(await readFile(artifact, "utf8"), /sk-do-not-persist-this/);
  } finally {
    ledger.close();
  }
});

test("Phase 0 blocks unknown tools with the most restrictive descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-phase0-blocked-"));
  const stateDir = join(root, ".odinn");
  const ledger = createRunLedger({ stateDir, workspaceRoot: root, featureFlags: normalizeExperimentalFlags({ counterfactual: true }) });
  try {
    await assert.rejects(() => runTask({
      task: { id: "run_phase0_unknown", tool: "untrusted.inject", input: { token: "secret" }, actor: "test" },
      auditStore: createAuditStore(join(stateDir, "audit.jsonl")),
      registry: createBuiltInRegistry({ workspaceRoot: root, stateDir }),
      runLedger: ledger
    }), /unknown tool|capability is not allowed/);
    const run = ledger.getRun("run_phase0_unknown");
    assert.equal(run.steps[0].status, "blocked");
    assert.equal(run.events.at(-1).type, "tool-result");
    assert.equal(ledger.verify("run_phase0_unknown").valid, true);
  } finally {
    ledger.close();
  }
});
