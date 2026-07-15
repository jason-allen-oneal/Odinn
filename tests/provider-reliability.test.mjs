import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createBuiltInRegistry, runTask } from "../packages/kernel/src/index.mjs";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("provider transport retries transient failures and normalizes streaming output", async () => {
  let attempts = 0;
  const server = await listen(async (request, response) => {
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
    await new Promise((resolve) => server.close(resolve));
  }
});
