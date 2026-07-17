import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayServer } from "../apps/gateway/src/server.ts";
import { commitOnboardingDraft, createOnboardingDraft, discardOnboardingDraft, recoverInterruptedOnboardingTransactions } from "../apps/cli/src/onboarding/apply.ts";
import { decideGatewayAction, probeGateway } from "../apps/cli/src/onboarding/runtime.ts";
import { PROVIDER_PRESETS, saveOAuthToken } from "../packages/kernel/src/index.ts";

const root = new URL("..", import.meta.url).pathname;
const cli = ["apps/cli/src/cli.ts"];
const testApiKeyEnv = "ODINN_ONBOARDING_TEST_API_KEY";

async function runCli(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...cli, ...args], {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out:\n${stderr || stdout}`));
    }, options.timeoutMs ?? 10_000);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function createStatePath(prefix: string) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  return join(parent, "state");
}

async function configureMockProvider(state: string, baseUrl: string) {
  const result = await runCli([
    "config", "provider", "add", "onboarding-test",
    "--state", state,
    "--base-url", baseUrl,
    "--model", "test-model",
    "--api-key-env", testApiKeyEnv
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

async function modelServer(statusCode: number) {
  const requests: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    for await (const _chunk of request) { /* drain the request */ }
    response.writeHead(statusCode, { "content-type": "application/json" });
    if (statusCode === 200) {
      response.end(JSON.stringify({
        id: "onboarding-verification",
        choices: [{ message: { role: "assistant", content: "ODINN_CONNECTION_OK" } }]
      }));
      return;
    }
    response.end(JSON.stringify({
      error: { message: statusCode === 429 ? "quota exhausted" : "invalid credential" }
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("non-interactive onboarding creates a permission-safe fresh state", async () => {
  const state = await createStatePath("odinn-onboarding-fresh-");
  const result = await runCli(["onboard", "--non-interactive", "--state", state]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /needs an AI connection|setup required/i);
  assert.equal((await stat(state)).mode & 0o777, 0o700);
  assert.equal((await stat(join(state, "config.json"))).mode & 0o777, 0o600);

  const raw = await readFile(join(state, "config.json"), "utf8");
  const config = JSON.parse(raw);
  assert.deepEqual(config.providers, {});
  assert.equal(config.policy.security.web.allowPrivateNetwork, false);
  assert.equal(config.policy.security.browser.allowPrivateNetwork, false);
  assert.equal(config.policy.security.browser.requireApproval, true);
  assert.doesNotMatch(raw, /"(?:apiKey|accessToken|refreshToken)"\s*:/i);
});

test("an existing setup is a byte-for-byte no-op when onboarding keeps it", async () => {
  const state = await createStatePath("odinn-onboarding-keep-");
  const initialized = await runCli(["onboard", "--non-interactive", "--state", state]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const before = await readFile(join(state, "config.json"));

  const kept = await runCli(["onboard", "--non-interactive", "--state", state]);
  assert.equal(kept.code, 0, kept.stderr || kept.stdout);
  const after = await readFile(join(state, "config.json"));
  assert.deepEqual(after, before);
});

test("a custom capability policy is labeled Custom and is never broadened by review", async () => {
  const state = await createStatePath("odinn-onboarding-custom-");
  const initialized = await runCli(["onboard", "--non-interactive", "--state", state]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const configPath = join(state, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers = {
    "onboarding-test": {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: testApiKeyEnv,
      models: ["test-model"]
    }
  };
  config.defaultModel = "onboarding-test:test-model";
  config.policy.allowedCapabilities = ["job.healthcheck", "model.chat", "web.read"];
  config.policy.security.web.enabled = false;
  config.policy.security.browser.enabled = false;
  await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
  const before = await readFile(configPath);

  const reviewed = await runCli(
    ["onboard", "--interactive", "--state", state],
    { env: { [testApiKeyEnv]: "not-a-secret-in-config" }, input: "q\n" }
  );
  assert.ok(reviewed.code === 0 || reviewed.code === 130, reviewed.stderr || reviewed.stdout);
  assert.match(`${reviewed.stdout}\n${reviewed.stderr}`, /Access:\s*Custom|Custom access/i);
  assert.deepEqual(await readFile(configPath), before);
});

test("cancelling fresh interactive onboarding does not create configuration", async () => {
  const state = await createStatePath("odinn-onboarding-cancel-");
  const cancelled = await runCli(
    ["onboard", "--interactive", "--state", state],
    { input: "q\n" }
  );
  assert.ok(cancelled.code === 0 || cancelled.code === 130, cancelled.stderr || cancelled.stdout);
  await assert.rejects(access(state), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("gateway probing opens an existing Odinn runtime instead of rebinding its port", async () => {
  const state = await createStatePath("odinn-onboarding-gateway-");
  const initialized = await runCli(["onboard", "--non-interactive", "--state", state]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const gateway: any = await createGatewayServer({ stateDir: state, workspaceRoot: root });
  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const probe = await probeGateway({ host: "127.0.0.1", port: address.port });
    assert.equal(probe.state, "healthy");
    const decision = decideGatewayAction(probe);
    assert.equal(decision.action, "open");
    assert.equal(decision.shouldStart, false);
    assert.equal(decision.shouldOpen, true);
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error: Error | undefined) => error ? reject(error) : resolve()));
  }
});

test("onboarding refuses to overwrite config or OAuth changed by another process", async () => {
  const state = await createStatePath("odinn-onboarding-conflict-");
  await mkdir(join(state, "oauth"), { recursive: true, mode: 0o700 });
  await writeFile(join(state, "config.json"), '{"version":1,"value":"original"}\n', { mode: 0o600 });
  await writeFile(join(state, "oauth", "openai.json"), '{"accessToken":"original"}\n', { mode: 0o600 });
  const draft = await createOnboardingDraft(state);
  const concurrentConfig = '{"version":1,"value":"concurrent"}\n';
  const concurrentToken = '{"accessToken":"refreshed"}\n';
  await writeFile(join(state, "config.json"), concurrentConfig, { mode: 0o600 });
  await writeFile(join(state, "oauth", "openai.json"), concurrentToken, { mode: 0o600 });
  try {
    await assert.rejects(commitOnboardingDraft(draft), /changed in another process/i);
    assert.equal(await readFile(join(state, "config.json"), "utf8"), concurrentConfig);
    assert.equal(await readFile(join(state, "oauth", "openai.json"), "utf8"), concurrentToken);
  } finally {
    await discardOnboardingDraft(draft);
  }
});

test("onboarding commits config and OAuth together and keeps a restorable backup", async () => {
  const state = await createStatePath("odinn-onboarding-transaction-");
  await mkdir(join(state, "oauth"), { recursive: true, mode: 0o700 });
  const originalConfig = '{"version":1,"value":"original"}\n';
  const originalToken = '{"accessToken":"original"}\n';
  await writeFile(join(state, "config.json"), originalConfig, { mode: 0o600 });
  await writeFile(join(state, "oauth", "openai.json"), originalToken, { mode: 0o600 });
  const draft = await createOnboardingDraft(state);
  const nextConfig = '{"version":1,"value":"next"}\n';
  const nextToken = '{"accessToken":"next"}\n';
  await writeFile(join(draft.draftState, "config.json"), nextConfig, { mode: 0o600 });
  await writeFile(join(draft.draftState, "oauth", "openai.json"), nextToken, { mode: 0o600 });

  const result = await commitOnboardingDraft(draft);
  await discardOnboardingDraft(draft);
  assert.equal(await readFile(join(state, "config.json"), "utf8"), nextConfig);
  assert.equal(await readFile(join(state, "oauth", "openai.json"), "utf8"), nextToken);
  assert.ok(result.backupPath);
  assert.equal(await readFile(join(result.backupPath, "config.json"), "utf8"), originalConfig);
  assert.equal(await readFile(join(result.backupPath, "oauth", "openai.json"), "utf8"), originalToken);
  assert.equal((await readdir(state)).some((name) => name.startsWith(".onboarding-transaction-")), false);
});

test("onboarding recovers an interrupted config and OAuth transaction", async () => {
  const state = await createStatePath("odinn-onboarding-recovery-");
  const transaction = join(state, ".onboarding-transaction-interrupted");
  await mkdir(join(state, "oauth"), { recursive: true, mode: 0o700 });
  await mkdir(join(transaction, "previous-oauth"), { recursive: true, mode: 0o700 });
  const originalConfig = '{"version":1,"value":"original"}\n';
  const originalToken = '{"accessToken":"original"}\n';
  await writeFile(join(state, "config.json"), '{"version":1,"value":"partial"}\n', { mode: 0o600 });
  await writeFile(join(state, "oauth", "openai.json"), '{"accessToken":"partial"}\n', { mode: 0o600 });
  await writeFile(join(transaction, "previous-config.json"), originalConfig, { mode: 0o600 });
  await writeFile(join(transaction, "previous-oauth", "openai.json"), originalToken, { mode: 0o600 });
  await writeFile(join(transaction, "previous-oauth-present"), "yes\n", { mode: 0o600 });
  await writeFile(join(transaction, "phase"), "oauth-swapped\n", { mode: 0o600 });

  await recoverInterruptedOnboardingTransactions(state);
  assert.equal(await readFile(join(state, "config.json"), "utf8"), originalConfig);
  assert.equal(await readFile(join(state, "oauth", "openai.json"), "utf8"), originalToken);
  await assert.rejects(access(transaction), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("recovery preserves live OAuth when preparation never reached its phase marker", async () => {
  const state = await createStatePath("odinn-onboarding-unprepared-");
  const transaction = join(state, ".onboarding-transaction-unprepared");
  await mkdir(join(state, "oauth"), { recursive: true, mode: 0o700 });
  await mkdir(transaction, { recursive: true, mode: 0o700 });
  const liveToken = '{"accessToken":"still-live"}\n';
  await writeFile(join(state, "oauth", "openai.json"), liveToken, { mode: 0o600 });

  await recoverInterruptedOnboardingTransactions(state);
  assert.equal(await readFile(join(state, "oauth", "openai.json"), "utf8"), liveToken);
  await assert.rejects(access(transaction), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("guided onboarding can launch a configured CLI-auth provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "odinn-onboarding-cli-auth-home-"));
  const state = join(home, "state");
  const fakeCli = join(home, "fake-antigravity");
  await writeFile(fakeCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(fakeCli, 0o700);
  const result = await runCli(
    ["onboard", "--interactive", "--state", state],
    {
      env: {
        HOME: home,
        HERMES_HOME: join(home, ".hermes"),
        OPENCLAW_AUTH_PROFILES: "",
        OPENCLAW_STATE_DIR: "",
        ODINN_ANTIGRAVITY_CLI: fakeCli
      },
      input: "\n2\n3\n36\n\n5\n",
      timeoutMs: 15_000
    }
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Starting .*fake-antigravity/i);
  assert.match(result.stdout, /Setup paused|Nothing was changed/i);
  await assert.rejects(access(state), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("non-interactive onboarding passes the configured provider to CLI auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "odinn-onboarding-cli-auth-scripted-"));
  const state = join(home, "state");
  const fakeCli = join(home, "fake-antigravity");
  await writeFile(fakeCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(fakeCli, 0o700);
  const result = await runCli(
    ["onboard", "--provider", "antigravity", "--auth", "cli", "--state", state],
    { env: { ODINN_ANTIGRAVITY_CLI: fakeCli } }
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Starting .*fake-antigravity/i);
});

test("a stale OAuth refresh cannot overwrite newer credentials", async () => {
  const state = await createStatePath("odinn-onboarding-oauth-cas-");
  const preset: any = PROVIDER_PRESETS.openai.oauth;
  const provider = { ...preset, auth: preset.auth };
  const firstSave = await saveOAuthToken(provider, state, { access_token: "first", refresh_token: "refresh" });
  const tokenPath = firstSave.path;
  const firstRaw = await readFile(tokenPath, "utf8");
  const firstFingerprint = createHash("sha256").update(firstRaw).digest("hex");
  await saveOAuthToken(provider, state, { access_token: "newer", refresh_token: "refresh" });

  await assert.rejects(
    saveOAuthToken(
      provider,
      state,
      { access_token: "stale", refresh_token: "refresh" },
      { expectedTokenFingerprint: firstFingerprint }
    ),
    /stale refresh was not written/i
  );
  assert.equal(JSON.parse(await readFile(tokenPath, "utf8")).accessToken, "newer");
});

for (const scenario of [
  { statusCode: 200, exitCode: 0, message: /AI connection verified/i },
  { statusCode: 401, exitCode: 1, message: /sign-in rejected/i },
  { statusCode: 429, exitCode: 1, message: /usage limit reached/i }
]) {
  test(`model verification reports an actionable result for HTTP ${scenario.statusCode}`, async () => {
    const mock = await modelServer(scenario.statusCode);
    const state = await createStatePath(`odinn-onboarding-verify-${scenario.statusCode}-`);
    try {
      await configureMockProvider(state, mock.baseUrl);
      const result = await runCli(
        ["onboard", "--verify", "--non-interactive", "--state", state],
        { env: { [testApiKeyEnv]: "verification-key" } }
      );
      assert.equal(result.code, scenario.exitCode, result.stderr || result.stdout);
      assert.match(`${result.stdout}\n${result.stderr}`, scenario.message);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].url, "/v1/chat/completions");
      assert.equal(mock.requests[0].authorization, "Bearer verification-key");
    } finally {
      await mock.close();
    }
  });
}
