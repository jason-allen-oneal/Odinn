import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
