import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("CLI runs a deterministic tool through the audited kernel path", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-"));
  const init = spawnSync("node", ["apps/cli/src/cli.mjs", "init", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = spawnSync("node", [
    "apps/cli/src/cli.mjs",
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

  const audit = (await readFile(join(state, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(audit.map((event) => event.type), ["task.policy", "task.started", "task.completed"]);

  const runs = spawnSync("node", ["apps/cli/src/cli.mjs", "runs", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(runs.status, 0, runs.stderr || runs.stdout);
  const [summary] = JSON.parse(runs.stdout);
  assert.equal(summary.status, "completed");
  assert.equal(summary.tool, "text.echo");

  const show = spawnSync("node", ["apps/cli/src/cli.mjs", "show", "--state", state, "--run", result.id], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(show.status, 0, show.stderr || show.stdout);
  const detail = JSON.parse(show.stdout);
  assert.equal(detail.id, result.id);
  assert.equal(detail.events.length, 3);
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

  const run = spawnSync("node", ["apps/cli/src/cli.mjs", "plan", "--state", state, "--file", planPath], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.id, "plan_cli");
  assert.equal(result.steps[1].result.output.text, "ODINN_PLAN_CLI_OK");

  const runs = spawnSync("node", ["apps/cli/src/cli.mjs", "runs", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(runs.status, 0, runs.stderr || runs.stdout);
  const summaries = JSON.parse(runs.stdout);
  assert.ok(summaries.some((summary) => summary.id === "plan_cli" && summary.status === "completed"));
  assert.ok(summaries.some((summary) => summary.id === "plan_cli:echo" && summary.status === "completed"));
});

test("CLI run creates and inspects a durable Phase 0 ledger record", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-ledger-"));
  const executed = spawnSync("node", [
    "apps/cli/src/cli.mjs",
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

  const shown = spawnSync("node", ["apps/cli/src/cli.mjs", "run", "show", result.id, "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  const run = JSON.parse(shown.stdout);
  assert.equal(run.status, "completed-unverified");
  assert.equal(run.steps[0].type, "tool-request");

  const verified = spawnSync("node", ["apps/cli/src/cli.mjs", "run", "verify", result.id, "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).valid, true);
});

test("CLI resolves filtered pnpm relative paths from the invocation root", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-filtered-"));
  const run = spawnSync("node", [
    "src/cli.mjs",
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
  const onboard = spawnSync("node", ["apps/cli/src/cli.mjs", "onboard", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
  assert.match(onboard.stdout, /Odinn Forge local onboarding/);
  assert.match(onboard.stdout, /pnpm --filter @odinn\/cli start -- tui/);

  const tui = spawnSync("node", ["apps/cli/src/cli.mjs", "tui", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(tui.status, 0, tui.stderr || tui.stdout);
  assert.match(tui.stdout, /Odinn Forge TUI/);
  assert.match(tui.stdout, /Recent runs/);
});

test("CLI onboarding configures a provider without storing a secret", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-provider-"));
  const onboard = spawnSync("node", [
    "apps/cli/src/cli.mjs",
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
  assert.match(onboard.stdout, /Default model: openai:gpt-test/);
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.providers.openai.models[0], "gpt-test");
  assert.equal(config.providers.openai.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(config.providers.openai.apiKey, undefined);
  assert.ok(config.policy.allowedCapabilities.includes("model.chat"));
});

test("CLI exposes explicit security posture controls", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-security-"));
  const init = spawnSync("node", ["apps/cli/src/cli.mjs", "init", "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const set = spawnSync("node", [
    "apps/cli/src/cli.mjs", "config", "security", "set", "--state", state,
    "--surface", "browser", "--require-approval", "false", "--allowed-domains", "example.com"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr || set.stdout);
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(config.policy.security.browser.requireApproval, false);
  assert.deepEqual(config.policy.security.browser.allowedDomains, ["example.com"]);
  const show = spawnSync("node", ["apps/cli/src/cli.mjs", "config", "security", "show", "--state", state], { cwd: root, encoding: "utf8" });
  assert.equal(show.status, 0, show.stderr || show.stdout);
  assert.match(show.stdout, /allowPrivateNetwork/);
});

test("CLI onboarding completes an OAuth PKCE callback locally", async () => {
  const oauth = createServer(async (request, response) => {
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
  await new Promise((resolve) => oauth.listen(0, "127.0.0.1", resolve));
  const { port } = oauth.address();
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-oauth-"));
  const child = spawn("node", [
    "apps/cli/src/cli.mjs",
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
    const authUrl = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        output += chunk.toString();
        const match = output.match(/https?:\/\/[^\s]+/);
        if (match) resolve(match[0]);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", (chunk) => { output += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => code !== 0 && reject(new Error(output || `onboard exited ${code}`)));
    });
    const authorization = new URL(authUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "cli-test-code");
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    assert.equal((await fetch(callback)).status, 200);
    const exitCode = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(exitCode, 0, output);
    const token = JSON.parse(await readFile(join(state, "oauth", "local-oauth.json"), "utf8"));
    assert.equal(token.accessToken, "oauth-access");
  } finally {
    if (!child.killed) child.kill();
    await new Promise((resolve, reject) => oauth.close((error) => error ? reject(error) : resolve()));
  }
});

test("CLI has a built-in OpenAI OAuth preset", async () => {
  const state = await mkdtemp(join(tmpdir(), "odinn-cli-openai-oauth-preset-"));
  const configured = spawnSync("node", [
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
    "config",
    "provider",
    "catalog"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(catalog.status, 0, catalog.stderr || catalog.stdout);
  const providers = JSON.parse(catalog.stdout);
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
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
      "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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

  const curated = spawnSync("node", ["apps/cli/src/cli.mjs", "memory", "curate", "--state", state], {
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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

  const listGoals = spawnSync("node", ["apps/cli/src/cli.mjs", "goal", "list", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(listGoals.status, 0, listGoals.stderr || listGoals.stdout);
  assert.equal(JSON.parse(listGoals.stdout).goals[0].status, "blocked");

  const propose = spawnSync("node", [
    "apps/cli/src/cli.mjs",
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
    "apps/cli/src/cli.mjs",
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

  const listImprovements = spawnSync("node", ["apps/cli/src/cli.mjs", "improve", "list", "--state", state], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(listImprovements.status, 0, listImprovements.stderr || listImprovements.stdout);
  assert.equal(JSON.parse(listImprovements.stdout).improvements[0].status, "approved");

  const learned = spawnSync("node", ["apps/cli/src/cli.mjs", "improve", "learn", "--state", state, "--limit", "100"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(learned.status, 0, learned.stderr || learned.stdout);
  assert.equal(JSON.parse(learned.stdout).applied.length, 0);
});
