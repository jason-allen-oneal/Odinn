import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
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
  } finally { await new Promise((resolve: any) => server.close(() => resolve())); }
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
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (value: any) => fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: value }) });
  try {
    assert.equal((await login("wrong-password-long")).status, 401);
    assert.equal((await login("still-wrong-password")).status, 401);
    const blocked = await login("correct-password-long");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  } finally { await new Promise((resolve: any) => server.close(() => resolve())); }
});

test("multi-user host preserves authentication throttles across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-limit-restart-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-limit-restart-user-"));
  const password = await hashPassword("correct-password-long");
  const publicOrigin = "https://odinn.test";
  const options = {
    stateDir: root,
    publicOrigin,
    loginLimits: { maximumAttempts: 1, windowMs: 60_000 },
    users: { schemaVersion: 1, users: [{ id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash }] }
  };
  const first = await createMultiUserHost(options);
  await new Promise((resolve: any) => first.listen(0, "127.0.0.1", resolve));
  const firstBase = `http://127.0.0.1:${first.address().port}`;
  assert.equal((await fetch(`${firstBase}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "wrong-password-long" }) })).status, 401);
  await new Promise((resolve: any) => first.close(() => resolve()));

  const second = await createMultiUserHost(options);
  await new Promise((resolve: any) => second.listen(0, "127.0.0.1", resolve));
  const secondBase = `http://127.0.0.1:${second.address().port}`;
  try {
    assert.equal((await fetch(`${secondBase}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "correct-password-long" }) })).status, 429);
  } finally {
    await new Promise((resolve: any) => second.close(() => resolve()));
  }
});

test("multi-user host rejects overlapping tenant workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-overlap-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-overlap-workspace-"));
  const nested = join(workspace, "nested");
  await mkdir(nested);
  const alice = await hashPassword("alice-password-long");
  const bob = await hashPassword("bob-password-longer");
  await assert.rejects(() => createMultiUserHost({ stateDir: root, users: { schemaVersion: 1, users: [
    { id: "alice", workspaceRoot: workspace, salt: alice.salt, passwordHash: alice.hash },
    { id: "bob", workspaceRoot: nested, salt: bob.salt, passwordHash: bob.hash }
  ] } }), /workspaces overlap/);
});

test("multi-user host reloads disabled users without restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-host-reload-"));
  const workspace = await mkdtemp(join(tmpdir(), "odinn-reload-workspace-"));
  const password = await hashPassword("correct-password-long");
  const record = { id: "alice", workspaceRoot: workspace, salt: password.salt, passwordHash: password.hash, disabled: false };
  await writeFile(join(root, "users.json"), JSON.stringify({ schemaVersion: 1, users: [record] }));
  const publicOrigin = "https://odinn.test";
  const server = await createMultiUserHost({ stateDir: root, publicOrigin });
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: publicOrigin }, body: JSON.stringify({ userId: "alice", password: "correct-password-long" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 200);
    await writeFile(join(root, "users.json"), JSON.stringify({ schemaVersion: 1, users: [{ ...record, disabled: true }] }));
    assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 403);
  } finally { await new Promise((resolve: any) => server.close(() => resolve())); }
});
