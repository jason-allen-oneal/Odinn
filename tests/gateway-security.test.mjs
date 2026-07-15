import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.mjs";
import { createApprovalStore } from "../packages/kernel/src/index.mjs";

test("gateway control surfaces require bootstrap authentication and reject cross-origin mutations", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-security-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    const bootstrap = await fetch(`${base}/`);
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 200);

    const rejected = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ id: "run_cross_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("approval records survive restart and claim idempotently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-approval-restart-"));
  const path = join(stateDir, "approvals.json");
  const first = createApprovalStore({ path });
  const id = first.create({ tool: "browser.click", input: { confirmed: true }, summary: "Click" });
  const restarted = createApprovalStore({ path });
  const claimed = restarted.claim(id);
  assert.equal(claimed.status, "approved");
  assert.equal(claimed.runId, `approval:${id}`);
  const secondClaim = createApprovalStore({ path }).claim(id);
  assert.equal(secondClaim.status, "approved");
  assert.equal(secondClaim.runId, claimed.runId);
  assert.deepEqual(createApprovalStore({ path }).list(), []);
});
