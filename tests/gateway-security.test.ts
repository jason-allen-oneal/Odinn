import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { createApprovalStore } from "../packages/kernel/src/index.ts";

test("gateway control surfaces require bootstrap authentication and reject cross-origin mutations", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-security-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/config`)).status, 401);
    const bootstrap = await fetch(`${base}/`);
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 200);
    const configResponse = await fetch(`${base}/config`, { headers: { cookie } });
    assert.equal(configResponse.status, 200);
    const currentConfig = await configResponse.json();

    const missingConfigOrigin = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ config: currentConfig.config, fingerprint: currentConfig.fingerprint })
    });
    assert.equal(missingConfigOrigin.status, 403);

    const crossOriginConfig = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ config: currentConfig.config, fingerprint: currentConfig.fingerprint })
    });
    assert.equal(crossOriginConfig.status, 403);

    const missingCookieOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "run_missing_cookie_origin", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(missingCookieOrigin.status, 403);

    const crossPort = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: `http://127.0.0.1:${server.address().port + 1}` },
      body: JSON.stringify({ id: "run_cross_port", tool: "text.echo", input: { text: "blocked" } })
    });
    assert.equal(crossPort.status, 403);

    const sameOrigin = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ id: "run_same_origin", tool: "text.echo", input: { text: "allowed" } })
    });
    assert.equal(sameOrigin.status, 200);

    const token = decodeURIComponent(cookie.split("=").slice(1).join("="));
    const bearer = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "run_bearer_no_origin", tool: "text.echo", input: { text: "allowed" } })
    });
    assert.equal(bearer.status, 200);

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
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
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
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  try {
    await stat(join(stateDir, "config.json"));
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDir, "config.json"))).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("gateway rejects an audit path that escapes state before startup", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-unsafe-audit-"));
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({ version: 1, auditLog: "../other-tenant/audit.jsonl" })}\n`, { mode: 0o600 });
  await assert.rejects(
    () => createGatewayServer({ stateDir, workspaceRoot: stateDir }),
    /auditLog must be audit\.jsonl or an audit-\*\.jsonl filename/
  );
});

test("configuration reads refuse symbolic-link swaps", { skip: process.platform === "win32" }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-config-symlink-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "odinn-config-outside-"));
  const outside = join(outsideDir, "outside.json");
  const outsideContents = '{"private":"must-not-be-returned"}\n';
  await writeFile(outside, outsideContents, { mode: 0o644 });
  const outsideMode = (await stat(outside)).mode & 0o777;
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bootstrap = await fetch(`${base}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    await rename(join(stateDir, "config.json"), join(stateDir, "config.original.json"));
    await symlink(outside, join(stateDir, "config.json"));
    const response = await fetch(`${base}/config`, { headers: { cookie } });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /symbolic link/);
    assert.equal(await readFile(outside, "utf8"), outsideContents);
    assert.equal((await stat(outside)).mode & 0o777, outsideMode);
  } finally {
    await new Promise((resolve: any, reject: any) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});

function requestRaw({ port, path, headers = {} }: any) {
  return new Promise((resolve: any, reject: any) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response: any) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode }));
    });
    request.on("error", reject);
    request.end();
  });
}
