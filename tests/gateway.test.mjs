process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.mjs";

const root = new URL("..", import.meta.url).pathname;
const normalizedRoot = root.replace(/\/$/, "");

test("gateway exposes status, run execution, plans, and run summaries", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const status = await getJson(`${base}/status`);
    assert.equal(status.ok, true);
    assert.equal(status.workspaceRoot, normalizedRoot);
    assert.ok(status.tools.includes("text.echo"));
    assert.ok(status.tools.includes("web.search"));
    assert.ok(status.tools.includes("browser.open"));
    assert.ok(status.tools.includes("agent.run"));
    assert.equal(status.security.web.allowPrivateNetwork, false);
    assert.equal(status.security.browser.requireApproval, true);
    assert.ok(status.toolDetails.some((tool) => tool.name === "text.echo" && tool.capability === "text.echo"));

    const run = await postJson(`${base}/run`, { tool: "text.echo", input: { text: "ODINN_GATEWAY_OK" } });
    assert.equal(run.ok, true);
    assert.equal(run.output.text, "ODINN_GATEWAY_OK");

    const plan = await postJson(`${base}/plan`, {
      id: "plan_gateway",
      name: "gateway-plan",
      steps: [{ id: "echo", tool: "text.echo", input: { text: "ODINN_GATEWAY_PLAN_OK" } }]
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.steps[0].result.output.text, "ODINN_GATEWAY_PLAN_OK");

    const runs = await getJson(`${base}/runs`);
    assert.ok(runs.some((summary) => summary.id === run.id && summary.status === "completed"));
    assert.ok(runs.some((summary) => summary.id === "plan_gateway" && summary.status === "completed"));

    const runDetail = await getJson(`${base}/runs/${encodeURIComponent(run.id)}`);
    assert.equal(runDetail.id, run.id);
    assert.equal(runDetail.events.length, 3);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway serves the local console shell", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-console-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Odinn Console/);
    assert.match(html, /Ódinn/);
    assert.match(html, /odinn-logo\.png/);
    assert.match(html, /Run Tool/);
    assert.match(html, /Recent Runs/);
    assert.match(html, /Memory/);
    assert.match(html, /Goals/);
    assert.match(html, /Improvements/);
    assert.match(html, /modelOverride/);
    assert.match(html, /provider \+ ":" \+ message\.model/);
    assert.match(html, /chat-empty/);
    assert.match(html, /data-chat-prompt/);
    assert.match(html, /composer-footer/);
    assert.match(html, /renderMarkdown/);
    assert.match(html, /memory-tree/);
    assert.match(html, /memory-namespace/);
    assert.match(html, /Web &amp; browser/);
    assert.match(html, /web-search-run/);
    assert.match(html, /approval-gated/);
    assert.match(html, /sidebar-collapsed/);
    assert.match(html, /data-session-action="rename"/);
    assert.match(html, /data-session-action="delete"/);
    assert.match(html, /method: "PATCH"/);
    const logo = await fetch("http://127.0.0.1:" + port + "/odinn-logo.png");
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /image\/png/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway stops browser state changes for explicit approval", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-approvals-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await postJson(`${base}/run`, {
      tool: "browser.click",
      input: { selector: "button#send", tabId: "tab_test" }
    });
    assert.equal(response.ok, true);
    assert.equal(response.output.type, "approval.required");
    assert.match(response.output.summary, /Click/);
    const approvals = await getJson(`${base}/approvals`);
    assert.equal(approvals.length, 1);
    const runs = await getJson(`${base}/runs`);
    assert.equal(runs[0].status, "awaiting_approval");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway reuses one browser worker across sequential browser tasks", async (t) => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || "/usr/bin/chromium";
  try {
    await access(chromiumPath);
  } catch {
    t.skip(`Chromium not available at ${chromiumPath}`);
    return;
  }
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-browser-worker-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const tabs = await postJson(`${base}/run`, { tool: "browser.tabs", input: {} });
    assert.equal(tabs.ok, true);
    assert.ok(tabs.output.tabs.length >= 1);
    const snapshot = await postJson(`${base}/run`, {
      tool: "browser.snapshot",
      input: { tabId: tabs.output.tabs[0].id }
    });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.output.id, tabs.output.tabs[0].id);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway closes and reopens the persistent browser profile cleanly", async (t) => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || "/usr/bin/chromium";
  try {
    await access(chromiumPath);
  } catch {
    t.skip(`Chromium not available at ${chromiumPath}`);
    return;
  }
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-browser-restart-"));
  const first = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
  const firstBase = `http://127.0.0.1:${first.address().port}`;
  let stableTabId;
  try {
    const opened = await postJson(`${firstBase}/run`, { tool: "browser.open", input: { url: "https://example.com" } });
    assert.equal(opened.ok, true);
    stableTabId = opened.output.id;
  } finally {
    await new Promise((resolve, reject) => first.close((error) => error ? reject(error) : resolve()));
  }

  const second = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => second.listen(0, "127.0.0.1", resolve));
  const secondBase = `http://127.0.0.1:${second.address().port}`;
  try {
    const tabs = await postJson(`${secondBase}/run`, { tool: "browser.tabs", input: {} });
    assert.equal(tabs.ok, true);
    const snapshot = await postJson(`${secondBase}/run`, {
      tool: "browser.snapshot",
      input: { tabId: stableTabId }
    });
    assert.equal(snapshot.ok, true);
  } finally {
    await new Promise((resolve, reject) => second.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway rejects invalid and oversized JSON bodies", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-limits-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root, requestMaxBytes: 32 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const invalid = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /valid JSON/);

    const oversized = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "text.echo", input: { text: "x".repeat(200) } })
    });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /exceeds 32 bytes/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway can replay a persisted task with a new id", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-replay-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const original = await postJson(`${base}/run`, { id: "run_replay_source", tool: "text.echo", input: { text: "replay me" } });
    assert.equal(original.output.text, "replay me");
    const replay = await fetch(`${base}/runs/run_replay_source/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "run_replay_copy" })
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).output.text, "replay me");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway exposes memory remember, search, correction, and curated views", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-memory-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const stored = await postJson(`${base}/memory`, {
      kind: "project",
      subject: "memory",
      text: "Memory records must preserve provenance.",
      tags: ["memory", "provenance"],
      source: "gateway-test"
    });
    assert.equal(stored.kind, "project");

    const found = await getJson(`${base}/memory?query=provenance`);
    assert.equal(found.memories[0].id, stored.id);

    const recalled = await getJson(`${base}/memory/recall?query=preserve%20provenance`);
    assert.equal(recalled.memories[0].id, stored.id);

    const browsed = await getJson(`${base}/memory/browse?namespace=project`);
    assert.ok(browsed.namespaces.some((entry) => entry.namespace === "project/memory"));

    const corrected = await postJson(`${base}/memory/corrections`, {
      targetId: stored.id,
      text: "Memory records must preserve provenance and supersession.",
      reason: "added supersession"
    });
    assert.equal(corrected.supersedes, stored.id);

    const curated = await getJson(`${base}/memory/curated`);
    assert.equal(curated.count, 1);
    assert.equal(curated.kinds.correction[0].text, "Memory records must preserve provenance and supersession.");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway exposes sessions, goals, and improvement proposals", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-records-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const session = await postJson(`${base}/sessions`, { title: "Gateway session" });
    assert.equal(session.type, "session.created");

    const message = await postJson(`${base}/sessions/${encodeURIComponent(session.id)}/messages`, {
      role: "user",
      content: "Track this.",
      provider: "openai",
      model: "gpt-5.5"
    });
    assert.equal(message.type, "message.appended");

    const sessionDetail = await getJson(`${base}/sessions/${encodeURIComponent(session.id)}`);
    assert.equal(sessionDetail.session.messageCount, 1);
    assert.equal(sessionDetail.messages[0].content, "Track this.");
    assert.equal(sessionDetail.messages[0].provider, "openai");
    assert.equal(sessionDetail.messages[0].model, "gpt-5.5");

    const renamedResponse = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed gateway chat" })
    });
    assert.equal(renamedResponse.status, 200);
    assert.equal((await renamedResponse.json()).type, "session.renamed");
    assert.equal((await getJson(`${base}/sessions/${encodeURIComponent(session.id)}`)).session.title, "Renamed gateway chat");

    const deletedResponse = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    assert.equal(deletedResponse.status, 200);
    assert.equal((await deletedResponse.json()).type, "session.deleted");
    const sessions = await getJson(`${base}/sessions`);
    assert.equal(sessions.sessions.some((entry) => entry.id === session.id), false);

    const goal = await postJson(`${base}/goals`, { title: "Reach beta" });
    assert.equal(goal.type, "goal.created");

    const update = await postJson(`${base}/goals/${encodeURIComponent(goal.id)}/updates`, {
      status: "blocked",
      note: "Needs release proof."
    });
    assert.equal(update.type, "goal.updated");

    const goals = await getJson(`${base}/goals`);
    assert.equal(goals.goals[0].status, "blocked");

    const improvement = await postJson(`${base}/improvements`, {
      title: "Add install smoke",
      rationale: "Beta needs installed-command proof."
    });
    assert.equal(improvement.type, "improvement.proposed");

    const decision = await postJson(`${base}/improvements/${encodeURIComponent(improvement.id)}/decisions`, {
      decision: "approved",
      note: "Safe next step."
    });
    assert.equal(decision.type, "improvement.approved");

    const improvements = await getJson(`${base}/improvements`);
    assert.equal(improvements.improvements[0].status, "approved");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway exposes the experimental runtime against persisted SQLite state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-runtime-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "odinn-gateway-workspace-"));
  await writeFile(join(workspaceRoot, "fixture.txt"), "before\n");
  await writeFile(join(stateDir, "config.json"), JSON.stringify({
    version: 1,
    experimental: { proof: true, rewind: true, sentinel: true, capsules: true, darwin: true, capabilities: true, counterfactual: true }
  }));
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await getJson(`${base}/status`);
    assert.equal(status.experimental.proof, true);
    assert.equal(status.experimental.capabilities, true);

    const issued = await postJson(`${base}/capabilities/issue`, {
      runId: "gateway-runtime-run",
      stepId: "step-gateway-runtime",
      toolName: "text.echo",
      scopes: ["text:echo"]
    });
    assert.equal(issued.claims.toolName, "text.echo");
    assert.ok(issued.token);

    const run = await postJson(`${base}/run`, {
      id: "gateway-runtime-run",
      tool: "text.echo",
      input: { text: "gateway runtime proof", capabilityToken: issued.token }
    });
    assert.equal(run.output.text, "gateway runtime proof");

    const timeline = await getJson(`${base}/runtime/runs/gateway-runtime-run`);
    assert.equal(timeline.status, "completed-unverified");
    assert.ok(timeline.events.some((event) => event.type === "capability-consumed"));
    assert.equal(JSON.stringify(timeline).includes(issued.token), false);
    assert.equal((await getJson(`${base}/runtime/runs/gateway-runtime-run/verify`)).valid, true);

    const proof = await postJson(`${base}/proof`, {
      schemaVersion: 1,
      id: "gateway-runtime-proof",
      runId: "gateway-runtime-run",
      assertions: [{ id: "fixture", type: "file", path: "fixture.txt", expect: { exists: true, content: { contains: "before" } } }]
    });
    assert.equal(proof.status, "passed");
    assert.equal((await getJson(`${base}/proof/gateway-runtime-run`)).assertions.length, 1);

    const checkpoint = await postJson(`${base}/checkpoints`, {
      runId: "gateway-runtime-run",
      stepId: "step-gateway-checkpoint",
      paths: ["fixture.txt"],
      label: "before-change"
    });
    await writeFile(join(workspaceRoot, "fixture.txt"), "after\n");
    const preview = await postJson(`${base}/rewind/${encodeURIComponent(checkpoint.snapshotId)}`, {});
    assert.equal(preview.applied, false);
    const restored = await postJson(`${base}/rewind/${encodeURIComponent(checkpoint.snapshotId)}`, { apply: true });
    assert.equal(restored.applied, true);
    assert.equal(await readFile(join(workspaceRoot, "fixture.txt"), "utf8"), "before\n");

    const policyResult = await postJson(`${base}/policy/evaluate`, {
      runId: "gateway-runtime-run",
      toolName: "text.echo",
      input: { text: "safe" },
      policy: { version: 1, invariants: [{ id: "allow-safe", type: "command.deny-pattern", values: ["never-match"], enforcement: "block" }] }
    });
    assert.equal(policyResult.allowed, true);
    const capsule = await postJson(`${base}/capsules/export`, { runId: "gateway-runtime-run" });
    const verifiedCapsule = await postJson(`${base}/capsules/verify`, { path: capsule.path });
    assert.equal(verifiedCapsule.valid, true);
    assert.ok(verifiedCapsule.entries.includes("contract.json"));
    assert.ok(verifiedCapsule.entries.includes("policy.json"));
    assert.ok(verifiedCapsule.entries.some((entry) => entry.startsWith("artifacts/")));

    const observed = await postJson(`${base}/routing/observe`, {
      runId: "gateway-runtime-run", providerId: "test", modelId: "verified", taskClass: "general", verified: true, durationMs: 10
    });
    assert.equal(observed.modelId, "verified");
    const choice = await postJson(`${base}/routing/choose`, { taskClass: "general" });
    assert.equal(choice.model, "test:verified");

    const branch = await postJson(`${base}/counterfactual`, {
      sourceRunId: "gateway-runtime-run",
      sourceStepId: timeline.steps[0].id,
      plans: [{ id: "a", title: "A", summary: "candidate A" }, { id: "b", title: "B", summary: "candidate B" }]
    });
    assert.equal(branch.candidates.length, 2);
    assert.equal((await getJson(`${base}/counterfactual/${branch.groupId}`)).candidates.length, 2);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("gateway entrypoint resolves filtered pnpm workspace root from the invocation root", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-entrypoint-"));
  const port = await openPort();
  const child = spawn("node", ["src/server.mjs"], {
    cwd: join(root, "apps/gateway"),
    env: {
      ...process.env,
      INIT_CWD: root,
      ODINN_PORT: String(port),
      ODINN_STATE_DIR: stateDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForStatus(`${base}/status`);
    const plan = await postJson(`${base}/plan`, {
      id: "plan_gateway_entrypoint",
      name: "gateway-entrypoint-plan",
      steps: [{ id: "health", tool: "job.healthcheck" }]
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.steps[0].result.output.workspaceRoot, normalizedRoot);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
  }
});

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForStatus(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function openPort() {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
