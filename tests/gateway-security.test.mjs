import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { createApprovalStore } from "../packages/kernel/src/index.ts";

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

    const hostileBootstrap = await requestRaw({ port: server.address().port, path: "/", headers: { host: "attacker.example" } });
    assert.equal(hostileBootstrap.status, 421);
    const hostileOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://attacker.example", host: `127.0.0.1:${server.address().port}` },
      body: JSON.stringify({ id: "run_hostile_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(hostileOrigin.status, 403);
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

test("gateway state files and directory are owner-only", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-permissions-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await stat(join(stateDir, "config.json"));
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDir, "config.json"))).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function requestRaw({ port, path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode }));
    });
    request.on("error", reject);
    request.end();
  });
}
