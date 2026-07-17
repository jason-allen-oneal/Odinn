import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "apps/cli/src/cli.ts");

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "odinn-experimental-cli-"));
  const workspace = join(base, "workspace");
  const state = join(base, "state");
  await mkdir(workspace);
  await writeFile(join(workspace, "seed.txt"), "experimental CLI evidence\n");
  return { base, workspace, state };
}

function invoke(workspace: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: workspace }
  });
}

function expectOk(result: ReturnType<typeof invoke>) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

test("experimental CLI has a discoverable disabled-by-default control plane", async () => {
  const { workspace, state } = await fixture();
  const help = invoke(workspace, ["experimental", "help"]);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  for (const feature of ["proof", "sentinel", "capabilities", "rewind", "capsules", "counterfactual", "darwin", "self-improvement"]) {
    assert.match(help.stdout, new RegExp(feature));
  }
  assert.match(help.stdout, /disabled by default/);

  const initial = expectOk(invoke(workspace, ["experimental", "status", "--state", state]));
  assert.equal(initial.configured, false);
  assert.equal(initial.disabledByDefault, true);
  assert.equal(initial.features.length, 8);
  assert.ok(initial.features.every((feature: any) => feature.enabled === false));
  assert.equal(initial.features.find((feature: any) => feature.id === "self-improvement").mode, "propose");

  const enabled = expectOk(invoke(workspace, ["experimental", "enable", "proof", "--state", state]));
  assert.equal(enabled.feature, "proof");
  assert.equal(enabled.enabled, true);
  const proofStatus = expectOk(invoke(workspace, ["experimental", "proof", "status", "--state", state]));
  assert.equal(proofStatus.features[0].enabled, true);
  assert.equal(proofStatus.features[0].configKey, "experimental.proof");

  const improvement = expectOk(invoke(workspace, ["experimental", "enable", "self-improvement", "--state", state]));
  assert.equal(improvement.selfImprovement.enabled, true);
  assert.equal(improvement.selfImprovement.mode, "propose");

  expectOk(invoke(workspace, ["experimental", "disable", "proof", "--state", state]));
  const persisted = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(persisted.experimental.proof, false);
  assert.equal(persisted.selfImprovement.enabled, true);
});

test("experimental CLI routes every system to its real runtime implementation", async () => {
  const { workspace, state } = await fixture();
  expectOk(invoke(workspace, ["init", "--state", state]));

  const proposal = expectOk(invoke(workspace, [
    "experimental", "self-improvement", "propose",
    "--title", "Keep the signal clean",
    "--rationale", "Prove that the review-gated proposal path is wired",
    "--state", state
  ]));
  const proposals = expectOk(invoke(workspace, ["experimental", "self-improvement", "list", "--state", state]));
  assert.equal(proposals.improvements[0].id, proposal.id);

  const run = expectOk(invoke(workspace, [
    "run", "--tool", "text.echo", "--input-json", "{\"text\":\"experimental source run\"}", "--state", state
  ]));
  const contractPath = join(workspace, "proof-contract.json");
  await writeFile(contractPath, `${JSON.stringify({
    schemaVersion: 1,
    id: "experimental-cli-proof",
    runId: run.id,
    assertions: [{ id: "seed-exists", type: "file", path: "seed.txt", expect: { exists: true, content: { contains: "evidence" } } }]
  })}\n`);
  const policyPath = join(workspace, "sentinel-policy.json");
  await writeFile(policyPath, `${JSON.stringify({
    version: 1,
    invariants: [{ id: "deny-deploy", type: "command.deny-pattern", values: ["terraform apply"], enforcement: "block" }]
  })}\n`);

  assert.equal(expectOk(invoke(workspace, ["experimental", "proof", "contract", "validate", contractPath])).valid, true);
  assert.equal(expectOk(invoke(workspace, ["experimental", "sentinel", "validate", policyPath])).valid, true);
  const disabledProof = invoke(workspace, ["experimental", "proof", "run", run.id, "--contract", contractPath, "--state", state]);
  assert.equal(disabledProof.status, 1);
  assert.match(disabledProof.stderr, /experimental\.proof is disabled/);
  const directDisabledProof = invoke(workspace, ["proof", "run", run.id, "--contract", contractPath, "--state", state]);
  assert.equal(directDisabledProof.status, 1);
  assert.match(directDisabledProof.stderr, /experimental\.proof is disabled/);

  for (const feature of ["proof", "sentinel", "capabilities", "rewind", "capsules", "counterfactual", "darwin"]) {
    const toggled = expectOk(invoke(workspace, ["experimental", "enable", feature, "--state", state]));
    assert.equal(toggled.enabled, true);
  }

  const proof = expectOk(invoke(workspace, ["experimental", "proof", "run", run.id, "--contract", contractPath, "--state", state]));
  assert.equal(proof.status, "passed");
  const sentinel = expectOk(invoke(workspace, [
    "experimental", "sentinel", "test", policyPath,
    "--tool", "text.echo", "--input-json", "{\"text\":\"safe\"}", "--state", state
  ]));
  assert.equal(sentinel.allowed, true);

  const issued = expectOk(invoke(workspace, [
    "experimental", "capabilities", "issue",
    "--run", run.id, "--step", "manual-step", "--tool", "text.echo", "--scope", "text.echo", "--state", state
  ]));
  assert.equal(issued.claims.runId, run.id);
  assert.match(issued.token, /^\[hidden/);
  const capabilities = expectOk(invoke(workspace, ["experimental", "capabilities", "list", run.id, "--state", state]));
  assert.ok(capabilities.some((capability: any) => capability.id === issued.claims.id));

  const checkpoint = expectOk(invoke(workspace, [
    "experimental", "rewind", "checkpoint", "create", run.id, "--path", "seed.txt", "--state", state
  ]));
  const preview = expectOk(invoke(workspace, ["experimental", "rewind", "restore", checkpoint.snapshotId, "--state", state]));
  assert.equal(preview.applied, false);
  assert.equal(preview.actions[0].action, "restore");

  const capsulePath = join(workspace, "source-run.odinn");
  const capsule = expectOk(invoke(workspace, [
    "experimental", "capsules", "export", run.id, "--output", capsulePath, "--state", state
  ]));
  assert.equal(capsule.path, capsulePath);
  assert.equal(expectOk(invoke(workspace, ["experimental", "capsules", "verify", capsulePath, "--state", state])).valid, true);

  const planPath = join(workspace, "counterfactual-plan.json");
  await writeFile(planPath, `${JSON.stringify({
    id: "read-seed",
    title: "Read seed safely",
    summary: "Exercise an isolated candidate and verify its evidence",
    tasks: [{ tool: "workspace.readText", readOnly: true, input: { path: "seed.txt" } }],
    contract: {
      schemaVersion: 1,
      id: "counterfactual-proof",
      assertions: [{ id: "candidate-seed", type: "file", path: "seed.txt", expect: { exists: true, content: { contains: "evidence" } } }]
    }
  })}\n`);
  const counterfactual = expectOk(invoke(workspace, [
    "experimental", "counterfactual", "run",
    "--source-run", run.id, "--from", "manual-step", "--plan-file", planPath, "--execute", "--state", state
  ]));
  assert.equal(counterfactual.candidates.length, 1);
  assert.equal(counterfactual.execution.results[0].proof.status, "passed");

  const observed = expectOk(invoke(workspace, [
    "experimental", "darwin", "observe", "--run", run.id,
    "--provider", "fixture", "--model", "verified", "--task-class", "cli-test", "--verified", "true", "--duration-ms", "10", "--state", state
  ]));
  assert.equal(observed.modelId, "verified");
  const stats = expectOk(invoke(workspace, ["experimental", "darwin", "stats", "--task-class", "cli-test", "--state", state]));
  assert.equal(stats[0].model_id, "verified");
});
