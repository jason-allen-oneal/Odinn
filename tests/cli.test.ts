import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("CLI advanced help exposes documented beta safety controls", () => {
  const help = spawnSync("node", ["apps/cli/src/cli.ts", "help", "--all"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  for (const expected of [
    "config self-improvement set",
    "--interval-ms <ms>",
    "--max-changes <count>",
    "--workspace <directory>",
    "--approve-external",
    "--duration-ms <ms>",
    "--constraints <json>",
    "--show-token",
    "improve rollback --improvement <id>",
    "verified local behavior",
    "experimental and disabled by default",
    "provider- or platform-dependent",
    "explicitly unsupported",
    "forked workers are crash containment, not a security sandbox",
    "remote hosting is application-level tenant isolation, not hostile-user OS isolation",
    "external effects and nondeterministic provider behavior are outside full replay/rollback guarantees"
  ]) {
    assert.match(help.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("CLI redacts credential-like values from top-level failures", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "odinn-cli-redaction-"));
  const secret = "odinn-secret-probe";
  const state = join(rootDir, `api-key=${secret}`);
  await writeFile(state, "not a directory\n");

  const failed = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });

  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stderr, new RegExp(secret));
  assert.match(failed.stderr, /api-key=\[redacted\]/i);
});

test("CLI runs a deterministic tool through the audited kernel path", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-"));
  const init = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "run",
    "--state",
    state,
    "--tool",
    "text.echo",
    "--input-json",
    "{\"text\":\"ODINN_CLI_OK\"}"
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.output.text, "ODINN_CLI_OK");

  const audit = (await readFile(join(state, "audit.jsonl"), "utf8")).trim().split("\n").map((line: any) => JSON.parse(line));
  assert.deepEqual(audit.map((event: any) => event.type), ["task.policy", "task.started", "task.completed"]);

  const runs = spawnSync("node", ["apps/cli/src/cli.ts", "runs", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(runs.status, 0, runs.stderr || runs.stdout);
  const [summary] = JSON.parse(runs.stdout);
  assert.equal(summary.status, "completed");
  assert.equal(summary.tool, "text.echo");

  const show = spawnSync("node", ["apps/cli/src/cli.ts", "show", "--state", state, "--run", result.id], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(show.status, 0, show.stderr || show.stdout);
  const detail = JSON.parse(show.stdout);
  assert.equal(detail.id, result.id);
  assert.equal(detail.events.length, 3);
});

test("one-shot CLI browser reads close Chromium and exit", async (t) => {
  const chromiumPath = process.env.ODINN_CHROMIUM_PATH || "/usr/bin/chromium";
  try {
    await access(chromiumPath);
  } catch {
    t.skip(`Chromium not available at ${chromiumPath}`);
    return;
  }
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-browser-exit-"));
  const init = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const browser = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "run",
    "--state",
    state,
    "--tool",
    "browser.tabs",
    "--input-json",
    "{}"
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ODINN_BROWSER_HEADLESS: "1", ODINN_CHROMIUM_PATH: chromiumPath }
  });
  assert.equal(browser.status, 0, browser.stderr || browser.stdout || String(browser.error));
  assert.equal(browser.signal, null);
  assert.ok(JSON.parse(browser.stdout).output.tabs.length >= 1);

  const planPath = join(state, "browser-plan.json");
  await writeFile(planPath, `${JSON.stringify({
    id: "browser_plan_cli",
    name: "browser-plan-cli",
    steps: [{ id: "tabs", tool: "browser.tabs", input: {} }]
  })}\n`);
  const plan = spawnSync("node", [
    "apps/cli/src/cli.ts", "plan", "--state", state, "--file", planPath
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ODINN_BROWSER_HEADLESS: "1", ODINN_CHROMIUM_PATH: chromiumPath }
  });
  assert.equal(plan.status, 0, plan.stderr || plan.stdout || String(plan.error));
  assert.equal(plan.signal, null);
  const planResult = JSON.parse(plan.stdout);
  assert.equal(planResult.id, "browser_plan_cli");
  assert.ok(planResult.steps[0].result.output.tabs.length >= 1);
});

test("CLI runs a deterministic JSON plan", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-plan-"));
  const planPath = join(state, "plan.json");
  await writeFile(planPath, `${JSON.stringify({
    id: "plan_cli",
    name: "cli-plan",
    steps: [
      { id: "health", tool: "job.healthcheck" },
      { id: "echo", tool: "text.echo", input: { text: "ODINN_PLAN_CLI_OK" } }
    ]
  })}\n`);

  const run = spawnSync("node", ["apps/cli/src/cli.ts", "plan", "--state", state, "--file", planPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.id, "plan_cli");
  assert.equal(result.steps[1].result.output.text, "ODINN_PLAN_CLI_OK");

  const runs = spawnSync("node", ["apps/cli/src/cli.ts", "runs", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(runs.status, 0, runs.stderr || runs.stdout);
  const summaries = JSON.parse(runs.stdout);
  assert.ok(summaries.some((summary: any) => summary.id === "plan_cli" && summary.status === "completed"));
  assert.ok(summaries.some((summary: any) => summary.id === "plan_cli:echo" && summary.status === "completed"));
});

test("CLI run creates and inspects a durable Phase 0 ledger record", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-ledger-"));
  const executed = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "run",
    "--tool",
    "text.echo",
    "--input-json",
    JSON.stringify({ text: "ODINN_CLI_LEDGER_OK" }),
    "--state",
    state
  ], { cwd: root, encoding: "utf8" });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.output.text, "ODINN_CLI_LEDGER_OK");

  const shown = spawnSync("node", ["apps/cli/src/cli.ts", "run", "show", result.id, "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  const run = JSON.parse(shown.stdout);
  assert.equal(run.status, "completed-unverified");
  assert.equal(run.steps[0].type, "tool-request");

  const verified = spawnSync("node", ["apps/cli/src/cli.ts", "run", "verify", result.id, "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).valid, true);
});

test("CLI resolves filtered pnpm relative paths from the invocation root", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-filtered-"));
  const run = spawnSync("node", [
    "src/cli.ts",
    "plan",
    "--state",
    state,
    "--file",
    "examples/local-smoke.plan.json"
  ], {
    cwd: join(root, "apps/cli"),
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: root }
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.id, "plan_local_smoke");
  assert.equal(result.steps[1].result.output.text, "ODINN_PLAN_OK");
});

test("CLI onboarding and TUI expose a local beta entrypoint", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-onboard-"));
  const onboard = spawnSync("node", ["apps/cli/src/cli.ts", "onboard", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
  assert.match(onboard.stdout, /needs an AI connection/);
  assert.match(onboard.stdout, /onboard in a terminal/);

  const tui = spawnSync("node", ["apps/cli/src/cli.ts", "tui", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(tui.status, 0, tui.stderr || tui.stdout);
  assert.match(tui.stdout, /Odinn Forge TUI/);
  assert.match(tui.stdout, /Recent runs/);
});

test("guided onboarding presents choices without developer telemetry", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-guided-"));
  const configured = spawnSync("node", [
    "apps/cli/src/cli.ts", "onboard", "--state", state,
    "--provider", "openai", "--auth", "api-key", "--model", "gpt-test"
  ], { cwd: root, encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "test-key" } });
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);

  const child = spawn("node", ["apps/cli/src/cli.ts", "onboard", "--interactive", "--state", state], {
    cwd: root,
    env: { ...process.env, OPENAI_API_KEY: "test-key" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let answered = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!answered && stdout.includes("7) Exit without changes")) {
      answered = true;
      child.stdin.write("7\n");
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("guided onboarding timed out")); }, 5_000);
    child.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exitCode, 0, stderr || stdout);
  assert.match(stdout, /Your private AI workspace/);
  assert.match(stdout, /Current setup/);
  assert.match(stdout, /OpenAI \/ ChatGPT · gpt-test/);
  assert.match(stdout, /Change AI or model/);
  assert.match(stdout, /Review capabilities/);
  assert.doesNotMatch(stdout, /State:|Workspace:|backend-api|recorded runs/);
});

test("guided onboarding preserves an existing setup when reviewing defaults", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-existing-"));
  const configured = spawnSync("node", [
    "apps/cli/src/cli.ts", "onboard", "--state", state,
    "--provider", "openai", "--auth", "api-key", "--model", "gpt-existing"
  ], { cwd: root, encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "test-key" } });
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  const before = JSON.parse(await readFile(join(state, "config.json"), "utf8"));

  const reviewed = spawn("node", [
    "apps/cli/src/cli.ts", "onboard", "--interactive", "--state", state
  ], {
    cwd: root,
    env: { ...process.env, OPENAI_API_KEY: "test-key" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let step = 0;
  const prompts = [
    ["What would you like to do?", "4\n"],
    ["What should Ódinn be allowed to access?", "\n"],
    ["Apply this setup?", "2\n"],
    ["What would you like to do?", "7\n"]
  ];
  reviewed.stdout.setEncoding("utf8");
  reviewed.stderr.setEncoding("utf8");
  reviewed.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (step < prompts.length && stdout.includes(prompts[step][0])) {
      reviewed.stdin.write(prompts[step][1]);
      step += 1;
    }
  });
  reviewed.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reviewed.kill("SIGKILL"); reject(new Error("existing onboarding timed out")); }, 5_000);
    reviewed.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exitCode, 0, stderr || stdout);
  assert.match(stdout, /Keep current — Everyday assistant/);
  assert.match(stdout, /Review your setup/);
  assert.match(stdout, /No changes made/);

  const after = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(after.defaultModel, before.defaultModel);
  assert.deepEqual(after.providers, before.providers);
  assert.deepEqual(after.policy, before.policy);
});

test("CLI start launches the local chat console", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-start-"));
  const child = spawn("node", ["apps/cli/src/cli.ts", "start", "--state", state, "--port", "0", "--no-open"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: any) => { stdout += chunk; });
  child.stderr.on("data", (chunk: any) => { stderr += chunk; });
  try {
    const url = await new Promise<string>((resolveUrl, rejectUrl) => {
      const timeout = setTimeout(() => rejectUrl(new Error(`start timed out: ${stderr || stdout}`)), 10_000);
      child.stdout.on("data", () => {
        const match = stdout.match(/running at (http:\/\/[^\s]+)/);
        if (match?.[1]) { clearTimeout(timeout); resolveUrl(match[1]); }
      });
      child.once("error", rejectUrl);
      child.once("close", (code: any) => code !== 0 && rejectUrl(new Error(stderr || `start exited ${code}`)));
    });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Ódinn Forge/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveClose: any) => child.once("close", resolveClose));
  }
});

test("CLI state restore rejects symbolic links before copying the backup", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "odinn-cli-restore-"));
  const state = join(fixtureRoot, "state");
  const backup = join(fixtureRoot, "backup");
  const outside = join(fixtureRoot, "outside-token");
  await mkdir(state);
  await mkdir(backup);
  await writeFile(join(state, "config.json"), "{}\n");
  await writeFile(join(backup, "config.json"), "{}\n");
  await writeFile(join(backup, "backup-manifest.json"), `${JSON.stringify({ schemaVersion: 1, source: state, createdAt: new Date().toISOString() })}\n`);
  await writeFile(outside, "outside\n");
  await symlink(outside, join(backup, "gateway.token"));
  const restore = spawnSync("node", ["apps/cli/src/cli.ts", "state", "restore", "--input", backup, "--confirm", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /symbolic link/);
  assert.equal(await readFile(join(state, "config.json"), "utf8"), "{}\n");
});

test("CLI onboarding configures a provider without storing a secret", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-provider-"));
  const onboard = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "onboard",
    "--state",
    state,
    "--provider",
    "openai",
    "--auth",
    "api-key",
    "--model",
    "gpt-test"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
  assert.match(onboard.stdout, /AI: OpenAI \/ ChatGPT · gpt-test/);
  assert.match(onboard.stdout, /Connection: Needs attention/);
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.providers.openai.models[0], "gpt-test");
  assert.equal(config.providers.openai.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(config.providers.openai.apiKey, undefined);
  assert.ok(config.policy.allowedCapabilities.includes("model.chat"));
  assert.ok(config.policy.allowedCapabilities.includes("agent.run"));
});

test("CLI exposes explicit security posture controls", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-security-"));
  const init = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const set = spawnSync("node", [
    "apps/cli/src/cli.ts", "config", "security", "set", "--state", state,
    "--surface", "browser", "--require-approval", "false", "--allowed-domains", "example.com", "--confirm-impact"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr || set.stdout);
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.policy.security.browser.requireApproval, false);
  assert.deepEqual(config.policy.security.browser.allowedDomains, ["example.com"]);
  const show = spawnSync("node", ["apps/cli/src/cli.ts", "config", "security", "show", "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(show.status, 0, show.stderr || show.stdout);
  assert.match(show.stdout, /allowPrivateNetwork/);

  const restore = spawnSync("node", [
    "apps/cli/src/cli.ts", "config", "security", "set", "--state", state,
    "--surface", "browser", "--require-approval", "true"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  assert.equal(JSON.parse(await readFile(join(state, "config.json"), "utf8")).policy.security.browser.requireApproval, true);
  assert.doesNotMatch(restore.stderr, /impact confirmation required/i);
});

test("CLI doctor reports safe diagnostics without state paths or credentials", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-doctor-"));
  const init = spawnSync("node", ["apps/cli/src/cli.ts", "init", "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const provider = spawnSync("node", ["apps/cli/src/cli.ts", "config", "provider", "add", "ci", "--base-url", "http://127.0.0.1:1/v1", "--model", "safe-model", "--api-key-env", "ODINN_DOCTOR_SECRET", "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(provider.status, 0, provider.stderr || provider.stdout);
  const doctor = spawnSync("node", ["apps/cli/src/cli.ts", "doctor", "--state", state], { cwd: root, encoding: "utf8", env: { ...process.env, ODINN_COMMIT: "test-commit" } });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.command, "doctor");
  assert.equal(report.commit, "test-commit");
  assert.equal(report.providerMode[0].configured, false);
  assert.equal(report.state.secretsExcludedFromDiagnostics, true);
  assert.doesNotMatch(doctor.stdout, new RegExp(state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(doctor.stdout, /ODINN_DOCTOR_SECRET/);
});

test("CLI onboarding completes an OAuth PKCE callback locally", async () => {
  const oauth = createServer(async (request: any, response: any) => {
    if (request.url !== "/oauth/token") {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const form = new URLSearchParams(raw);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "cli-test-code");
    assert.ok(form.get("code_verifier"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ access_token: "oauth-access", refresh_token: "oauth-refresh", expires_in: 3600 }));
  });
  await new Promise((resolve: any) => oauth.listen(0, "127.0.0.1", resolve));
  const { port } = oauth.address();
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-oauth-"));
  const child = spawn("node", [
    "apps/cli/src/cli.ts",
    "onboard",
    "--state",
    state,
    "--provider",
    "local-oauth",
    "--auth",
    "oauth",
    "--base-url",
    `http://127.0.0.1:${port}/v1`,
    "--model",
    "test-model",
    "--authorization-url",
    `http://127.0.0.1:${port}/oauth/authorize`,
    "--token-url",
    `http://127.0.0.1:${port}/oauth/token`,
    "--client-id",
    "odinn-cli-test",
    "--no-open",
    "--oauth-timeout-ms",
    "10000"
  ], { cwd: root, encoding: "utf8" });
  let output = "";
  try {
    const authUrl = await new Promise((resolve: any, reject: any) => {
      const onData = (chunk: any) => {
        output += chunk.toString();
        const match = output.match(/https?:\/\/[^\s]+/);
        if (match) resolve(match[0]);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", (chunk: any) => { output += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code: any) => code !== 0 && reject(new Error(output || `onboard exited ${code}`)));
    });
    const authorization = new URL(authUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "cli-test-code");
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    assert.equal((await fetch(callback)).status, 200);
    const exitCode = await new Promise((resolve: any) => child.once("close", resolve));
    assert.equal(exitCode, 0, output);
    const token = JSON.parse(await readFile(join(state, "oauth", "local-oauth.json"), "utf8"));
    assert.equal(token.accessToken, "oauth-access");
  } finally {
    if (!child.killed) child.kill();
    await new Promise((resolve: any, reject: any) => oauth.close((error: any) => error ? reject(error) : resolve()));
  }
});

test("CLI has a built-in OpenAI OAuth preset", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-openai-oauth-preset-"));
  const configured = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "config",
    "provider",
    "add",
    "openai",
    "--auth",
    "oauth",
    "--state",
    state
  ], { cwd: root, encoding: "utf8" });
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.defaultModel, "openai:gpt-5.5");
  assert.equal(config.providers.openai.auth.mode, "oauth");
  assert.equal(config.providers.openai.auth.authorizationUrl, "https://auth.openai.com/oauth/authorize");
  assert.equal(config.providers.openai.transport, "openai-chatgpt-responses");
});

test("CLI exposes URL-free presets for hosted and local providers", async () => {
  const catalog = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "config",
    "provider",
    "catalog"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(catalog.status, 0, catalog.stderr || catalog.stdout);
  const providers = JSON.parse(catalog.stdout);
  const byName = new Map(providers.map((provider: any) => [provider.name, provider]));
  assert.ok(byName.size >= 30);
  assert.deepEqual(byName.get("groq"), {
    name: "groq",
    auth: "api-key",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile"],
    transport: "openai-chat-completions"
  });
  assert.equal(byName.get("ollama").baseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(byName.get("ollama").models, []);
  assert.equal(byName.get("openai").auth, "oauth or api-key");
});

test("CLI wires provider-specific OAuth and Antigravity auth modes", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-provider-auth-"));
  for (const provider of ["openrouter", "chutes", "github-copilot", "xai-oauth", "antigravity"]) {
    const configured = spawnSync("node", [
      "apps/cli/src/cli.ts",
      "config",
      "provider",
      "add",
      provider,
      "--state",
      state
    ], { cwd: root, encoding: "utf8" });
    assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  }
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.providers.openrouter.auth.flow, "openrouter-pkce");
  assert.equal(config.providers.chutes.auth.clientIdEnv, "CHUTES_CLIENT_ID");
  assert.equal(config.providers["github-copilot"].auth.flow, "github-copilot-device");
  assert.equal(config.providers["xai-oauth"].auth.flow, "xai-device");
  assert.equal(config.providers.antigravity.type, "cli");
  assert.equal(config.providers.antigravity.transport, "cli-antigravity");
});

test("CLI imports an OpenClaw OAuth profile without putting tokens in config", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-openclaw-import-"));
  const source = join(state, "auth-profiles.json");
  await writeFile(source, `${JSON.stringify({
    version: 1,
    profiles: {
      "openai:secondary@example.com": {
        type: "oauth",
        provider: "openai",
        email: "secondary@example.com",
        access: "secondary-access",
        refresh: "secondary-refresh",
        expires: Date.now() + 3_600_000
      },
      "openai:default@example.com": {
        type: "oauth",
        provider: "openai",
        email: "default@example.com",
        access: "default-access",
        refresh: "default-refresh",
        expires: Date.now() + 3_600_000
      }
    }
  })}\n`);
  const imported = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "auth",
    "import",
    "openclaw",
    "--source",
    source,
    "--state",
    state,
    "--profile",
    "default@example.com"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  const result = JSON.parse(imported.stdout);
  assert.equal(result.profile, "openai:default@example.com");
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.defaultModel, "openai:gpt-5.5");
  assert.equal(config.providers.openai.auth.mode, "oauth");
  assert.equal(config.providers.openai.access, undefined);
  assert.equal(config.providers.openai.refresh, undefined);
  const token = JSON.parse(await readFile(join(state, "oauth", "openai.json"), "utf8"));
  assert.equal(token.accessToken, "default-access");
  assert.equal(token.refreshToken, "default-refresh");
});

test("CLI imports Hermes auth, skills, and support files into isolated state", async () => {
  const source = await mkdtemp(join(tmpdir(), "hermes-source-"));
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-hermes-import-"));
  await mkdir(join(source, "skills", "testing"), { recursive: true });
  await writeFile(join(source, "auth.json"), `${JSON.stringify({
    providers: { "openai-codex": { tokens: { access_token: "hermes-access", refresh_token: "hermes-refresh" } } }
  })}\n`);
  await writeFile(join(source, "skills", "testing", "SKILL.md"), "# Imported test skill\n");
  await writeFile(join(source, "SOUL.md"), "Imported Hermes persona.\n");

  const imported = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "import",
    "hermes",
    "--source",
    source,
    "--state",
    state
  ], { cwd: root, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  const result = JSON.parse(imported.stdout);
  assert.equal(result.auth.imported[0].profile, "openai-codex");
  assert.equal(result.skills.skillCount, 1);
  assert.equal(result.supportFiles.length, 1);
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.defaultModel, "openai:gpt-5.5");
  const token = JSON.parse(await readFile(join(state, "oauth", "openai.json"), "utf8"));
  assert.equal(token.accessToken, "hermes-access");
  assert.equal(await readFile(join(state, "skills", "imported", "hermes", "global", "testing", "SKILL.md"), "utf8"), "# Imported test skill\n");
  assert.ok(JSON.parse(await readFile(join(state, "imports", "hermes", "manifest.json"), "utf8")).skills.fileCount >= 1);
});

test("CLI stores and searches typed memory records", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-memory-"));
  const remember = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "memory",
    "remember",
    "--state",
    state,
    "--kind",
    "preference",
    "--subject",
    "testing",
    "--text",
    "Prefer fast focused tests before full checks.",
    "--tags",
    "tests,speed"
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(remember.status, 0, remember.stderr || remember.stdout);
  const stored = JSON.parse(remember.stdout);
  assert.equal(stored.kind, "preference");

  const search = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "memory",
    "search",
    "--state",
    state,
    "--query",
    "focused tests"
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(search.status, 0, search.stderr || search.stdout);
  const found = JSON.parse(search.stdout);
  assert.equal(found.memories[0].id, stored.id);

  const curated = spawnSync("node", ["apps/cli/src/cli.ts", "memory", "curate", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(curated.status, 0, curated.stderr || curated.stdout);
  const summary = JSON.parse(curated.stdout);
  assert.equal(summary.kinds.preference[0].subject, "testing");
});

test("CLI records sessions, goals, and self-improvement proposals", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-records-"));

  const createSession = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "session",
    "create",
    "--state",
    state,
    "--title",
    "Beta session"
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(createSession.status, 0, createSession.stderr || createSession.stdout);
  const session = JSON.parse(createSession.stdout);
  assert.equal(session.type, "session.created");

  const message = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "session",
    "message",
    "--state",
    state,
    "--session",
    session.id,
    "--role",
    "user",
    "--content",
    "Build the memory spine."
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(message.status, 0, message.stderr || message.stdout);

  const readSession = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "session",
    "read",
    "--state",
    state,
    "--session",
    session.id
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(readSession.status, 0, readSession.stderr || readSession.stdout);
  const sessionDetail = JSON.parse(readSession.stdout);
  assert.equal(sessionDetail.session.messageCount, 1);
  assert.equal(sessionDetail.messages[0].content, "Build the memory spine.");

  const renameSession = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "session",
    "rename",
    "--state",
    state,
    "--session",
    session.id,
    "--title",
    "Renamed beta session"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(renameSession.status, 0, renameSession.stderr || renameSession.stdout);
  assert.equal(JSON.parse(renameSession.stdout).type, "session.renamed");

  const deleteSession = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "session",
    "delete",
    "--state",
    state,
    "--session",
    session.id
  ], { cwd: root, encoding: "utf8" });
  assert.equal(deleteSession.status, 0, deleteSession.stderr || deleteSession.stdout);
  assert.equal(JSON.parse(deleteSession.stdout).type, "session.deleted");

  const createGoal = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "goal",
    "create",
    "--state",
    state,
    "--title",
    "Reach beta"
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(createGoal.status, 0, createGoal.stderr || createGoal.stdout);
  const goal = JSON.parse(createGoal.stdout);

  const updateGoal = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "goal",
    "update",
    "--state",
    state,
    "--goal",
    goal.id,
    "--status",
    "blocked",
    "--note",
    "Needs release proof."
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(updateGoal.status, 0, updateGoal.stderr || updateGoal.stdout);

  const listGoals = spawnSync("node", ["apps/cli/src/cli.ts", "goal", "list", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(listGoals.status, 0, listGoals.stderr || listGoals.stdout);
  assert.equal(JSON.parse(listGoals.stdout).goals[0].status, "blocked");

  const propose = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "improve",
    "propose",
    "--state",
    state,
    "--title",
    "Add install smoke",
    "--rationale",
    "Beta needs installed-command proof."
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(propose.status, 0, propose.stderr || propose.stdout);
  const improvement = JSON.parse(propose.stdout);

  const decide = spawnSync("node", [
    "apps/cli/src/cli.ts",
    "improve",
    "decide",
    "--state",
    state,
    "--improvement",
    improvement.id,
    "--decision",
    "approved",
    "--note",
    "Safe next step."
  ], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(decide.status, 0, decide.stderr || decide.stdout);

  const listImprovements = spawnSync("node", ["apps/cli/src/cli.ts", "improve", "list", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(listImprovements.status, 0, listImprovements.stderr || listImprovements.stdout);
  assert.equal(JSON.parse(listImprovements.stdout).improvements[0].status, "approved");

  const learned = spawnSync("node", ["apps/cli/src/cli.ts", "improve", "learn", "--state", state, "--limit", "100"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(learned.status, 0, learned.stderr || learned.stdout);
  assert.equal(JSON.parse(learned.stdout).applied.length, 0);
});
