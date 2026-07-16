import { createServer as createProviderServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function runInferenceProtocolSmoke() {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-packaged-gateway-") );
  const provider = createProviderServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== "Bearer ci-provider-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "missing provider credential" } }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (payload.model !== "odinn-ci-provider" || !Array.isArray(payload.messages)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid configured-provider request" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "odinn-ci-provider-response",
      object: "chat.completion",
      model: payload.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ODINN_PACKAGED_GATEWAY_OK" } }],
      usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 }
    }));
  });
  await listen(provider);
  const providerPort = provider.address().port;
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify({
    version: 1,
    auditLog: "audit.jsonl",
    policy: {},
    defaultModel: "ci:odinn-ci-provider",
    providers: {
      ci: {
        type: "openai-compatible",
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKeyEnv: "ODINN_CI_PROVIDER_KEY",
        models: ["odinn-ci-provider"]
      }
    }
  }, null, 2)}\n`);

  const child = spawn(process.execPath, ["apps/gateway/src/server.ts"], {
    cwd: root,
    env: { ...process.env, INIT_CWD: root, ODINN_PORT: "0", ODINN_STATE_DIR: stateDir, ODINN_CI_PROVIDER_KEY: "ci-provider-key" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let childError = "";
  let childOutput = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.on("error", (error) => { childError += `\n[child error] ${error.message}`; });
  child.on("exit", (code, signal) => { childOutput += `\n[child exit code=${code} signal=${signal}]`; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { childError += chunk; });
  try {
    const gatewayPort = await waitForChildPort(child, () => childOutput, () => childError);
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    const bootstrap = await fetch(`${gatewayBase}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("packaged gateway did not issue an authentication cookie");
    await waitForStatus(`${gatewayBase}/status`, cookie, child, () => `${childOutput}${childError}`);
    const response = await fetch(`${gatewayBase}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        id: "run_ci_packaged_gateway",
        tool: "model.chat",
        input: { messages: [{ role: "user", content: "ping" }] }
      })
    });
    if (!response.ok) throw new Error(`packaged gateway returned HTTP ${response.status}: ${await response.text()}`);
    const result = await response.json();
    const run = await (await fetch(`${gatewayBase}/runs/run_ci_packaged_gateway`, { headers: { cookie } })).json();
    const persisted = run.events?.find((event) => event.type === "task.completed")?.data?.output?.content;
    if (result.output?.content !== "ODINN_PACKAGED_GATEWAY_OK" || persisted !== "ODINN_PACKAGED_GATEWAY_OK") {
      throw new Error(`configured provider response was not persisted: ${JSON.stringify({ result, persisted })}`);
    }
    return result.output;
  } catch (error) {
    throw new Error(`${error.message}${error.cause ? ` (${error.cause.message})` : ""}; child=${childOutput}${childError}`);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
    await close(provider);
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForChildPort(child, getOutput, getError) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const match = getOutput().match(/"port"\s*:\s*(\d+)/);
    if (match && Number(match[1]) > 0) return Number(match[1]);
    if (child.exitCode !== null) throw new Error(`packaged gateway exited before binding: ${getError() || getOutput() || "no output"}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`packaged gateway did not report a port: ${getError() || getOutput() || "no output"}`);
}

async function waitForStatus(url, cookie, child, getChildError) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { cookie } });
      if (response.ok) return response.json();
      lastError = new Error(`gateway status returned ${response.status}`);
    } catch (error) {
      lastError = error;
      if (child.exitCode !== null) throw new Error(`packaged gateway exited with ${child.exitCode}: ${getChildError() || "no stderr"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for packaged gateway: ${lastError?.message ?? "unknown error"}; child=${getChildError() || "no output"}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await runInferenceProtocolSmoke();
  console.log(result.content);
}
