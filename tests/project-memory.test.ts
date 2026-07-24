import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const DEFAULT_PROJECT_ID = "project_default";

async function fixture(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "odinn-project-memory-"));
  const stateDir = join(root, ".odinn");
  return {
    root,
    stateDir,
    auditStore: createAuditStore(join(stateDir, "audit.jsonl")),
    registry: createBuiltInRegistry({ workspaceRoot: root, stateDir, config })
  };
}

async function execute(fx: Awaited<ReturnType<typeof fixture>>, id: string, tool: string, input: Record<string, unknown> = {}, policy?: ReturnType<typeof createDefaultPolicy>) {
  return runTask({
    task: { id, tool, input, actor: "test" },
    auditStore: fx.auditStore,
    registry: fx.registry,
    ...(policy ? { policy } : {})
  });
}

async function modelFixture(responder?: (request: any, index: number) => any) {
  const requests: any[] = [];
  const provider = createHttpServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responder?.(requests.at(-1), requests.length) ?? {
      id: `agent_${requests.length}`,
      choices: [{ message: { role: "assistant", content: "Policy-aware response." } }]
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind a TCP port");
  const fx = await fixture({
    defaultModel: "test:test-model",
    providers: {
      test: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        models: ["test-model"]
      }
    }
  });
  return {
    ...fx,
    requests,
    close: () => new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
  };
}

function requestHasRecalledContext(request: any) {
  return request.messages.some((message: any) => String(message.content || "").includes("Durable context recalled"));
}

test("projects preserve default compatibility and group assigned sessions and goals", async () => {
  const fx = await fixture();

  const initialProjects = await execute(fx, "projects_initial", "project.list");
  assert.equal(initialProjects.output.defaultProjectId, DEFAULT_PROJECT_ID);
  assert.deepEqual(initialProjects.output.projects.map((project: any) => project.id), [DEFAULT_PROJECT_ID]);

  const legacySession = await execute(fx, "session_legacy", "session.create", { title: "Unassigned legacy chat" });
  assert.equal(legacySession.output.projectId, DEFAULT_PROJECT_ID);
  const movingSessionGoal = await execute(fx, "goal_moving_session", "goal.create", {
    title: "Follow the conversation when it moves",
    sessionId: legacySession.output.id
  });
  assert.equal(movingSessionGoal.output.projectId, DEFAULT_PROJECT_ID);
  const legacyGoal = await execute(fx, "goal_legacy", "goal.create", { title: "Legacy workspace goal" });
  assert.equal(legacyGoal.output.scopeType, "project");
  assert.equal(legacyGoal.output.projectId, DEFAULT_PROJECT_ID);

  const project = await execute(fx, "project_create", "project.create", {
    id: "project_odinn",
    name: "Odinn",
    description: "Polish the local-first runtime"
  });
  assert.equal(project.output.type, "project.created");
  assert.equal(project.output.id, "project_odinn");

  const projectSession = await execute(fx, "session_project", "session.create", {
    title: "Project-native chat",
    projectId: project.output.id
  });
  assert.equal(projectSession.output.projectId, project.output.id);

  await execute(fx, "session_assign", "session.assign", {
    sessionId: legacySession.output.id,
    projectId: project.output.id
  });
  const projectSessions = await execute(fx, "sessions_project", "session.list", { projectId: project.output.id });
  assert.deepEqual(
    new Set(projectSessions.output.sessions.map((session: any) => session.id)),
    new Set([legacySession.output.id, projectSession.output.id])
  );
  const defaultSessions = await execute(fx, "sessions_default", "session.list", { projectId: DEFAULT_PROJECT_ID });
  assert.equal(defaultSessions.output.sessions.some((session: any) => session.id === legacySession.output.id), false);
  const movedGoals = await execute(fx, "goals_moved_session", "goal.list", { projectId: project.output.id });
  assert.equal(movedGoals.output.goals.find((goal: any) => goal.id === movingSessionGoal.output.id)?.projectId, project.output.id);
  const oldProjectGoals = await execute(fx, "goals_old_project", "goal.list", { projectId: DEFAULT_PROJECT_ID });
  assert.equal(oldProjectGoals.output.goals.some((goal: any) => goal.id === movingSessionGoal.output.id), false);

  const projectGoal = await execute(fx, "goal_project", "goal.create", {
    title: "Ship project navigation",
    projectId: project.output.id
  });
  assert.equal(projectGoal.output.scopeType, "project");
  assert.equal(projectGoal.output.scopeId, project.output.id);
  assert.equal(projectGoal.output.projectId, project.output.id);

  const sessionGoal = await execute(fx, "goal_session", "goal.create", {
    title: "Finish this conversation",
    sessionId: projectSession.output.id
  });
  assert.equal(sessionGoal.output.scopeType, "session");
  assert.equal(sessionGoal.output.scopeId, projectSession.output.id);
  assert.equal(sessionGoal.output.sessionId, projectSession.output.id);
  assert.equal(sessionGoal.output.projectId, project.output.id);

  await execute(fx, "goal_project_edit", "goal.update", {
    goalId: projectGoal.output.id,
    title: "Ship polished project navigation",
    description: "Project navigation groups sessions and goals cleanly.",
    note: "Clarified the acceptance criteria."
  });

  const scopedGoals = await execute(fx, "goals_session", "goal.list", { sessionId: projectSession.output.id });
  assert.deepEqual(scopedGoals.output.goals.map((goal: any) => goal.id), [sessionGoal.output.id]);
  const projectGoals = await execute(fx, "goals_project", "goal.list", { projectId: project.output.id });
  assert.deepEqual(
    new Set(projectGoals.output.goals.map((goal: any) => goal.id)),
    new Set([movingSessionGoal.output.id, projectGoal.output.id, sessionGoal.output.id])
  );
  const editedGoal = projectGoals.output.goals.find((goal: any) => goal.id === projectGoal.output.id);
  assert.equal(editedGoal.title, "Ship polished project navigation");
  assert.equal(editedGoal.description, "Project navigation groups sessions and goals cleanly.");
  assert.equal(editedGoal.status, "active");
});

test("project, session, and goal APIs reject invalid scope targets", async () => {
  const fx = await fixture();
  const project = await execute(fx, "invalid_project_create", "project.create", { id: "project_valid", name: "Valid project" });
  const session = await execute(fx, "invalid_session_create", "session.create", { title: "Valid session" });

  await assert.rejects(
    () => execute(fx, "session_unknown_project", "session.create", { title: "Orphan", projectId: "project_missing" }),
    /project not found or archived: project_missing/
  );
  await assert.rejects(
    () => execute(fx, "assign_unknown_project", "session.assign", { sessionId: session.output.id, projectId: "project_missing" }),
    /project not found or archived: project_missing/
  );
  await assert.rejects(
    () => execute(fx, "goal_unknown_session", "goal.create", { title: "Orphan goal", sessionId: "sess_missing" }),
    /session not found: sess_missing/
  );
  await assert.rejects(
    () => execute(fx, "goal_mismatched_scope", "goal.create", {
      title: "Crossed wires",
      sessionId: session.output.id,
      projectId: project.output.id
    }),
    /goal projectId must match the selected session's project/
  );
  await assert.rejects(
    () => execute(fx, "archive_default_project", "project.update", { projectId: DEFAULT_PROJECT_ID, status: "archived" }),
    /default Workspace project cannot be archived/
  );
  await assert.rejects(
    () => execute(fx, "memory_unknown_project", "memory.remember", { text: "orphan project memory", scopeType: "project", scopeId: "project_missing" }),
    /memory project not found: project_missing/
  );
  await assert.rejects(
    () => execute(fx, "memory_unknown_session", "memory.remember", { text: "orphan session memory", scopeType: "session", scopeId: "sess_missing" }),
    /memory session not found: sess_missing/
  );
  await assert.rejects(
    () => execute(fx, "memory_mismatched_project", "memory.remember", {
      text: "crossed memory scope", scopeType: "session", scopeId: session.output.id, sessionId: session.output.id, projectId: project.output.id
    }),
    /memory projectId must match the selected session's project/
  );
  await assert.rejects(
    () => execute(fx, "compact_unknown_session", "memory.compact", {
      sessionId: "sess_missing", messages: [{ role: "user", content: "Do not compact an orphan." }]
    }),
    /session not found: sess_missing/
  );
});

test("memory corrections and compacted summaries preserve their original scope", async () => {
  const fx = await fixture();
  const project = await execute(fx, "scope_project_create", "project.create", { id: "project_memory_scope", name: "Memory scope" });
  const session = await execute(fx, "scope_session_create", "session.create", { title: "Scoped memory session", projectId: project.output.id });
  const original = await execute(fx, "scope_memory_create", "memory.remember", {
    kind: "decision",
    subject: "scope-bound-decision",
    text: "The original decision belongs only to the memory scope project.",
    scopeType: "project",
    scopeId: project.output.id,
    projectId: project.output.id
  });
  const correction = await execute(fx, "scope_memory_correct", "memory.correct", {
    targetId: original.output.id,
    text: "The corrected decision still belongs only to the memory scope project."
  });
  assert.equal(correction.output.scopeType, "project");
  assert.equal(correction.output.scopeId, project.output.id);
  assert.equal(correction.output.projectId, project.output.id);

  const projectRecall = await execute(fx, "scope_project_recall", "memory.recall", { query: "corrected decision", projectId: project.output.id });
  assert.deepEqual(projectRecall.output.memories.map((memory: any) => memory.id), [correction.output.id]);
  const defaultRecall = await execute(fx, "scope_default_recall", "memory.recall", { query: "corrected decision", projectId: DEFAULT_PROJECT_ID });
  assert.equal(defaultRecall.output.memories.length, 0);

  await execute(fx, "scope_session_message", "session.message", { sessionId: session.output.id, role: "user", content: "Keep this summary inside its session." });
  const compacted = await execute(fx, "scope_memory_compact", "memory.compact", { sessionId: session.output.id });
  assert.equal(compacted.output.scopeType, "session");
  assert.equal(compacted.output.scopeId, session.output.id);
  assert.equal(compacted.output.sessionId, session.output.id);
  assert.equal(compacted.output.projectId, project.output.id);
});

test("identical memories remain independent across project scopes", async () => {
  const fx = await fixture();
  await execute(fx, "dedupe_project_a", "project.create", { id: "project_scope_a", name: "Scope A" });
  await execute(fx, "dedupe_project_b", "project.create", { id: "project_scope_b", name: "Scope B" });
  const text = "This decision is intentionally identical in both projects.";
  const first = await execute(fx, "dedupe_memory_a", "memory.remember", {
    kind: "decision", subject: "scoped-dedupe", text,
    scopeType: "project", scopeId: "project_scope_a", projectId: "project_scope_a"
  });
  const second = await execute(fx, "dedupe_memory_b", "memory.remember", {
    kind: "decision", subject: "scoped-dedupe", text,
    scopeType: "project", scopeId: "project_scope_b", projectId: "project_scope_b"
  });
  assert.notEqual(first.output.id, second.output.id);
  assert.equal(second.output.duplicate, undefined);
  const recalledA = await execute(fx, "dedupe_recall_a", "memory.recall", { query: "intentionally identical", projectId: "project_scope_a" });
  const recalledB = await execute(fx, "dedupe_recall_b", "memory.recall", { query: "intentionally identical", projectId: "project_scope_b" });
  assert.deepEqual(recalledA.output.memories.map((memory: any) => memory.id), [first.output.id]);
  assert.deepEqual(recalledB.output.memories.map((memory: any) => memory.id), [second.output.id]);
});

test("agent.run neither recalls nor learns when memory capabilities are denied", async () => {
  const fx = await modelFixture();
  const policy = createDefaultPolicy({ allowedCapabilities: ["agent.run", "model.chat"] });
  try {
    const result = await execute(fx, "agent_memory_denied", "agent.run", {
      model: "test:test-model",
      messages: [{ role: "user", content: "Remember that ultraviolet dashboards are mandatory." }]
    }, policy);

    assert.deepEqual(result.output.memory, { recalled: 0, suggested: 0, learned: 0, compacted: 0 });
    assert.equal(requestHasRecalledContext(fx.requests[0]), false);
    const search = await execute(fx, "search_memory_denied", "memory.search", { query: "ultraviolet dashboards mandatory" });
    assert.equal(search.output.memories.length, 0);
  } finally {
    await fx.close();
  }
});

test("agent.run with read-only memory recalls context without learning", async () => {
  const fx = await modelFixture();
  const policy = createDefaultPolicy({ allowedCapabilities: ["agent.run", "model.chat", "memory.read"] });
  try {
    const seed = await execute(fx, "seed_read_only", "memory.remember", {
      kind: "preference",
      subject: "interface",
      text: "Ultraviolet dashboards are the preferred interface style."
    });
    const result = await execute(fx, "agent_memory_read_only", "agent.run", {
      model: "test:test-model",
      messages: [{ role: "user", content: "Remember that ultraviolet dashboards are mandatory." }]
    }, policy);

    assert.equal(result.output.memory.recalled, 1);
    assert.equal(result.output.memory.learned, 0);
    assert.equal(requestHasRecalledContext(fx.requests[0]), true);
    const search = await execute(fx, "search_memory_read_only", "memory.search", { query: "ultraviolet dashboards" });
    assert.deepEqual(search.output.memories.map((memory: any) => memory.id), [seed.output.id]);
  } finally {
    await fx.close();
  }
});

test("agent.run with write-only memory suggests without recalling context", async () => {
  const fx = await modelFixture();
  const policy = createDefaultPolicy({ allowedCapabilities: ["agent.run", "model.chat", "memory.write"] });
  try {
    await execute(fx, "seed_write_only", "memory.remember", {
      kind: "preference",
      subject: "interface",
      text: "Ultraviolet dashboards are the preferred interface style."
    });
    const result = await execute(fx, "agent_memory_write_only", "agent.run", {
      model: "test:test-model",
      messages: [{ role: "user", content: "Remember that ultraviolet dashboards are mandatory." }]
    }, policy);

    assert.equal(result.output.memory.recalled, 0);
    assert.equal(result.output.memory.suggested, 1);
    assert.equal(result.output.memory.learned, 0);
    assert.equal(requestHasRecalledContext(fx.requests[0]), false);
    const search = await execute(fx, "search_memory_write_only", "memory.search", { query: "ultraviolet dashboards mandatory" });
    assert.equal(search.output.memories.some((memory: any) => memory.text === "ultraviolet dashboards are mandatory."), false);
    const candidates = await execute(fx, "candidate_memory_write_only", "memory.candidates", { status: "pending" });
    assert.ok(candidates.output.candidates.some((candidate: any) => candidate.text === "ultraviolet dashboards are mandatory."));
  } finally {
    await fx.close();
  }
});

test("agent.run respects concrete memory tool denials for automatic and model-invoked memory", async () => {
  const fx = await modelFixture();
  const policy = createDefaultPolicy({
    allowedCapabilities: ["agent.run", "model.chat", "memory.read", "memory.write"],
    deniedTools: ["memory.recall", "memory.remember", "memory.suggest", "memory.compact"]
  });
  try {
    const session = await execute(fx, "denied_memory_session", "session.create", { title: "Denied memory session" });
    const result = await execute(fx, "agent_concrete_memory_denials", "agent.run", {
      model: "test:test-model",
      sessionId: session.output.id,
      messages: [
        { role: "user", content: "Remember that denied memory operations must stay denied." },
        { role: "assistant", content: "Acknowledged." },
        { role: "user", content: "This is message three." },
        { role: "assistant", content: "This is message four." },
        { role: "user", content: "This is message five." },
        { role: "assistant", content: "This is message six." }
      ]
    }, policy);
    assert.deepEqual(result.output.memory, { recalled: 0, suggested: 0, learned: 0, compacted: 0 });
    const offeredTools = fx.requests[0].tools.map((tool: any) => tool.function.name);
    assert.equal(offeredTools.includes("memory_x2e_recall"), false);
    assert.equal(offeredTools.includes("memory_x2e_remember"), false);
    assert.equal(offeredTools.includes("memory_x2e_browse"), true);
    const autoMemoryEvents = (await fx.auditStore.readAll()).filter((event: any) => event.actor === "agent-memory");
    assert.deepEqual(autoMemoryEvents, []);
    const search = await execute(fx, "denied_memory_search", "memory.search", { query: "denied memory operations" });
    assert.equal(search.output.memories.length, 0);
  } finally {
    await fx.close();
  }
});

test("agent.run aggregates provider usage across tool-calling model turns", async () => {
  const fx = await modelFixture((_request, index) => index === 1 ? {
    id: "agent_usage_turn_1",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_usage", type: "function", function: { name: "memory_x2e_recall", arguments: '{"query":"usage aggregation"}' } }] } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  } : {
    id: "agent_usage_turn_2",
    choices: [{ message: { role: "assistant", content: "Usage was aggregated." } }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
  });
  const policy = createDefaultPolicy({ allowedCapabilities: ["agent.run", "model.chat", "memory.read"] });
  try {
    const result = await execute(fx, "agent_usage_aggregate", "agent.run", {
      model: "test:test-model",
      messages: [{ role: "user", content: "Prove usage aggregation." }]
    }, policy);
    assert.deepEqual(result.output.usage, {
      inputTokens: 6, prompt_tokens: 6,
      outputTokens: 6, completion_tokens: 6,
      totalTokens: 12, total_tokens: 12,
      source: "provider"
    });
    const completed = (await fx.auditStore.readRun("agent_usage_aggregate"))?.events.find((event: any) => event.type === "task.completed");
    assert.equal(completed?.data?.output?.usage?.totalTokens, 12);
  } finally {
    await fx.close();
  }
});

test("agent.run preserves aggregated usage when a later tool requires approval", async () => {
  const fx = await modelFixture((_request, index) => index === 1 ? {
    id: "agent_approval_turn_1",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_recall", type: "function", function: { name: "memory_x2e_recall", arguments: '{"query":"approval usage"}' } }] } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  } : {
    id: "agent_approval_turn_2",
    choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_click", type: "function", function: { name: "browser_x2e_click", arguments: '{"selector":"#submit"}' } }] } }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
  });
  const policy = createDefaultPolicy({ allowedCapabilities: ["agent.run", "model.chat", "memory.read", "browser.act"] });
  try {
    const result = await execute(fx, "agent_usage_approval", "agent.run", {
      model: "test:test-model",
      messages: [{ role: "user", content: "Prepare an approved action." }]
    }, policy);
    assert.equal(result.output.pendingApproval.type, "approval.required");
    assert.equal(result.output.usage.totalTokens, 12);
    assert.equal(result.output.usage.inputTokens, 7);
    assert.equal(result.output.usage.outputTokens, 5);
  } finally {
    await fx.close();
  }
});
