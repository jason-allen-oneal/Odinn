import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, normalizeModelConfig, runPlan, runTask, saveOAuthToken } from "../packages/kernel/src/index.mjs";
import { createDefaultPolicy } from "../packages/policy/src/index.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "odinn-kernel-"));
  return {
    root,
    auditStore: createAuditStore(join(root, ".odinn", "audit.jsonl")),
    registry: createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn") })
  };
}

test("kernel executes an allowed deterministic tool and audits the run", async () => {
  const { root, auditStore, registry } = await fixture();
  const result = await runTask({
    task: { id: "run_echo", tool: "text.echo", input: { text: "ODINN_KERNEL_OK" }, actor: "test" },
    auditStore,
    registry
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.text, "ODINN_KERNEL_OK");

  const audit = JSON.parse(`[${(await readFile(join(root, ".odinn", "audit.jsonl"), "utf8")).trim().split("\n").join(",")}]`);
  assert.deepEqual(audit.map((event) => event.type), ["task.policy", "task.started", "task.completed"]);
  assert.equal(audit[0].decision, "allow");

  const runs = await auditStore.readRuns();
  assert.equal(runs[0].id, "run_echo");
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].eventCount, 3);
});

test("security policy is safe by default and supports explicit posture changes", () => {
  const defaults = createDefaultPolicy();
  assert.equal(defaults.security.web.enabled, true);
  assert.equal(defaults.security.web.allowPrivateNetwork, false);
  assert.deepEqual(defaults.security.web.allowedDomains, []);
  assert.equal(defaults.security.browser.requireApproval, true);
  assert.equal(defaults.security.browser.allowPrivateNetwork, false);

  const configured = createDefaultPolicy({
    security: {
      web: { allowedDomains: ["example.com"] },
      browser: { requireApproval: false }
    }
  });
  assert.equal(configured.security.web.enabled, true);
  assert.equal(configured.security.web.allowPrivateNetwork, false);
  assert.deepEqual(configured.security.web.allowedDomains, ["example.com"]);
  assert.equal(configured.security.browser.enabled, true);
  assert.equal(configured.security.browser.requireApproval, false);

  const legacy = createDefaultPolicy({ allowedCapabilities: [
    "job.healthcheck", "text.echo", "workspace.readText", "model.chat",
    "session.read", "session.write", "goal.read", "goal.write",
    "memory.read", "memory.write", "improve.read", "improve.write"
  ] });
  assert.ok(legacy.allowedCapabilities.includes("browser.read"));
});

test("kernel routes model.chat through an OpenAI-compatible provider", async () => {
  const provider = createHttpServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-key");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "test-model");
    assert.equal(body.messages[0].content, "Hello");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chat_test",
      choices: [{ message: { role: "assistant", content: "ODINN_MODEL_OK" } }],
      usage: { total_tokens: 3 }
    }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { port } = provider.address();
  const { root, auditStore } = await fixture();
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    config: {
      defaultModel: "test:test-model",
      providers: {
        test: {
          type: "openai-compatible",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: "ODINN_TEST_API_KEY",
          models: ["test-model"]
        }
      }
    }
  });
  const previousKey = process.env.ODINN_TEST_API_KEY;
  process.env.ODINN_TEST_API_KEY = "test-key";
  try {
    const result = await runTask({
      task: {
        id: "run_model",
        tool: "model.chat",
        input: { messages: [{ role: "user", content: "Hello" }] },
        actor: "test"
      },
      auditStore,
      registry
    });
    assert.equal(result.output.content, "ODINN_MODEL_OK");
    assert.equal(result.output.provider, "test");
    assert.equal((await auditStore.readRun("run_model")).status, "completed");
  } finally {
    if (previousKey === undefined) delete process.env.ODINN_TEST_API_KEY;
    else process.env.ODINN_TEST_API_KEY = previousKey;
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test("kernel refreshes OAuth credentials before model execution", async () => {
  const providerServer = createHttpServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = new URLSearchParams(raw);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "refresh-old");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "access-refreshed", refresh_token: "refresh-new", expires_in: 3600 }));
      return;
    }
    assert.equal(request.url, "/responses");
    assert.equal(request.headers.authorization, "Bearer access-refreshed");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    assert.equal(JSON.parse(raw).input[0].content, "Hello OAuth");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output_text: "ODINN_OAUTH_OK" }));
  });
  await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const { port } = providerServer.address();
  const { root, auditStore } = await fixture();
  const config = {
    defaultModel: "oauth:test-model",
    providers: {
      oauth: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}`,
        transport: "openai-chatgpt-responses",
        models: ["test-model"],
        auth: {
          mode: "oauth",
          authorizationUrl: `http://127.0.0.1:${port}/oauth/authorize`,
          tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
          clientId: "odinn-test"
        }
      }
    }
  };
  const normalizedProvider = normalizeModelConfig(config).providers.oauth;
  await saveOAuthToken(normalizedProvider, join(root, ".odinn"), {
    access_token: "access-old",
    refresh_token: "refresh-old",
    expiresAt: Date.now() - 1
  });
  try {
    const result = await runTask({
      task: {
        id: "run_oauth_model",
        tool: "model.chat",
        input: { messages: [{ role: "user", content: "Hello OAuth" }] },
        actor: "test"
      },
      auditStore,
      registry: createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn"), config })
    });
    assert.equal(result.output.content, "ODINN_OAUTH_OK");
    assert.equal(result.output.provider, "oauth");
  } finally {
    await new Promise((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("kernel speaks the ChatGPT Codex SSE transport for imported OAuth", async () => {
  const providerServer = createHttpServer(async (request, response) => {
    assert.equal(request.url, "/responses");
    assert.equal(request.headers.authorization, "Bearer codex-access");
    assert.equal(request.headers.originator, "openclaw");
    const body = JSON.parse(await new Promise((resolve) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => resolve(raw));
    }));
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ODINN_"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"CODEX_OK"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","usage":{"total_tokens":3}}}\n\n'
    ].join(""));
  });
  await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const { port } = providerServer.address();
  const { root, auditStore } = await fixture();
  const stateDir = join(root, ".odinn");
  const config = {
    defaultModel: "openai:gpt-5.5",
    providers: {
      openai: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}`,
        transport: "openai-chatgpt-responses",
        models: ["gpt-5.5"],
        auth: { mode: "oauth" }
      }
    }
  };
  const normalizedProvider = normalizeModelConfig(config).providers.openai;
  await saveOAuthToken(normalizedProvider, stateDir, {
    access_token: "codex-access",
    refresh_token: "codex-refresh",
    expires_at: Date.now() + 3_600_000
  });
  try {
    const result = await runTask({
      task: {
        id: "run_codex_model",
        tool: "model.chat",
        input: { messages: [{ role: "user", content: "Hello Codex" }] },
        actor: "test"
      },
      auditStore,
      registry: createBuiltInRegistry({ workspaceRoot: root, stateDir, config })
    });
    assert.equal(result.output.content, "ODINN_CODEX_OK");
    assert.equal(result.output.id, "resp_test");
  } finally {
    await new Promise((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("kernel denies unknown tools before execution and records the denial", async () => {
  const { root, auditStore, registry } = await fixture();
  await assert.rejects(
    runTask({
      task: { id: "run_denied", tool: "shell.exec", input: { command: "rm -rf /" }, actor: "test" },
      auditStore,
      registry
    }),
    /unknown tool: shell\.exec/
  );

  const line = (await readFile(join(root, ".odinn", "audit.jsonl"), "utf8")).trim();
  const event = JSON.parse(line);
  assert.equal(event.type, "task.policy");
  assert.equal(event.decision, "deny");

  const run = await auditStore.readRun("run_denied");
  assert.equal(run.status, "denied");
  assert.equal(run.events.length, 1);
});

test("workspace.readText is confined to the workspace root", async () => {
  const { root, auditStore, registry } = await fixture();
  await writeFile(join(root, "note.txt"), "inside\n");

  const ok = await runTask({
    task: { id: "run_read", tool: "workspace.readText", input: { path: "note.txt" }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(ok.output.content, "inside\n");

  await assert.rejects(
    runTask({
      task: { id: "run_escape", tool: "workspace.readText", input: { path: "../outside.txt" }, actor: "test" },
      auditStore,
      registry,
      policy: createDefaultPolicy()
    }),
    /path escapes workspace root/
  );
});

test("self-improvement mines repeated audited failures but never applies them", async () => {
  const { root, auditStore } = await fixture();
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn"), auditStore });
  await auditStore.append({ runId: "failed-a", type: "task.failed", actor: "test", tool: "web.fetch", message: "DNS validation failed" });
  await auditStore.append({ runId: "failed-b", type: "task.failed", actor: "test", tool: "web.fetch", message: "DNS validation failed" });
  const result = await runTask({ task: { id: "learn-1", tool: "improve.learn", input: {}, actor: "test" }, auditStore, registry });
  assert.equal(result.output.applied, false);
  assert.equal(result.output.requiresHumanDecision, true);
  assert.equal(result.output.generated.length, 1);
});

test("web.fetch rejects a public-looking hostname that resolves to loopback", async () => {
  const { root, auditStore } = await fixture();
  const server = createServer((_request, response) => response.end("private"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn") });
  try {
    await assert.rejects(runTask({ task: { id: "run-dns-rebind", tool: "web.fetch", input: { url: `http://127.0.0.1.nip.io:${server.address().port}/` }, actor: "test" }, auditStore, registry }), /private|link-local|DNS validation/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("kernel runs deterministic multi-step plans and materializes plan state", async () => {
  const { auditStore, registry } = await fixture();
  const result = await runPlan({
    plan: {
      id: "plan_smoke",
      name: "smoke",
      steps: [
        { id: "health", tool: "job.healthcheck" },
        { id: "echo", tool: "text.echo", input: { text: "ODINN_PLAN_OK" } }
      ]
    },
    auditStore,
    registry,
    actor: "test"
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].result.output.text, "ODINN_PLAN_OK");

  const plan = await auditStore.readRun("plan_smoke");
  assert.equal(plan.status, "completed");
  assert.equal(plan.events.map((event) => event.type).join(","), "plan.started,plan.completed");

  const runs = await auditStore.readRuns();
  assert.ok(runs.some((run) => run.id === "plan_smoke:health" && run.status === "completed"));
  assert.ok(runs.some((run) => run.id === "plan_smoke:echo" && run.status === "completed"));
});

test("memory records are typed, searchable, curated, and superseded by corrections", async () => {
  const { auditStore, registry } = await fixture();
  const original = await runTask({
    task: {
      id: "run_memory_remember",
      tool: "memory.remember",
      input: {
        kind: "preference",
        subject: "cli",
        text: "Prefer exact commands over vague guidance.",
        tags: ["ux", "commands"],
        source: "test",
        authority: "user-reviewed"
      },
      actor: "test"
    },
    auditStore,
    registry
  });
  assert.equal(original.output.kind, "preference");
  assert.equal(original.output.status, "active");

  const search = await runTask({
    task: { id: "run_memory_search", tool: "memory.search", input: { query: "exact commands" }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(search.output.memories.length, 1);
  assert.equal(search.output.memories[0].id, original.output.id);

  const correction = await runTask({
    task: {
      id: "run_memory_correct",
      tool: "memory.correct",
      input: {
        targetId: original.output.id,
        text: "Prefer exact runnable commands with concise context.",
        reason: "narrowed wording"
      },
      actor: "test"
    },
    auditStore,
    registry
  });
  assert.equal(correction.output.supersedes, original.output.id);

  const curated = await runTask({
    task: { id: "run_memory_curate", tool: "memory.curate", input: {}, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(curated.output.count, 1);
  assert.equal(curated.output.kinds.correction[0].text, "Prefer exact runnable commands with concise context.");

  const browsed = await runTask({
    task: { id: "run_memory_browse", tool: "memory.browse", input: { namespace: "user" }, actor: "test" },
    auditStore,
    registry
  });
  assert.ok(browsed.output.namespaces.some((entry) => entry.namespace === "user/preferences"));
});

test("memory compacts session context into an L0 summary", async () => {
  const { auditStore, registry } = await fixture();
  const session = await runTask({
    task: { id: "run_compact_session", tool: "session.create", input: { title: "Compact me" }, actor: "test" },
    auditStore,
    registry
  });
  await runTask({
    task: { id: "run_compact_message", tool: "session.message", input: { sessionId: session.output.id, role: "user", content: "We decided to keep the beta local-first." }, actor: "test" },
    auditStore,
    registry
  });
  const compacted = await runTask({
    task: { id: "run_memory_compact", tool: "memory.compact", input: { sessionId: session.output.id }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(compacted.output.tier, "l0");
  assert.equal(compacted.output.namespace, `sessions/${session.output.id}`);
  assert.match(compacted.output.text, /local-first/);
});

test("agent auto-learns explicit facts and recalls them into later model context", async () => {
  const requests = [];
  const provider = createHttpServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `agent_${requests.length}`,
      choices: [{ message: { role: "assistant", content: "Memory-aware response." } }]
    }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { port } = provider.address();
  const { root, auditStore } = await fixture();
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    config: {
      defaultModel: "test:test-model",
      providers: {
        test: {
          type: "openai-compatible",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          models: ["test-model"]
        }
      }
    }
  });
  try {
    const learned = await runTask({
      task: {
        id: "run_agent_learn",
        tool: "agent.run",
        input: {
          model: "test:test-model",
          sessionId: "sess_memory",
          messages: [{ role: "user", content: "Remember that I prefer dark themes." }]
        },
        actor: "test"
      },
      auditStore,
      registry
    });
    assert.equal(learned.output.memory.learned, 1);

    const recalled = await runTask({
      task: {
        id: "run_agent_recall",
        tool: "agent.run",
        input: {
          model: "test:test-model",
          sessionId: "sess_memory",
          messages: [{ role: "user", content: "What visual style do I prefer?" }]
        },
        actor: "test"
      },
      auditStore,
      registry
    });
    assert.equal(recalled.output.memory.recalled, 1);
    const contextMessage = requests[1].messages.find((message) => message.content.includes("Durable context recalled"));
    assert.match(contextMessage.content, /dark themes/);
  } finally {
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test("kernel records sessions, goals, and self-improvement proposals", async () => {
  const { auditStore, registry } = await fixture();

  const session = await runTask({
    task: { id: "run_session_create", tool: "session.create", input: { title: "Beta test" }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(session.output.type, "session.created");

  await runTask({
    task: {
      id: "run_session_message",
      tool: "session.message",
      input: { sessionId: session.output.id, role: "user", content: "Build out Odinn." },
      actor: "test"
    },
    auditStore,
    registry
  });

  const sessionDetail = await runTask({
    task: { id: "run_session_read", tool: "session.read", input: { sessionId: session.output.id }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(sessionDetail.output.session.messageCount, 1);
  assert.equal(sessionDetail.output.messages[0].content, "Build out Odinn.");

  const renamed = await runTask({
    task: { id: "run_session_rename", tool: "session.rename", input: { sessionId: session.output.id, title: "Renamed beta chat" }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(renamed.output.type, "session.renamed");
  const renamedDetail = await runTask({
    task: { id: "run_session_read_renamed", tool: "session.read", input: { sessionId: session.output.id }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(renamedDetail.output.session.title, "Renamed beta chat");

  const deleted = await runTask({
    task: { id: "run_session_delete", tool: "session.delete", input: { sessionId: session.output.id }, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(deleted.output.type, "session.deleted");
  const sessions = await runTask({
    task: { id: "run_session_list_after_delete", tool: "session.list", input: {}, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(sessions.output.sessions.some((entry) => entry.id === session.output.id), false);
  await assert.rejects(
    () => runTask({
      task: { id: "run_session_message_deleted", tool: "session.message", input: { sessionId: session.output.id, role: "user", content: "Should fail" }, actor: "test" },
      auditStore,
      registry
    }),
    /session is not open/
  );

  const goal = await runTask({
    task: { id: "run_goal_create", tool: "goal.create", input: { title: "Reach beta" }, actor: "test" },
    auditStore,
    registry
  });
  await runTask({
    task: {
      id: "run_goal_update",
      tool: "goal.update",
      input: { goalId: goal.output.id, status: "blocked", note: "release preflight needs a clean tree" },
      actor: "test"
    },
    auditStore,
    registry
  });
  const goals = await runTask({
    task: { id: "run_goal_list", tool: "goal.list", input: {}, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(goals.output.goals[0].status, "blocked");
  assert.equal(goals.output.goals[0].notes[0].note, "release preflight needs a clean tree");

  const improvement = await runTask({
    task: {
      id: "run_improve_propose",
      tool: "improve.propose",
      input: {
        title: "Add install smoke test",
        rationale: "Beta should prove the installed command path.",
        target: "release"
      },
      actor: "test"
    },
    auditStore,
    registry
  });
  await runTask({
    task: {
      id: "run_improve_decide",
      tool: "improve.decide",
      input: { improvementId: improvement.output.id, decision: "approved", note: "safe proposal" },
      actor: "test"
    },
    auditStore,
    registry
  });
  const improvements = await runTask({
    task: { id: "run_improve_list", tool: "improve.list", input: {}, actor: "test" },
    auditStore,
    registry
  });
  assert.equal(improvements.output.improvements[0].status, "approved");
});
