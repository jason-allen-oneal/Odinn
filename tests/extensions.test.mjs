import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionExecutor, ExtensionRegistry } from "../packages/kernel/src/extensions.mjs";

test("extension manifests are disabled, grant-scoped, provenance-aware, and rollbackable", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extensions-"));
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  const installed = await registry.install({
    id: "example-tool",
    version: "1.0.0",
    type: "mcp",
    entrypoint: "node server.mjs",
    capabilities: ["web.read"],
    sandbox: "process"
  });
  assert.equal(installed.enabled, false);
  await assert.rejects(() => registry.enable("example-tool", { grants: ["web.read"] }), /untrusted/);
  const enabled = await registry.enable("example-tool", { grants: ["web.read"], trust: true });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.grants, ["web.read"]);
  await registry.install({ id: "example-tool", version: "1.1.0", type: "mcp", capabilities: ["web.read"] });
  const rolledBack = await registry.rollback("example-tool");
  assert.equal(rolledBack.version, "1.0.0");
  assert.equal(rolledBack.enabled, false);
  assert.equal(rolledBack.trusted, false);
});

test("trusted process extensions execute only with an explicit grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-runtime-"));
  const entrypoint = join(root, "tool.mjs");
  await writeFile(entrypoint, `process.stdin.setEncoding("utf8"); let raw=""; process.stdin.on("data", c => raw += c).on("end", () => { const request = JSON.parse(raw); process.stdout.write(JSON.stringify({ result: { echoed: request.input.text, capability: request.capability } }) + "\\n"); });\n`);
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "process-tool", version: "1.0.0", type: "tool", entrypoint: "tool.mjs", capabilities: ["text.echo"], sandbox: "process" });
  const executor = new ExtensionExecutor(registry, { workspaceRoot: root, defaultTimeoutMs: 2_000 });
  await assert.rejects(() => executor.invoke("process-tool", { text: "blocked" }), /not enabled and trusted/);
  await registry.enable("process-tool", { grants: ["text.echo"], trust: true });
  assert.deepEqual(await executor.invoke("process-tool", { text: "ODINN_EXTENSION_OK" }), { echoed: "ODINN_EXTENSION_OK", capability: "text.echo" });
});

test("trusted MCP manifests use the explicit JSONL tools/call adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-mcp-runtime-"));
  const entrypoint = join(root, "mcp.mjs");
  await writeFile(entrypoint, `process.stdin.setEncoding("utf8"); let raw=""; process.stdin.on("data", c => raw += c).on("end", () => { const request = JSON.parse(raw); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ODINN_MCP_OK" }] } }) + "\\n"); });\n`);
  const registry = new ExtensionRegistry(join(root, "extensions.json"));
  await registry.install({ id: "mcp-tool", version: "1.0.0", type: "mcp", entrypoint: "mcp.mjs", capabilities: ["mcp.call"], sandbox: "process" });
  await registry.enable("mcp-tool", { grants: ["mcp.call"], trust: true });
  const executor = new ExtensionExecutor(registry, { workspaceRoot: root, defaultTimeoutMs: 2_000 });
  assert.deepEqual(await executor.invoke("mcp-tool", { name: "fixture", arguments: {} }, { capability: "mcp.call" }), { content: [{ type: "text", text: "ODINN_MCP_OK" }] });
});
