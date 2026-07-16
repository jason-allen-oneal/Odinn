import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, listProviderPresets, normalizeModelConfig, normalizeUsage, PROVIDER_PRESETS, runTask } from "../packages/kernel/src/index.ts";

async function listen(handler: any) {
  const server = createServer(handler);
  await new Promise((resolve: any) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("provider usage is normalized across chat, responses, and camel-case payloads", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }), {
    inputTokens: 2, prompt_tokens: 2, outputTokens: 3, completion_tokens: 3, totalTokens: 5, total_tokens: 5, source: "provider"
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 4, output_tokens: 6 }), {
    inputTokens: 4, prompt_tokens: 4, outputTokens: 6, completion_tokens: 6, totalTokens: 10, total_tokens: 10, source: "provider"
  });
  assert.equal(normalizeUsage({}), undefined);
});

test("provider catalog has a conformance contract for every preset", () => {
  const presets = listProviderPresets();
  assert.equal(presets.length, Object.keys(PROVIDER_PRESETS).length);
  for (const preset of presets) {
    const source = PROVIDER_PRESETS[preset.name];
    const config = normalizeModelConfig({ providers: { [preset.name]: { ...source, auth: source.oauth?.auth ?? (source.defaultAuth ? { mode: source.defaultAuth } : undefined), transport: source.oauth?.transport ?? source.transport } } });
    const provider = config.providers[preset.name];
    assert.ok(provider, `${preset.name} normalized`);
    assert.ok(["openai-chat-completions", "openai-responses", "openai-chatgpt-responses", "cli-antigravity"].includes(provider.transport), `${preset.name} transport`);
    assert.ok(provider.auth.mode, `${preset.name} auth`);
  }
});

test("provider transport retries transient failures and normalizes streaming output", async () => {
  let attempts = 0;
  const server = await listen(async (request: any, response: any) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "try again" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ id: "stream_1", choices: [{ delta: { role: "assistant", content: "ODINN_" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "STREAM_OK" } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}`,
      "data: [DONE]",
      ""
    ].join("\n"));
  });
  const root = await mkdtemp(join(tmpdir(), "odinn-provider-"));
  const auditStore = createAuditStore(join(root, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    config: {
      defaultModel: "test:stream-model",
      providers: { test: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "ODINN_PROVIDER_TEST_KEY", models: ["stream-model"] } }
    }
  });
  const previous = process.env.ODINN_PROVIDER_TEST_KEY;
  process.env.ODINN_PROVIDER_TEST_KEY = "provider-key";
  try {
    const result = await runTask({
      task: { id: "provider_retry_stream", tool: "model.chat", input: { stream: true, retries: 2, messages: [{ role: "user", content: "ping" }] } },
      auditStore,
      registry
    });
    assert.equal(attempts, 2);
    assert.equal(result.output.content, "ODINN_STREAM_OK");
    assert.equal(result.output.usage.total_tokens, 4);
  } finally {
    if (previous === undefined) delete process.env.ODINN_PROVIDER_TEST_KEY;
    else process.env.ODINN_PROVIDER_TEST_KEY = previous;
    await new Promise((resolve: any) => server.close(resolve));
  }
});

test("provider responses are terminated at the model body limit", async () => {
  const server = await listen((_request: any, response: any) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "A".repeat(8 * 1024 * 1024 + 1) } }] }));
  });
  const root = await mkdtemp(join(tmpdir(), "odinn-provider-limit-"));
  const auditStore = createAuditStore(join(root, "audit.jsonl"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn"), config: { defaultModel: "test:limited", providers: { test: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: ["limited"] } } } });
  try {
    await assert.rejects(() => runTask({ task: { tool: "model.chat", input: { messages: [{ role: "user", content: "ping" }] } }, auditStore, registry }), /response exceeded 8388608 bytes/);
  } finally { await new Promise((resolve: any) => server.close(resolve)); }
});

test("Antigravity receives prompts over stdin instead of process arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-antigravity-"));
  const command = join(root, "agy-fixture.mjs");
  await writeFile(command, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input })));
`, "utf8");
  await chmod(command, 0o700);
  const previous = process.env.ODINN_ANTIGRAVITY_CLI;
  process.env.ODINN_ANTIGRAVITY_CLI = command;
  const auditStore = createAuditStore(join(root, "audit.jsonl"));
  const registry = createBuiltInRegistry({
    workspaceRoot: root,
    stateDir: join(root, ".odinn"),
    config: {
      defaultModel: "antigravity:test-model",
      providers: {
        antigravity: {
          transport: "cli-antigravity",
          models: ["test-model"],
          auth: { mode: "cli", commandEnv: "ODINN_ANTIGRAVITY_CLI" }
        }
      }
    }
  });
  try {
    const result = await runTask({ task: { tool: "model.chat", input: { messages: [{ role: "user", content: "secret prompt" }] } }, auditStore, registry });
    const captured = JSON.parse(result.output.content);
    assert.deepEqual(captured.args, ["--print", "--model", "test-model"]);
    assert.equal(captured.input, "user: secret prompt");
  } finally {
    if (previous === undefined) delete process.env.ODINN_ANTIGRAVITY_CLI;
    else process.env.ODINN_ANTIGRAVITY_CLI = previous;
  }
});
