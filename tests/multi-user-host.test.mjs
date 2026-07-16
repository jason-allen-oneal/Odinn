import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMultiUserHost, hashPassword } from "../apps/gateway/src/host.ts";

test("multi-user host authenticates and isolates each tenant gateway state", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-"));
  const aliceRoot = await mkdtemp(join(tmpdir(), "odinn-alice-"));
  const bobRoot = await mkdtemp(join(tmpdir(), "odinn-bob-"));
  const alice = await hashPassword("alice-password-long");
  const bob = await hashPassword("bob-password-longer");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({ stateDir: root, publicOrigin, users: { schemaVersion: 1, users: [
    { id: "alice", workspaceRoot: aliceRoot, salt: alice.salt, passwordHash: alice.hash },
    { id: "bob", workspaceRoot: bobRoot, salt: bob.salt, passwordHash: bob.hash }
  ] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "alice", password: "alice-password-long" }) })).status, 403);
    const aliceLogin = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "alice-password-long" }) });
    assert.equal(aliceLogin.status, 200);
    const aliceCookie = aliceLogin.headers.get("set-cookie").split(";")[0];
    const aliceStatus = await (await fetch(`${base}/status`, { headers: { cookie: aliceCookie } })).json();
    assert.equal(aliceStatus.workspaceRoot, aliceRoot);
    const bobLogin = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "bob", password: "bob-password-longer" }) });
    const bobCookie = bobLogin.headers.get("set-cookie").split(";")[0];
    const bobStatus = await (await fetch(`${base}/status`, { headers: { cookie: bobCookie } })).json();
    assert.equal(bobStatus.workspaceRoot, bobRoot);
    assert.notEqual(aliceStatus.state, bobStatus.state);
    assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: aliceCookie, origin: publicOrigin } })).status, 200);
    assert.equal((await fetch(`${base}/status`, { headers: { cookie: aliceCookie } })).status, 401);
  } finally { await new Promise((resolve) => server.close(() => resolve())); }
});

test("multi-user host rate limits repeated authentication failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-limit-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-limit-user-"));
  const password = await hashPassword("correct-password-long");
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({
    stateDir: root,
    publicOrigin,
    loginLimits: { maximumAttempts: 2, windowMs: 60_000 },
    users: { schemaVersion: 1, users: [{ id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash }] }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (value) => fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: value }) });
  try {
    assert.equal((await login("wrong-password-long")).status, 401);
    assert.equal((await login("still-wrong-password")).status, 401);
    const blocked = await login("correct-password-long");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  } finally { await new Promise((resolve) => server.close(() => resolve())); }
});
