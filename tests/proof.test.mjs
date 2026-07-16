import assert from "node:assert/strict";
import { access, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createRunLedger } from "../packages/kernel/src/run-ledger.ts";
import {
  PROOF_CONTRACT_SCHEMA_VERSION,
  ProofVerifier,
  validateProofContract,
  validateVerificationContract,
  verifyContract,
  verifyProof
} from "../packages/kernel/src/proof.mjs";

async function fixture(runId = "run_proof_test") {
  const root = await mkdtemp(join(tmpdir(), "odinn-proof-"));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root, featureFlags: { proof: true } });
  ledger.ensureRun({ runId, objective: "verify the proof contract" });
  return { root, ledger, runId };
}

function contract(runId, assertions, id = "proof_contract") {
  return { schemaVersion: 1, id, runId, assertions };
}

test("Proof contracts are strictly validated and normalized", () => {
  const normalized = validateVerificationContract(contract("run_valid", [{
    id: "command_valid",
    type: "command",
    command: [process.execPath, "-e", "process.exit(0)", ""],
    expect: { stdout: { equals: "" } }
  }]));

  assert.equal(PROOF_CONTRACT_SCHEMA_VERSION, 1);
  assert.equal(normalized.assertions[0].timeoutMs, 30_000);
  assert.equal(normalized.assertions[0].expect.exitCode, 0);
  assert.equal(normalized.assertions[0].command[3], "");
  assert.equal(validateProofContract, validateVerificationContract);
  assert.equal(verifyProof, verifyContract);

  assert.throws(() => validateVerificationContract({ ...contract("run_bad", []), extra: true }), /unknown field: extra/);
  assert.throws(() => validateVerificationContract(contract("run_bad", [{
    id: "command_bad",
    type: "command",
    command: "node --version",
    expect: { exitCode: 0 }
  }])), /argument array/);
  assert.throws(() => validateVerificationContract(contract("run_bad", [{
    id: "file_bad",
    type: "file",
    path: "result.txt",
    expect: { exists: false, content: { contains: "impossible" } }
  }])), /cannot be used when exists is false/);
  assert.throws(() => validateVerificationContract(contract("run_bad", [
    { id: "duplicate", type: "file", path: "one", expect: { exists: false } },
    { id: "duplicate", type: "file", path: "two", expect: { exists: false } }
  ])), /assertion id must be unique/);
  assert.throws(() => validateVerificationContract(contract("run_bad", [{
    id: "matcher_bad",
    type: "file",
    path: "result.txt",
    expect: { exists: true, content: { equals: "one", contains: "two" } }
  }])), /exactly one/);
});

test("Proof verifies command exit/output and file assertions without invoking a shell", async () => {
  const { root, ledger, runId } = await fixture("run_proof_pass");
  await writeFile(join(root, "result.txt"), "ODINN_PROOF_OK\n", "utf8");
  const injected = join(root, "injected.txt");
  try {
    const result = await verifyContract(contract(runId, [
      {
        id: "command_output",
        type: "command",
        command: [process.execPath, "-e", "process.stdout.write('COMMAND_OK'); process.stderr.write('notice')"],
        expect: { exitCode: 0, stdout: { equals: "COMMAND_OK" }, stderr: { matches: "^NOTICE$", flags: "i" } }
      },
      {
        id: "argument_literal",
        type: "command",
        command: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "literal; touch injected.txt"],
        expect: { exitCode: 0, stdout: { equals: "literal; touch injected.txt" } }
      },
      {
        id: "file_content",
        type: "file",
        path: "result.txt",
        expect: { exists: true, content: { contains: "PROOF_OK" } }
      },
      {
        id: "file_absent",
        type: "file",
        path: "not-created.txt",
        expect: { exists: false }
      }
    ], "proof_pass"), { runLedger: ledger, allowedRoot: root });

    assert.equal(result.status, "passed");
    assert.equal(result.passed, true);
    assert.equal(result.assertions.length, 4);
    assert.ok(result.assertions.every((assertion) => assertion.passed));
    await assert.rejects(access(injected), /ENOENT/);

    const persisted = ledger.database.db.prepare("SELECT * FROM verification_contracts WHERE id = ?").get("proof_pass");
    assert.equal(persisted.run_id, runId);
    assert.equal(persisted.version, 1);
    assert.equal(JSON.parse(persisted.contract_json).id, "proof_pass");
    const contractDigest = ledger.getRun(runId).events.find((event) => event.type === "verification-started").payload.contractDigest;
    assert.match(contractDigest, /^[a-f0-9]{64}$/);
    assert.equal(ledger.database.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE digest = ?").get(contractDigest).count, 1);
    const rows = ledger.database.db.prepare("SELECT * FROM assertion_results WHERE contract_id = ?").all("proof_pass")
      .sort((left, right) => JSON.parse(left.result_json).sequence - JSON.parse(right.result_json).sequence);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.status), ["passed", "passed", "passed", "passed"]);
    assert.equal(JSON.parse(rows[0].evidence_artifact_ids_json).length, 2);
    assert.ok(JSON.parse(rows[0].evidence_artifact_ids_json).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
    assert.equal(ledger.getRun(runId).status, "verified");
    assert.deepEqual(ledger.getRun(runId).events.slice(-6).map((event) => event.type), [
      "verification-started",
      "assertion-result",
      "assertion-result",
      "assertion-result",
      "assertion-result",
      "verification-completed"
    ]);
  } finally {
    ledger.close();
  }
});

test("Proof verifies HTTP and git assertions through bounded real operations", async () => {
  const { root, ledger, runId } = await fixture("run_proof_http_git");
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ODINN_HTTP_OK\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const normalized = validateVerificationContract(contract(runId, [
      { id: "http", type: "http", url: `http://127.0.0.1:${port}/health`, expect: { status: 200, body: { contains: "HTTP_OK" } } },
      { id: "git", type: "git", cwd: ".", expect: { clean: false } }
    ], "proof_http_git"));
    assert.equal(normalized.assertions[0].method, "GET");
    assert.throws(() => validateVerificationContract(contract(runId, [{ id: "unsafe", type: "http", url: "http://user:pass@example.com/", expect: { status: 200 } }])), /without credentials/);
    const result = await verifyContract(normalized, { runLedger: ledger, allowedRoot: root });
    assert.equal(result.status, "failed");
    assert.equal(result.assertions[0].status, "passed");
    assert.equal(result.assertions[1].status, "failed");
    const external = await verifyContract(contract(runId, [{ id: "external", type: "http", url: "https://example.com/", expect: { status: 200 } }], "proof_external"), { runLedger: ledger, allowedRoot: root });
    assert.equal(external.assertions[0].passed, false);
    assert.match(external.assertions[0].message, /external HTTP verification is disabled/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  }
});

test("Proof persists every failed assertion and marks the run failed", async () => {
  const { root, ledger, runId } = await fixture("run_proof_fail");
  try {
    const verifier = new ProofVerifier({ runLedger: ledger, allowedRoot: root });
    const result = await verifier.verify(contract(runId, [
      {
        id: "wrong_exit",
        type: "command",
        command: [process.execPath, "-e", "process.stdout.write('wrong'); process.exit(3)"],
        expect: { exitCode: 0, stdout: { contains: "right" } }
      },
      {
        id: "missing_file",
        type: "file",
        path: "missing.txt",
        expect: { exists: true }
      }
    ], "proof_fail"));

    assert.equal(result.status, "failed");
    assert.equal(result.passed, false);
    assert.match(result.assertions[0].message, /expected exit code 0, received 3/);
    assert.match(result.assertions[0].message, /stdout did not match/);
    assert.match(result.assertions[1].message, /expected file to exist/);
    const rows = ledger.database.db.prepare("SELECT status, result_json FROM assertion_results WHERE contract_id = ?").all("proof_fail")
      .sort((left, right) => JSON.parse(left.result_json).sequence - JSON.parse(right.result_json).sequence);
    assert.deepEqual(rows.map((row) => row.status), ["failed", "failed"]);
    assert.equal(JSON.parse(rows[0].result_json).actual.exitCode, 3);
    assert.equal(ledger.getRun(runId).status, "failed");
  } finally {
    ledger.close();
  }
});

test("File assertions cannot escape the allowed root lexically or through symlinks", async (context) => {
  if (process.platform === "win32") return context.skip("symlink creation is not reliably available to unprivileged Windows CI");
  const { root, ledger, runId } = await fixture("run_proof_confined");
  const outside = join(dirname(root), `${runId}-outside.txt`);
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, join(root, "outside-link.txt"));
  try {
    const result = await verifyContract(contract(runId, [
      { id: "lexical_escape", type: "file", path: outside, expect: { exists: true } },
      { id: "symlink_escape", type: "file", path: "outside-link.txt", expect: { exists: true } }
    ], "proof_confined"), { runLedger: ledger, allowedRoot: root });

    assert.equal(result.passed, false);
    assert.match(result.assertions[0].message, /escapes allowed root/);
    assert.match(result.assertions[1].message, /symbolic link/);
    assert.equal(ledger.database.db.prepare("SELECT COUNT(*) AS count FROM assertion_results WHERE contract_id = ?").get("proof_confined").count, 2);
  } finally {
    ledger.close();
  }
});

test("Proof rejects unknown runs and immutable contract id reuse", async () => {
  const { root, ledger, runId } = await fixture("run_proof_identity");
  try {
    await assert.rejects(
      verifyContract(contract("run_missing", [{ id: "absent", type: "file", path: "none", expect: { exists: false } }], "proof_unknown"), { runLedger: ledger }),
      /run not found/
    );
    const value = contract(runId, [{ id: "absent", type: "file", path: "none", expect: { exists: false } }], "proof_immutable");
    assert.equal((await verifyContract(value, { runLedger: ledger, allowedRoot: root })).passed, true);
    await assert.rejects(verifyContract(value, { runLedger: ledger, allowedRoot: root }), /already exists/);
  } finally {
    ledger.close();
  }
});

test("Proof remains disabled unless the run ledger enables the experimental feature", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-proof-disabled-"));
  const ledger = createRunLedger({ stateDir: join(root, ".odinn"), workspaceRoot: root });
  ledger.ensureRun({ runId: "run_proof_disabled", objective: "remain disabled" });
  try {
    await assert.rejects(
      verifyContract(contract("run_proof_disabled", [{ id: "absent", type: "file", path: "none", expect: { exists: false } }], "proof_disabled"), { runLedger: ledger }),
      /experimental proof feature is disabled/
    );
    assert.equal(ledger.database.db.prepare("SELECT COUNT(*) AS count FROM verification_contracts").get().count, 0);
  } finally {
    ledger.close();
  }
});
