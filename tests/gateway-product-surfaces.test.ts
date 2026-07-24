process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { createAuditStore } from "../packages/kernel/src/index.ts";
import { FileJobStore } from "../packages/store-file/src/index.ts";

const DEFAULT_PROJECT_ID = "project_default";

async function gatewayFixture(prefix: string, config?: Record<string, unknown>) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `${prefix}-workspace-`));
  const stateDir = join(workspaceRoot, ".odinn");
  if (config) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  const server: any = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    stateDir,
    close: () => new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()))
  };
}

async function requestJson(url: string, init: RequestInit = {}, expectedStatus = 200) {
  const response = await fetch(url, init);
  assert.equal(response.status, expectedStatus, `${init.method || "GET"} ${url}`);
  return response.json();
}

async function postJson(url: string, body: unknown, expectedStatus = 200) {
  return requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, expectedStatus);
}

async function patchJson(url: string, body: unknown, expectedStatus = 200) {
  return requestJson(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, expectedStatus);
}

test("audit query paginates and filters while usage shares its summary semantics", async () => {
  const gateway = await gatewayFixture("odinn-audit-surface", {
    selfImprovement: { enabled: false, mode: "disabled" }
  });
  try {
    for (let index = 0; index < 12; index += 1) {
      const result = await postJson(`${gateway.base}/run`, {
        id: `run_audit_surface_${String(index).padStart(2, "0")}`,
        actor: "audit-fixture-user",
        tool: "text.echo",
        input: { text: `audit-fixture-${index}` }
      });
      assert.equal(result.output.text, `audit-fixture-${index}`);
    }

    const query = new URL(`${gateway.base}/audit/query`);
    query.searchParams.set("q", "audit-fixture");
    query.searchParams.set("type", "task.completed");
    query.searchParams.set("tool", "text.echo");
    query.searchParams.set("actor", "audit-fixture-user");
    query.searchParams.set("outcome", "completed");
    query.searchParams.set("pageSize", "10");
    query.searchParams.set("page", "2");
    const audit = await requestJson(query.href);

    assert.deepEqual(audit.pagination, { page: 2, pageSize: 10, pages: 2, total: 12, from: 11, to: 12 });
    assert.equal(audit.events.length, 2);
    assert.ok(audit.events.every((event: any) => event.type === "task.completed" && event.tool === "text.echo" && event.actor === "audit-fixture-user"));
    assert.deepEqual(
      { events: audit.filteredSummary.events, runs: audit.filteredSummary.runs, errors: audit.filteredSummary.errors },
      { events: 12, runs: 12, errors: 0 }
    );
    assert.deepEqual(
      { events: audit.summary.events, runs: audit.summary.runs, modelRuns: audit.summary.modelRuns, errors: audit.summary.errors },
      { events: 36, runs: 12, modelRuns: 0, errors: 0 }
    );
    assert.equal(audit.facets.tools.find((facet: any) => facet.value === "text.echo")?.count, 36);
    assert.equal(audit.facets.outcomes.find((facet: any) => facet.value === "completed")?.count, 12);

    const usage = await requestJson(`${gateway.base}/usage`);
    assert.deepEqual(usage.summary, audit.summary);
    assert.equal(usage.days.reduce((total: number, day: any) => total + day.events, 0), usage.summary.events);
    assert.deepEqual(usage.runs, []);
  } finally {
    await gateway.close();
  }
});

test("tasks hide system reads, expose real detail, and enforce replay safety", async () => {
  const gateway = await gatewayFixture("odinn-task-surface");
  try {
    await requestJson(`${gateway.base}/sessions`);
    await postJson(`${gateway.base}/sessions`, { title: "Non-retry-safe session creation" });
    await postJson(`${gateway.base}/run`, {
      id: "run_task_surface_echo",
      actor: "task-fixture-user",
      tool: "text.echo",
      input: { text: "replay-safe proof" }
    });
    for (let index = 0; index < 12; index += 1) {
      await postJson(`${gateway.base}/run`, {
        id: `run_task_pagination_${String(index).padStart(2, "0")}`,
        actor: "pagination-user",
        tool: "text.echo",
        input: { text: `pagination proof ${index}` }
      });
    }

    const firstPage = await requestJson(`${gateway.base}/tasks?q=pagination-user&page=1&pageSize=5`);
    const secondPage = await requestJson(`${gateway.base}/tasks?q=pagination-user&page=2&pageSize=5`);
    assert.deepEqual(firstPage.pagination, { page: 1, pageSize: 5, pages: 3, total: 12, from: 1, to: 5 });
    assert.deepEqual(secondPage.pagination, { page: 2, pageSize: 5, pages: 3, total: 12, from: 6, to: 10 });
    assert.equal(firstPage.tasks.length, 5);
    assert.equal(secondPage.tasks.length, 5);
    assert.equal(firstPage.tasks.some((task: any) => secondPage.tasks.some((other: any) => other.id === task.id)), false);

    const visible = await requestJson(`${gateway.base}/tasks`);
    assert.equal(visible.tasks.some((task: any) => task.tool === "session.list"), false);
    assert.ok(visible.tasks.every((task: any) => task.category !== "system"));
    assert.ok(visible.tasks.some((task: any) => task.id === "run_task_surface_echo" && task.replayable === true));
    assert.equal(visible.summary.total, visible.tasks.length);

    const all = await requestJson(`${gateway.base}/tasks?includeSystem=true`);
    assert.ok(all.tasks.some((task: any) => task.tool === "session.list" && task.category === "system"));

    const detail = await requestJson(`${gateway.base}/tasks/run_task_surface_echo`);
    assert.equal(detail.task.id, "run_task_surface_echo");
    assert.equal(detail.task.eventCount, 3);
    assert.equal(detail.task.events.length, 3);
    assert.equal(detail.task.replayable, true);
    assert.equal(detail.run.status, "completed");

    const replayed = await postJson(`${gateway.base}/runs/run_task_surface_echo/replay`, { id: "run_task_surface_echo_copy" });
    assert.equal(replayed.id, "run_task_surface_echo_copy");
    assert.equal(replayed.output.text, "replay-safe proof");

    const unsafeTask = all.tasks.find((task: any) => task.tool === "session.create");
    assert.ok(unsafeTask);
    assert.equal(unsafeTask.replayable, false);
    const rejected = await postJson(`${gateway.base}/runs/${encodeURIComponent(unsafeTask.id)}/replay`, { id: "unsafe-copy" }, 409);
    assert.match(rejected.error, /not declared retry-safe/);

    const orphanedJobStore = new FileJobStore(join(gateway.stateDir, "jobs.json"));
    await orphanedJobStore.create({
      id: "job_needs_operator_review",
      status: "needs-review",
      payload: { task: { tool: "web.fetch", input: { url: "https://example.com" }, actor: "automation" } },
      error: "gateway stopped before an audit run was recorded",
      retrySafe: false
    });
    const withOrphanedJob = await requestJson(`${gateway.base}/tasks`);
    const orphaned = withOrphanedJob.tasks.find((task: any) => task.id === "job_needs_operator_review");
    assert.equal(orphaned?.status, "needs-review");
    assert.equal(orphaned?.tool, "web.fetch");
    assert.equal(orphaned?.eventCount, 0);
    assert.equal(orphaned?.source, "job");
    assert.equal(orphaned?.replayable, false);
    assert.ok(withOrphanedJob.summary.needsReview >= 1);
    const orphanedDetail = await requestJson(`${gateway.base}/tasks/job_needs_operator_review`);
    assert.equal(orphanedDetail.task.id, "job_needs_operator_review");
    assert.equal(orphanedDetail.task.title, "Read webpage");
    assert.equal(orphanedDetail.run, undefined);

    const audit = createAuditStore(join(gateway.stateDir, "audit.jsonl"));
    for (const [runId, terminalType] of [["run_blocked_surface", "task.blocked"], ["run_cancelled_surface", "task.cancelled"]]) {
      await audit.append({ at: new Date().toISOString(), runId, type: "task.started", actor: "task-fixture-user", tool: "text.echo", capability: "text.echo" });
      await audit.append({ at: new Date().toISOString(), runId, type: terminalType, actor: "task-fixture-user", tool: "text.echo", capability: "text.echo", message: `${terminalType} proof` });
    }
    const terminalTasks = await requestJson(`${gateway.base}/tasks`);
    assert.equal(terminalTasks.tasks.find((task: any) => task.id === "run_blocked_surface")?.status, "blocked");
    assert.equal(terminalTasks.tasks.find((task: any) => task.id === "run_cancelled_surface")?.status, "cancelled");
    assert.ok(terminalTasks.summary.needsReview >= 3);
  } finally {
    await gateway.close();
  }
});

test("projects group assigned sessions and project- or session-scoped goals", async () => {
  const gateway = await gatewayFixture("odinn-project-surface");
  try {
    const project = await postJson(`${gateway.base}/projects`, {
      id: "project_api_surface",
      name: "API Surface",
      description: "Gateway project grouping proof"
    });
    assert.equal(project.type, "project.created");
    assert.equal(project.id, "project_api_surface");

    await patchJson(`${gateway.base}/projects/${project.id}`, {
      name: "API Surface Polished",
      description: "Updated through the project control surface"
    });

    const session = await postJson(`${gateway.base}/sessions`, { title: "Initially ungrouped" });
    assert.equal(session.projectId, DEFAULT_PROJECT_ID);
    const assigned = await patchJson(`${gateway.base}/sessions/${session.id}`, { projectId: project.id });
    assert.equal(assigned.session.projectId, project.id);

    const secondProject = await postJson(`${gateway.base}/projects`, { id: "project_api_surface_second", name: "Second API Surface" });
    assert.equal(secondProject.id, "project_api_surface_second");
    await patchJson(`${gateway.base}/sessions/${session.id}`, { projectId: secondProject.id, title: "" }, 400);
    const afterRejectedPatch = await requestJson(`${gateway.base}/sessions/${session.id}`);
    assert.equal(afterRejectedPatch.session.projectId, project.id);

    const projectGoal = await postJson(`${gateway.base}/goals`, {
      title: "Ship the project view",
      projectId: project.id
    });
    assert.equal(projectGoal.scopeType, "project");
    assert.equal(projectGoal.scopeId, project.id);

    const sessionGoal = await postJson(`${gateway.base}/goals`, {
      title: "Finish this project session",
      sessionId: session.id
    });
    assert.equal(sessionGoal.scopeType, "session");
    assert.equal(sessionGoal.scopeId, session.id);
    assert.equal(sessionGoal.projectId, project.id);

    await postJson(`${gateway.base}/goals/${projectGoal.id}/updates`, {
      title: "Ship the polished project view",
      description: "Sessions and goals stay grouped through their lifecycle.",
      status: "active",
      note: "Acceptance criteria refined."
    });

    const scopedSessions = await requestJson(`${gateway.base}/sessions?projectId=${encodeURIComponent(project.id)}`);
    assert.deepEqual(scopedSessions.sessions.map((entry: any) => entry.id), [session.id]);
    const scopedGoals = await requestJson(`${gateway.base}/goals?projectId=${encodeURIComponent(project.id)}`);
    assert.deepEqual(new Set(scopedGoals.goals.map((goal: any) => goal.id)), new Set([projectGoal.id, sessionGoal.id]));
    assert.equal(scopedGoals.goals.find((goal: any) => goal.id === projectGoal.id)?.title, "Ship the polished project view");
    const sessionGoals = await requestJson(`${gateway.base}/goals?sessionId=${encodeURIComponent(session.id)}`);
    assert.deepEqual(sessionGoals.goals.map((goal: any) => goal.id), [sessionGoal.id]);

    const projects = await requestJson(`${gateway.base}/projects`);
    const grouped = projects.projects.find((entry: any) => entry.id === project.id);
    assert.equal(grouped.name, "API Surface Polished");
    assert.equal(grouped.sessionCount, 1);
    assert.equal(grouped.goalCount, 2);
    assert.equal(grouped.activeGoalCount, 2);

    await patchJson(`${gateway.base}/projects/${project.id}`, { status: "archived" });
    assert.equal((await requestJson(`${gateway.base}/projects`)).projects.some((entry: any) => entry.id === project.id), false);
    assert.equal((await requestJson(`${gateway.base}/projects?includeArchived=true`)).projects.find((entry: any) => entry.id === project.id)?.status, "archived");
  } finally {
    await gateway.close();
  }
});

test("memory status reports policy integration and persisted records", async () => {
  const gateway = await gatewayFixture("odinn-memory-status");
  try {
    const initial = await requestJson(`${gateway.base}/memory/status`);
    assert.equal(initial.working, true);
    assert.equal(initial.records, 0);
    assert.equal(initial.integration.agentRun, true);
    assert.equal(initial.integration.readAllowed, true);
    assert.equal(initial.integration.writeAllowed, true);
    assert.equal(initial.integration.autoRecall, true);
    assert.equal(initial.integration.autoLearn, true);
    assert.equal(initial.integration.autoCompact, true);

    const memory = await postJson(`${gateway.base}/memory`, {
      kind: "project",
      subject: "gateway-memory-status",
      text: "Memory health is proven through the persisted gateway path.",
      scopeType: "project",
      scopeId: DEFAULT_PROJECT_ID,
      projectId: DEFAULT_PROJECT_ID,
      source: "gateway-product-test"
    });
    assert.equal(memory.scopeType, "project");
    assert.equal(memory.projectId, DEFAULT_PROJECT_ID);

    const status = await requestJson(`${gateway.base}/memory/status`);
    assert.equal(status.working, true);
    assert.equal(status.records, 1);
    assert.ok(status.namespaces >= 1);
    assert.match(status.latestAt, /^\d{4}-\d{2}-\d{2}T/);

    const recalled = await requestJson(`${gateway.base}/memory/recall?query=persisted%20gateway%20path&projectId=${DEFAULT_PROJECT_ID}`);
    assert.equal(recalled.memories[0].id, memory.id);
  } finally {
    await gateway.close();
  }
});

test("memory status reports concrete policy denials without failing its health endpoint", async () => {
  const gateway = await gatewayFixture("odinn-memory-policy-status", {
    policy: { deniedTools: ["agent.run", "memory.curate", "memory.remember"] }
  });
  try {
    const status = await requestJson(`${gateway.base}/memory/status`);
    assert.equal(status.working, false);
    assert.equal(status.integration.agentRun, false);
    assert.equal(status.integration.readAllowed, false);
    assert.equal(status.integration.writeAllowed, false);
    assert.equal(status.integration.autoRecall, false);
    assert.equal(status.integration.autoLearn, false);
    assert.equal(status.integration.autoCompact, false);
  } finally {
    await gateway.close();
  }
});

test("concurrent console read surfaces do not contend on the shared run ledger", async () => {
  const gateway = await gatewayFixture("odinn-concurrent-read-surfaces");
  try {
    const paths = [
      "/projects?includeArchived=true",
      "/sessions?limit=100",
      "/goals?limit=100",
      "/memory/status",
      "/memory?limit=100",
      "/memory/browse?limit=100"
    ];
    for (let round = 0; round < 3; round += 1) {
      const responses = await Promise.all(paths.map((path) => fetch(`${gateway.base}${path}`)));
      assert.deepEqual(responses.map((response) => response.status), paths.map(() => 200));
      await Promise.all(responses.map((response) => response.json()));
    }
  } finally {
    await gateway.close();
  }
});
