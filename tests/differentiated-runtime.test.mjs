import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDifferentiatedRuntime, OdinnRuntimeError, ProofVerifier } from "../packages/kernel/src/index.mjs";

const flags = { proof: true, rewind: true, sentinel: true, capsules: true, darwin: true, capabilities: true, counterfactual: true };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-diff-"));
  const state = join(root, ".odinn");
  const workspace = join(root, "workspace");
  await writeFile(join(root, "seed.txt"), "before\n");
  return { root, state, workspace, runtime: createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags: flags }) };
}

test("Sentinel blocks a denied command before execution and records the decision", async () => {
  const { runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-sentinel", objective: "policy test" });
    assert.throws(() => runtime.sentinel.evaluate({ runId: "run-sentinel", toolName: "process.exec", input: { command: "terraform apply" }, policy: { version: 1, invariants: [{ id: "deny", type: "command.deny-pattern", values: ["terraform apply"], enforcement: "block" }] } }), (error) => error instanceof OdinnRuntimeError && error.code === "POLICY_VIOLATION");
    assert.equal(runtime.ledger.database.db.prepare("SELECT COUNT(*) count FROM policy_evaluations WHERE run_id = ?").get("run-sentinel").count, 1);
  } finally { runtime.ledger.close(); }
});

test("capabilities are scoped and consumed exactly once", async () => {
  const { runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-cap", objective: "capability test" });
    const issued = runtime.capabilities.issue({ runId: "run-cap", stepId: "step-1", toolName: "github.create", scopes: ["create"], resourceConstraints: { repository: "owner/repo" } });
    runtime.capabilities.consume(issued.token, { runId: "run-cap", toolName: "github.create", resource: { repository: "owner/repo" } });
    assert.throws(() => runtime.capabilities.consume(issued.token, { runId: "run-cap", toolName: "github.create", resource: { repository: "owner/repo" } }), /use limit/);
    assert.throws(() => runtime.capabilities.consume(issued.token, { runId: "run-other", toolName: "github.create", resource: { repository: "owner/repo" } }), /not valid/);
  } finally { runtime.ledger.close(); }
});

test("snapshots restore a modified file and remove an agent-created file", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-rewind", objective: "rewind test" });
    const snapshot = runtime.snapshots.create({ runId: "run-rewind", stepId: "step-1", paths: ["seed.txt", "created.txt"], workspaceRoot: root });
    await writeFile(join(root, "seed.txt"), "after\n"); await writeFile(join(root, "created.txt"), "new\n");
    const preview = runtime.snapshots.restore(snapshot.snapshotId);
    assert.equal(preview.applied, false); assert.equal(preview.actions.length, 2);
    runtime.snapshots.restore(snapshot.snapshotId, { apply: true });
    assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(join(root, "created.txt"), "utf8"), { code: "ENOENT" });
  } finally { runtime.ledger.close(); }
});

test("Proof persists evidence and refuses model claims without passing assertions", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-proof", objective: "proof test" });
    const proof = await new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: root }).verify({ schemaVersion: 1, id: "contract-proof", runId: "run-proof", assertions: [{ id: "file", type: "file", path: "seed.txt", expect: { exists: true, content: { contains: "before" } } }] });
    assert.equal(proof.status, "passed");
    assert.equal(runtime.ledger.getRun("run-proof").status, "verified");
    assert.equal(runtime.ledger.database.db.prepare("SELECT COUNT(*) count FROM assertion_results WHERE run_id = ?").get("run-proof").count, 1);
  } finally { runtime.ledger.close(); }
});

test("capsules verify their checksums and detect tampering", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-capsule", objective: "capsule test" });
    const output = join(root, "run.odinn");
    await runtime.capsules.export("run-capsule", { output });
    assert.equal((await runtime.capsules.verify(output)).valid, true);
    const bytes = await readFile(output); bytes[bytes.length - 1] ^= 1; await writeFile(output, bytes);
    await assert.rejects(runtime.capsules.verify(output), (error) => error.code === "CAPSULE_TAMPERED");
  } finally { runtime.ledger.close(); }
});

test("Darwin chooses a model using observed verification outcomes", async () => {
  const { runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-darwin-a", objective: "routing" }); runtime.ledger.ensureRun({ runId: "run-darwin-b", objective: "routing" });
    runtime.darwin.observe({ runId: "run-darwin-a", providerId: "p", modelId: "good", taskClass: "bug-fix", verified: true, durationMs: 10, toolCalls: 1 });
    runtime.darwin.observe({ runId: "run-darwin-b", providerId: "p", modelId: "bad", taskClass: "bug-fix", verified: false, durationMs: 1, toolCalls: 1, toolErrors: 1 });
    assert.equal(runtime.darwin.choose("bug-fix").model, "p:good");
  } finally { runtime.ledger.close(); }
});

test("counterfactual candidates receive isolated workspaces", async () => {
  const { root, runtime } = await fixture();
  try {
    runtime.ledger.ensureRun({ runId: "run-source", objective: "branch" });
    const group = await runtime.counterfactual.create({ sourceRunId: "run-source", sourceStepId: "step-1", workspaceRoot: root, plans: [{ id: "a", title: "A", summary: "first" }, { id: "b", title: "B", summary: "second" }] });
    assert.equal(group.candidates.length, 2); assert.notEqual(group.candidates[0].workspaceRoot, group.candidates[1].workspaceRoot);
    assert.equal(runtime.counterfactual.compare(group.groupId).candidates.length, 2);
    await writeFile(join(group.candidates[0].workspaceRoot, "only-a.txt"), "a\n");
    await assert.rejects(readFile(join(group.candidates[1].workspaceRoot, "only-a.txt"), "utf8"), { code: "ENOENT" });
  } finally { runtime.ledger.close(); }
});
