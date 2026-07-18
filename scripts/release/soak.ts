#!/usr/bin/env node
import { createServer as createProviderServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(releaseDir, "release-manifest.json"), "utf8"));
const archive = join(releaseDir, `odinn-v${pkg.version}.tar.gz`);
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const startedAt = Date.now();
const steps: any[] = [];

async function run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  return await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        rejectRun(new Error(`${command} ${args.join(" ")} timed out after 180000 ms`));
      }
    }, 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      rejectRun(new Error(`${command} ${args.join(" ")} failed: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (status !== 0) {
        rejectRun(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout || `exit ${status ?? signal}`}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}

async function listen(server: any) {
  await new Promise((resolveListen: any, reject: any) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

async function close(server: any) {
  await new Promise((resolveClose: any, reject: any) => server.close((error: any) => error ? reject(error) : resolveClose()));
}

async function delay(ms: number) { await new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

async function startGateway(packageRoot: string, workspace: string, state: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [join(packageRoot, "apps/gateway/src/server.ts")], {
    cwd: workspace,
    env: { ...process.env, ...env, INIT_CWD: workspace, ODINN_STATE_DIR: state, ODINN_PORT: "0", ODINN_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = output.match(/"port"\s*:\s*(\d+)/);
    if (match && Number(match[1]) > 0) {
      const base = `http://127.0.0.1:${match[1]}`;
      const bootstrap = await fetch(`${base}/`);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
      if (!cookie) throw new Error("packaged gateway did not issue a bootstrap cookie");
      return { child, base, cookie, output, errorOutput };
    }
    if (child.exitCode !== null) throw new Error(`packaged gateway exited before binding: ${errorOutput || output || "no output"}`);
    await delay(100);
  }
  child.kill();
  throw new Error(`packaged gateway did not bind: ${errorOutput || output || "no output"}`);
}

async function stopGateway(gateway: any) {
  if (gateway.child.exitCode === null) gateway.child.kill("SIGTERM");
  await new Promise((resolveClose) => gateway.child.once("close", resolveClose));
}

async function gatewayRequest(gateway: any, path: string, init: any = {}) {
  const headers = { ...(init.headers ?? {}), cookie: gateway.cookie, origin: gateway.base };
  const response = await fetch(`${gateway.base}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

let providerMode = "normal";
let providerRequests = 0;
const provider = createProviderServer(async (request: any, response: any) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  if (request.headers.authorization !== "Bearer odinn-soak-key") { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "unauthorized" } })); return; }
  providerRequests += 1;
  if (providerMode === "timeout") { await delay(1_500); }
  if (providerMode === "fail-once" && providerRequests % 2 === 1) {
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "temporary provider failure" } }));
    return;
  }
  let raw = "";
  try {
    for await (const chunk of request) raw += chunk;
  } catch (error: any) {
    if (error?.code === "ECONNRESET" || request.destroyed || response.destroyed) return;
    throw error;
  }
  const payload = JSON.parse(raw);
  const content = payload.messages?.some((message: any) => String(message.content).includes("ODINN_CAPABILITY_OK")) ? "ODINN_CAPABILITY_OK" : "ODINN_SOAK_PROVIDER_OK";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: `soak-response-${providerRequests}`, object: "chat.completion", model: payload.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
});
await listen(provider);
const providerUrl = `http://127.0.0.1:${(provider.address() as any).port}/v1`;

async function record(name: string, operation: () => Promise<any> | any) {
  const started = Date.now();
  try {
    const result = await operation();
    steps.push({ name, ok: true, durationMs: Date.now() - started, ...(result && typeof result === "object" ? result : {}) });
    return result;
  } catch (error: any) {
    steps.push({ name, ok: false, durationMs: Date.now() - started, category: "step-failed" });
    throw error;
  }
}

const temp = await mkdtemp(join(tmpdir(), "odinn-beta3-soak-"));
const workspace = join(temp, "workspace");
const state = join(temp, "state");
const installPrefix = join(temp, "installed");
await run("tar", ["-xzf", archive, "-C", temp], root);
const packageRoot = join(temp, `odinn-v${pkg.version}`);
await run(packageManager, ["install", "--frozen-lockfile", "--ignore-scripts"], packageRoot);
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "soak-output.txt"), "ODINN_SOAK_FILE\n");
await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "init", "--state", state], workspace, { INIT_CWD: workspace });

try {
  await record("fresh-onboarding-local-provider", () => run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "onboard", "--provider", "ci", "--auth", "api-key", "--base-url", providerUrl, "--model", "odinn-soak-model", "--api-key-env", "ODINN_SOAK_KEY", "--state", state], workspace, { INIT_CWD: workspace, ODINN_SOAK_KEY: "odinn-soak-key" }));
  await record("onboarding-provider-verification", () => run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "onboard", "--verify", "--state", state], workspace, { INIT_CWD: workspace, ODINN_SOAK_KEY: "odinn-soak-key" }));
  await record("deterministic-tool", () => run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "run", "--tool", "text.echo", "--input-json", JSON.stringify({ text: "ODINN_SOAK_TOOL" }), "--state", state], workspace, { INIT_CWD: workspace }));
  await record("multi-step-plan", () => run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "plan", "--file", join(packageRoot, "examples/local-smoke.plan.json"), "--state", state], workspace, { INIT_CWD: workspace }));

  providerMode = "fail-once";
  providerRequests = 0;
  await record("provider-failure-retry-recovery", async () => {
    const output = await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "run", "--tool", "model.chat", "--input-json", JSON.stringify({ retries: 1, messages: [{ role: "user", content: "retry" }] }), "--state", state], workspace, { INIT_CWD: workspace, ODINN_SOAK_KEY: "odinn-soak-key" });
    if (!output.includes("ODINN_SOAK_PROVIDER_OK") || providerRequests < 2) throw new Error("provider retry did not recover after a transient failure");
    return { providerAttempts: providerRequests };
  });
  providerMode = "timeout";
  await record("provider-timeout", async () => {
    try {
      await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "run", "--tool", "model.chat", "--input-json", JSON.stringify({ timeoutMs: 1_000, retries: 0, messages: [{ role: "user", content: "timeout" }] }), "--state", state], workspace, { INIT_CWD: workspace, ODINN_SOAK_KEY: "odinn-soak-key" });
      throw new Error("provider timeout did not fail safely");
    } catch (error: any) {
      if (!/timed out|timeout/i.test(error.message)) throw error;
    }
    return { recovered: true };
  });
  providerMode = "normal";
  await record("provider-post-timeout-recovery", () => run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "run", "--tool", "model.chat", "--input-json", JSON.stringify({ messages: [{ role: "user", content: "recover" }] }), "--state", state], workspace, { INIT_CWD: workspace, ODINN_SOAK_KEY: "odinn-soak-key" }));

  let gateway = await record("gateway-start", () => startGateway(packageRoot, workspace, state, { ODINN_SOAK_KEY: "odinn-soak-key" }));
  await record("gateway-status", async () => { const result = await gatewayRequest(gateway, "/status"); if (!result.response.ok) throw new Error("gateway status failed"); return { status: "healthy" }; });
  const gatewayRun = await record("gateway-provider-run", async () => {
    const result = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "soak-gateway-run", tool: "model.chat", input: { messages: [{ role: "user", content: "gateway" }] } }) });
    if (!result.response.ok || result.body.output?.content !== "ODINN_SOAK_PROVIDER_OK") throw new Error("gateway provider run failed");
    return { runId: result.body.id };
  });
  await stopGateway(gateway);
  gateway = await record("gateway-restart", () => startGateway(packageRoot, workspace, state, { ODINN_SOAK_KEY: "odinn-soak-key" }));
  await record("persisted-output-after-restart", async () => {
    const result = await gatewayRequest(gateway, `/runs/${encodeURIComponent(gatewayRun.runId)}`);
    if (!result.response.ok || !result.body.events?.some((event: any) => event.type === "task.completed")) throw new Error("gateway restart lost persisted output");
    return { persisted: true };
  });

  providerMode = "timeout";
  const queuedJob = await record("queue-work", async () => {
    const result = await gatewayRequest(gateway, "/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "soak-interrupted-job", timeoutMs: 30_000, task: { tool: "model.chat", input: { timeoutMs: 30_000, retries: 0, messages: [{ role: "user", content: "interrupt this queued operation" }] } } }) });
    if (result.response.status !== 202 || !result.body.job?.id) throw new Error("gateway did not queue the soak job");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await gatewayRequest(gateway, "/jobs/soak-interrupted-job");
      if (status.body.status === "running") return { jobId: status.body.id };
      await delay(100);
    }
    throw new Error("queued soak job never reached running state");
  });
  await stopGateway(gateway);
  providerMode = "normal";
  gateway = await record("queue-stop-restart-recovery", () => startGateway(packageRoot, workspace, state, { ODINN_SOAK_KEY: "odinn-soak-key" }));
  await record("recovered-job-state", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await gatewayRequest(gateway, `/jobs/${encodeURIComponent(queuedJob.jobId)}`);
      if (result.body.status === "needs-review") return { recoveredJobs: 1, recoveryStatus: result.body.status };
      await delay(100);
    }
    throw new Error("interrupted job did not enter needs-review after restart");
  });

  await writeFile(join(state, "browser-recovery.json"), `${JSON.stringify({ schemaVersion: 1, id: "soak-browser-transaction", status: "unknown" })}\n`);
  await record("browser-interruption-recovery-block", async () => {
    const status = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.recovery.status", input: {} }) });
    if (status.body.output?.recovery?.status !== "unknown") throw new Error("browser recovery journal was not observed");
    const blocked = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.press", input: { key: "Escape", confirmed: true } }) });
    if (blocked.response.status !== 400 || blocked.body.category !== "browser-recovery") throw new Error("browser mutation was not blocked by unresolved recovery");
    const resolved = await gatewayRequest(gateway, "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.recovery.resolve", input: { outcome: "not-applied" } }) });
    if (!resolved.response.ok || resolved.body.output?.recovery?.status !== "resolved") throw new Error("browser recovery could not be resolved");
    return { unresolvedApprovals: 0, browserRecoveryBlocked: true };
  });
  await stopGateway(gateway);

  const configPath = join(state, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.experimental = { ...(config.experimental ?? {}), rewind: true };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const rewindRun = JSON.parse(await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "run", "--tool", "text.echo", "--input-json", JSON.stringify({ text: "ODINN_SOAK_REWIND" }), "--state", state], workspace, { INIT_CWD: workspace }));
  const checkpoint = JSON.parse(await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "experimental", "rewind", "checkpoint", "create", rewindRun.id, "--path", "soak-output.txt", "--state", state], workspace, { INIT_CWD: workspace }));
  await record("rewind-dry-run", async () => { const preview = JSON.parse(await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "experimental", "rewind", "restore", checkpoint.snapshotId, "--state", state], workspace, { INIT_CWD: workspace })); if (preview.applied !== false) throw new Error("rewind dry-run applied a restore"); return { applied: false }; });
  await record("audit-integrity-and-persisted-output", async () => { const verification = JSON.parse(await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "audit", "verify", "--state", state], workspace, { INIT_CWD: workspace })); if (!verification.valid) throw new Error("audit verification failed"); await run(process.execPath, [join(packageRoot, "apps/cli/src/cli.ts"), "run", "show", rewindRun.id, "--state", state], workspace, { INIT_CWD: workspace }); return { auditVerification: true }; });

  await record("installer-upgrade-rollback", async () => {
    const installer = join(packageRoot, "scripts/install.ts");
    await run(process.execPath, [installer, "install", "--source", packageRoot, "--prefix", installPrefix, "--version", pkg.version, "--commit", "soak-release-a", "--artifact-sha256", "soak-a"], workspace);
    const first = JSON.parse(await run(process.execPath, [installer, "status", "--prefix", installPrefix], workspace));
    await run(process.execPath, [installer, "upgrade", "--source", packageRoot, "--prefix", installPrefix, "--version", pkg.version, "--commit", "soak-release-b", "--artifact-sha256", "soak-b"], workspace);
    const upgraded = JSON.parse(await run(process.execPath, [installer, "status", "--prefix", installPrefix], workspace));
    if (upgraded.previous !== first.current) throw new Error("installer did not preserve the previous release pointer");
    await run(process.execPath, [installer, "rollback", "--prefix", installPrefix], workspace);
    const rolledBack = JSON.parse(await run(process.execPath, [installer, "status", "--prefix", installPrefix], workspace));
    if (rolledBack.current !== first.current) throw new Error("installer rollback did not restore the previous release");
    const rollbackRoot = join(installPrefix, "versions", rolledBack.current);
    const rollbackWorkspace = join(temp, "post-rollback-workspace");
    const rollbackState = join(temp, "post-rollback-state");
    await mkdir(rollbackWorkspace, { recursive: true });
    await run(process.execPath, [join(rollbackRoot, "apps/cli/src/cli.ts"), "onboard", "--state", rollbackState], rollbackWorkspace, { INIT_CWD: rollbackWorkspace });
    const smoke = await run(process.execPath, [join(rollbackRoot, "apps/cli/src/cli.ts"), "run", "--tool", "text.echo", "--input-json", JSON.stringify({ text: "ODINN_POST_ROLLBACK_OK" }), "--state", rollbackState], rollbackWorkspace, { INIT_CWD: rollbackWorkspace });
    if (!smoke.includes("ODINN_POST_ROLLBACK_OK")) throw new Error("post-rollback deterministic smoke failed");
    return { rollbackVerified: true, postRollbackOnboarding: true, postRollbackSmoke: true };
  });
  const report = { schemaVersion: 1, package: pkg.name, version: pkg.version, commit: manifest.commit, archive: basename(archive), durationMs: Date.now() - startedAt, restartCount: steps.filter((step) => step.name.includes("restart")).length, recoveredJobs: steps.find((step) => step.name === "recovered-job-state")?.recoveredJobs ?? 0, unresolvedApprovals: steps.find((step) => step.name === "browser-interruption-recovery-block")?.unresolvedApprovals ?? 0, auditVerification: steps.find((step) => step.name === "audit-integrity-and-persisted-output")?.auditVerification ?? false, browserRecoveryBlocked: steps.find((step) => step.name === "browser-interruption-recovery-block")?.browserRecoveryBlocked ?? false, rollbackVerified: steps.find((step) => step.name === "installer-upgrade-rollback")?.rollbackVerified ?? false, finalState: "passed", steps };
  await writeFile(join(releaseDir, "soak-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { schemaVersion: 1, package: pkg.name, version: pkg.version, commit: manifest.commit, archive: basename(archive), durationMs: Date.now() - startedAt, restartCount: steps.filter((step) => step.name.includes("restart")).length, recoveredJobs: steps.find((step) => step.name === "recovered-job-state")?.recoveredJobs ?? 0, unresolvedApprovals: 0, auditVerification: false, browserRecoveryBlocked: false, rollbackVerified: false, finalState: "failed", steps };
  await writeFile(join(releaseDir, "soak-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  await close(provider);
  await rm(temp, { recursive: true, force: true });
}
