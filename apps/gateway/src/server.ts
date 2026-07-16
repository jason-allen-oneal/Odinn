import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApprovalStore, createAuditStore, createBuiltInRegistry, createDifferentiatedRuntime, createIsolatedTaskExecutor, ExtensionRegistry, JobSupervisor, listConfiguredModels, normalizeExperimentalFlags, normalizeModelConfig, normalizeSelfImprovementConfig, oauthTokenPath, ProofVerifier, runTask as executeTask, toolSafetyDescriptor, validatePolicy } from "@odinn/kernel";
import { createDefaultPolicy } from "@odinn/policy";
import { FileJobStore, ensureSecureStateDirectory } from "@odinn/store-file";

const DEFAULT_REQUEST_MAX_BYTES = 65_536;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

function createQuotaGate(value: any = {}) {
  const maximumActiveJobs = Math.max(1, Number(value.maximumActiveJobs ?? 8));
  const maximumBrowserActionsPerHour = Math.max(1, Number(value.maximumBrowserActionsPerHour ?? 200));
  const maximumModelCallsPerHour = Math.max(1, Number(value.maximumModelCallsPerHour ?? 120));
  const maximumModelTokensPerDay = Math.max(1_000, Number(value.maximumModelTokensPerDay ?? 2_000_000));
  const browserActions: number[] = [];
  const modelCalls: number[] = [];
  const tokenUsage: Array<{ at: number; tokens: number }> = [];
  const prune = (entries: number[], horizon: number) => {
    const cutoff = Date.now() - horizon;
    while (entries[0] !== undefined && entries[0] < cutoff) entries.shift();
  };
  return {
    maximumActiveJobs,
    checkTool(tool: string) {
      if (String(tool).startsWith("browser.") && !["browser.tabs", "browser.snapshot", "browser.recovery.status"].includes(tool)) {
        prune(browserActions, 60 * 60 * 1000);
        if (browserActions.length >= maximumBrowserActionsPerHour) throw new GatewayError(429, "tenant browser-action quota exceeded");
        browserActions.push(Date.now());
      }
      if (["model.chat", "agent.run"].includes(tool)) {
        prune(modelCalls, 60 * 60 * 1000);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        while (tokenUsage[0] && tokenUsage[0].at < cutoff) tokenUsage.shift();
        if (modelCalls.length >= maximumModelCallsPerHour) throw new GatewayError(429, "tenant model-call quota exceeded");
        if (tokenUsage.reduce((sum, item) => sum + item.tokens, 0) >= maximumModelTokensPerDay) throw new GatewayError(429, "tenant model-token quota exceeded");
        modelCalls.push(Date.now());
      }
    },
    recordUsage(tool: string, usage: any) {
      if (!["model.chat", "agent.run"].includes(tool)) return;
      const tokens = Number(usage?.totalTokens ?? usage?.total_tokens ?? 0);
      if (Number.isFinite(tokens) && tokens > 0) tokenUsage.push({ at: Date.now(), tokens });
    }
  };
}

class GatewayError extends Error {
  status: number;
  constructor(status: any, message: any) {
    super(message);
    this.status = status;
  }
}

class CronStore {
  path: string;
  writeChain: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.path = path; }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return value?.schemaVersion === 1 && Array.isArray(value.jobs) ? value : { schemaVersion: 1, jobs: [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: 1, jobs: [] };
      throw error;
    }
  }
  async list() { return (await this.read()).jobs.sort((left: any, right: any) => String(left.name).localeCompare(String(right.name))); }
  async mutate(operation: (jobs: any[]) => any) {
    const pending = this.writeChain.then(async () => {
      const state = await this.read();
      const result = await operation(state.jobs);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      return result;
    });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
  async create(input: any) {
    return this.mutate((jobs) => {
      const job = normalizeCronJob({ ...input, id: input.id || `cron_${randomBytes(8).toString("hex")}`, createdAt: new Date().toISOString() });
      if (jobs.some((item) => item.id === job.id)) throw new GatewayError(409, "cron job id already exists");
      jobs.push(job);
      return job;
    });
  }
  async update(id: string, patch: any) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      jobs[index] = normalizeCronJob({ ...jobs[index], ...patch, id, updatedAt: new Date().toISOString() });
      return jobs[index];
    });
  }
  async remove(id: string) {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) throw new GatewayError(404, "cron job not found");
      jobs.splice(index, 1);
    });
  }
  async nextWake() {
    const enabled = (await this.list()).filter((job: any) => job.enabled);
    const values = enabled.map((job: any) => nextCronWake(job.schedule, job.timezone)).filter(Boolean).sort();
    return values[0] ?? null;
  }
}

class AgentPackageStore {
  path: string;
  writeChain: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.path = path; }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return value?.schemaVersion === 1 && Array.isArray(value.agents) ? value : { schemaVersion: 1, agents: [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: 1, agents: [] };
      throw error;
    }
  }
  async list() { return (await this.read()).agents; }
  async mutate(operation: (agents: any[]) => any) {
    const pending = this.writeChain.then(async () => {
      const state = await this.read();
      const result = await operation(state.agents);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      return result;
    });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
  async install(input: any) {
    const manifest = validateAgentPackage(input);
    return this.mutate((agents) => {
      const current = agents.find((agent) => agent.id === manifest.id);
      const record = { ...manifest, status: "disabled", installedAt: new Date().toISOString(), previousVersion: current?.version };
      const index = agents.findIndex((agent) => agent.id === manifest.id);
      if (index >= 0) agents[index] = record; else agents.push(record);
      return record;
    });
  }
  async transition(id: string, action: string) {
    return this.mutate((agents) => {
      const agent = agents.find((item) => item.id === id);
      if (!agent) throw new GatewayError(404, "agent package not found");
      if (!['enable', 'disable', 'quarantine'].includes(action)) throw new GatewayError(400, "unsupported agent lifecycle action");
      agent.status = action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'quarantined';
      agent.updatedAt = new Date().toISOString();
      return agent;
    });
  }
}

function validateAgentPackage(input: any) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GatewayError(400, "agent package manifest must be an object");
  const id = String(input.id || "").trim();
  const version = String(input.version || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id)) throw new GatewayError(400, "agent id must be lowercase and 2-64 characters");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new GatewayError(400, "agent version must be semantic");
  const manifest = {
    sdkVersion: String(input.sdkVersion || "0.3"), id, version,
    name: String(input.name || id).slice(0, 120),
    identity: input.identity && typeof input.identity === "object" ? input.identity : {},
    instructions: Array.isArray(input.instructions) ? input.instructions.map(String) : [],
    tools: Array.isArray(input.tools) ? input.tools.map(String) : [],
    plugins: Array.isArray(input.plugins) ? input.plugins.map(String) : [],
    secrets: Array.isArray(input.secrets) ? input.secrets.map(String) : [],
    sandbox: input.sandbox && typeof input.sandbox === "object" ? input.sandbox : { mode: "workspace-write" },
    network: input.network && typeof input.network === "object" ? input.network : { default: "deny", allow: [] },
    schedules: Array.isArray(input.schedules) ? input.schedules : [],
    channels: Array.isArray(input.channels) ? input.channels : [],
    memory: input.memory && typeof input.memory === "object" ? input.memory : {},
    tests: Array.isArray(input.tests) ? input.tests : []
  };
  const integrity = createHash("sha256").update(stableManifestJson(manifest)).digest("hex");
  if (input.integrity && input.integrity !== integrity) throw new GatewayError(400, "agent package integrity mismatch");
  return { ...manifest, integrity, validation: { valid: true, checkedAt: new Date().toISOString() } };
}

function stableManifestJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableManifestJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableManifestJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

async function discoverSkills(root: string, state: string) {
  const results: any[] = [];
  const roots = [root, join(state, "skill-workshop")];
  const walk = async (directory: string, depth: number) => {
    if (depth > 5 || results.length >= 250) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        const content = await readFile(path, "utf8");
        const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(content)?.[1] || "";
        const name = /^name:\s*["']?([^\n"']+)/mu.exec(frontmatter)?.[1]?.trim() || path.split(sep).at(-2) || "skill";
        const description = /^description:\s*["']?([^\n"']+)/mu.exec(frontmatter)?.[1]?.trim() || "No description";
        results.push({ id: createHash("sha256").update(path).digest("hex").slice(0, 16), name, description, path, bytes: Buffer.byteLength(content), status: path.startsWith(join(state, "skill-workshop")) ? "draft" : "ready" });
      }
    }
  };
  for (const directory of roots) await walk(directory, 0);
  return results;
}

function validateSkillDraft(input: any) {
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const instructions = String(input.instructions || "").trim();
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(name)) errors.push("name must be 2-64 lowercase letters, digits, or hyphens");
  if (description.length < 12) errors.push("description must explain when the skill applies");
  if (instructions.length < 40) errors.push("instructions must contain an actionable workflow");
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${instructions}\n`;
  return { valid: errors.length === 0, errors, content, digest: createHash("sha256").update(content).digest("hex") };
}

function normalizeCronJob(value: any) {
  const schedule = String(value.schedule || "").trim();
  if (!cronParts(schedule)) throw new GatewayError(400, "cron schedule must contain five valid fields");
  const tool = String(value.tool || "agent.run").trim();
  if (!tool) throw new GatewayError(400, "cron job requires a tool");
  return {
    ...value,
    schemaVersion: 1,
    id: String(value.id),
    name: String(value.name || value.id).trim().slice(0, 120),
    schedule,
    timezone: String(value.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    enabled: value.enabled !== false,
    tool,
    input: value.input && typeof value.input === "object" ? value.input : {},
    updatedAt: value.updatedAt || new Date().toISOString()
  };
}

function cronParts(schedule: string) {
  const parts = schedule.split(/\s+/u);
  if (parts.length !== 5 || parts.some((part) => !/^(?:\*|\*\/\d+|\d+(?:,\d+)*)$/u.test(part))) return null;
  return parts;
}

function cronFieldMatches(field: string, value: number) {
  if (field === "*") return true;
  if (field.startsWith("*/")) return value % Number(field.slice(2)) === 0;
  return field.split(",").map(Number).includes(value);
}

function cronDateParts(date: Date, timezone = "UTC") {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return { minute: Number(values.minute), hour: Number(values.hour), day: Number(values.day), month: Number(values.month), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday) };
}

function cronMatches(schedule: string, date: Date, timezone = "UTC") {
  const parts = cronParts(schedule);
  const local = cronDateParts(date, timezone);
  return Boolean(parts && cronFieldMatches(parts[0], local.minute) && cronFieldMatches(parts[1], local.hour) && cronFieldMatches(parts[2], local.day) && cronFieldMatches(parts[3], local.month) && cronFieldMatches(parts[4], local.weekday));
}

function nextCronWake(schedule: string, timezone = "UTC") {
  const candidate = new Date();
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    if (cronMatches(schedule, candidate, timezone)) return candidate.toISOString();
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

async function runCronJob(store: CronStore, id: string, executor: any) {
  const job = (await store.list()).find((item: any) => item.id === id);
  if (!job) throw new GatewayError(404, "cron job not found");
  const startedAt = new Date().toISOString();
  try {
    const result = await executor({ task: { id: `${job.id}:${Date.now()}`, tool: job.tool, input: job.input, actor: "cron", reason: `cron:${job.id}` } });
    await store.update(id, { lastRunAt: startedAt, lastStatus: "ok", lastError: "", lastMinuteKey: startedAt.slice(0, 16) });
    return result;
  } catch (error) {
    await store.update(id, { lastRunAt: startedAt, lastStatus: "error", lastError: error instanceof Error ? error.message : String(error), lastMinuteKey: startedAt.slice(0, 16) });
    throw error;
  }
}

async function runDueCronJobs(store: CronStore, executor: any) {
  const now = new Date();
  const minuteKey = now.toISOString().slice(0, 16);
  for (const job of await store.list()) {
    if (job.enabled && job.lastMinuteKey !== minuteKey && cronMatches(job.schedule, now, job.timezone)) await runCronJob(store, job.id, executor).catch(() => undefined);
  }
}

export async function createGatewayServer({
  stateDir = ".odinn",
  workspaceRoot = process.cwd(),
  requestMaxBytes = DEFAULT_REQUEST_MAX_BYTES,
  quotas = {}
}: any = {}) {
  const state = resolve(stateDir);
  const root = resolve(workspaceRoot);
  await ensureSecureStateDirectory(state);
  const config = await readConfig(state);
  const featureFlags = normalizeExperimentalFlags(config.experimental);
  const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: root, featureFlags });
  const auditStore = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  const policy = createDefaultPolicy(config.policy);
  const approvalStore = createApprovalStore({ path: join(state, "approvals.json") });
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: state, config, approvalStore, auditStore });
  const gatewayToken = await loadGatewayToken(state);
  const isolatedTaskExecutor = createIsolatedTaskExecutor({ stateDir: state, workspaceRoot: root, config, policy });
  const proofVerifier = new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: root, allowedCommands: config.proof?.allowedCommands ?? [] });
  const supervisor = new JobSupervisor({
    store: new FileJobStore(join(state, "jobs.json")),
    execute: isolatedTaskExecutor
  });
  const runTask = (request: any): Promise<any> => isolatedTaskExecutor(request) as Promise<any>;
  const quotaGate = createQuotaGate(quotas);
  const cronStore = new CronStore(join(state, "cron-jobs.json"));
  const agentStore = new AgentPackageStore(join(state, "agents.json"));
  const extensionRegistry = new ExtensionRegistry(join(state, "extensions.json"));
  await supervisor.start();
  const cronTimer = setInterval(() => runDueCronJobs(cronStore, isolatedTaskExecutor).catch(() => undefined), 30_000);
  cronTimer.unref();
  const selfImprovement = normalizeSelfImprovementConfig(config.selfImprovement);
  const improvementTimer = selfImprovement.enabled && selfImprovement.mode === "auto"
    ? setInterval(() => runTask({ task: { tool: "improve.learn", input: { limit: 1000 }, actor: "autonomous-controller" } }).catch(() => undefined), selfImprovement.intervalMs)
    : undefined;
  improvementTimer?.unref?.();

  const server: any = createServer(async (request: any, response: any) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!validHostHeader(request)) return json(response, 421, { ok: false, error: "invalid gateway Host header" });
      if (request.method === "GET" && url.pathname === "/odinn-logo.png") {
        return image(response, 200, await readFile(join(PUBLIC_DIR, "odinn-logo.png")), "image/png");
      }
      if (request.method === "GET" && url.pathname === "/") {
        return html(response, 200, renderConsoleHtml(), {
          "set-cookie": `odinn_gateway_token=${encodeURIComponent(gatewayToken)}; HttpOnly; SameSite=Strict; Path=/`,
          "x-odinn-auth": "bootstrap-cookie"
        });
      }
      if (process.env.ODINN_GATEWAY_AUTH !== "off" && !authorizedRequest(request, gatewayToken)) {
        return json(response, 401, { ok: false, error: "gateway authentication required" });
      }
      const authentication = process.env.ODINN_GATEWAY_AUTH === "off" ? "disabled" : authenticationMode(request, gatewayToken);
      if (isMutatingMethod(request.method) && !validMutationOrigin(request, authentication)) {
        return json(response, 403, { ok: false, error: "origin rejected for control-plane mutation" });
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return json(response, 200, {
          ok: true,
          state,
          workspaceRoot: root,
          tools: Array.from(registry.keys()),
          toolDetails: Array.from(registry.entries()).map(([name, tool]: any) => ({
            name,
            capability: tool.capability,
            description: tool.description
          })),
          allowedCapabilities: policy.allowedCapabilities,
          defaultModel: normalizeModelConfig(config).defaultModel,
          models: listConfiguredModels(normalizeModelConfig(config)),
          providers: await summarizeProviders(config, state),
          experimental: featureFlags,
          security: policy.security,
          selfImprovement,
          pendingApprovals: approvalStore.list()
        });
      }
      if (request.method === "GET" && url.pathname === "/agents") {
        return json(response, 200, { agents: await agentStore.list(), sdkVersion: "0.3" });
      }
      if (request.method === "POST" && url.pathname === "/agents/validate") {
        return json(response, 200, { ok: true, manifest: validateAgentPackage(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "POST" && url.pathname === "/agents") {
        return json(response, 200, { ok: true, agent: await agentStore.install(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "POST" && url.pathname.startsWith("/agents/") && url.pathname.endsWith("/lifecycle")) {
        const id = decodeURIComponent(url.pathname.slice("/agents/".length, -"/lifecycle".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, { ok: true, agent: await agentStore.transition(id, body.action) });
      }
      if (request.method === "GET" && url.pathname === "/skills") {
        const [files, extensions] = await Promise.all([discoverSkills(root, state), extensionRegistry.list()]);
        return json(response, 200, { skills: [...files, ...extensions.filter((extension: any) => extension.type === "skill").map((extension: any) => ({ ...extension, status: extension.enabled ? "ready" : "disabled", path: extension.entrypoint }))] });
      }
      if (request.method === "POST" && url.pathname === "/skills/workshop/validate") {
        return json(response, 200, validateSkillDraft(await readJson(request, { maxBytes: requestMaxBytes })));
      }
      if (request.method === "POST" && url.pathname === "/skills/workshop/save") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const validation = validateSkillDraft(body);
        if (!validation.valid) throw new GatewayError(400, validation.errors.join("; "));
        const directory = join(state, "skill-workshop", body.name);
        await mkdir(directory, { recursive: true });
        const path = join(directory, "SKILL.md");
        await writeFile(path, validation.content, { mode: 0o600 });
        return json(response, 200, { ok: true, path, digest: validation.digest, status: "draft" });
      }
      if (request.method === "GET" && url.pathname === "/runtime/runs") {
        return json(response, 200, runtime.ledger.listRuns({ limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10) }));
      }
      if (request.method === "GET" && url.pathname.startsWith("/runtime/runs/") && url.pathname.endsWith("/verify")) {
        const runId = decodeURIComponent(url.pathname.slice("/runtime/runs/".length, -"/verify".length));
        return json(response, 200, runtime.ledger.verify(runId));
      }
      if (request.method === "GET" && url.pathname.startsWith("/runtime/runs/")) {
        const runId = decodeURIComponent(url.pathname.slice("/runtime/runs/".length));
        const run = runtime.ledger.getRun(runId);
        return run ? json(response, 200, run) : json(response, 404, { ok: false, error: "runtime run not found" });
      }
      if (request.method === "POST" && url.pathname === "/proof") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await proofVerifier.verify(body));
      }
      if (request.method === "GET" && url.pathname.startsWith("/proof/")) {
        const runId = decodeURIComponent(url.pathname.slice("/proof/".length));
        return json(response, 200, { runId, assertions: runtime.proof.show(runId) });
      }
      if (request.method === "POST" && url.pathname === "/policy/evaluate") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        validatePolicy(body.policy);
        const runId = body.runId ?? `policy-${randomBytes(12).toString("hex")}`;
        runtime.ledger.ensureRun({ runId, objective: "policy evaluation" });
        return json(response, 200, runtime.sentinel.evaluate({ runId, stepId: body.stepId, toolName: body.toolName, input: body.input ?? {}, policy: body.policy, workspaceRoot: root }));
      }
      if (request.method === "POST" && url.pathname === "/capabilities/issue") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        runtime.ledger.ensureRun({ runId: body.runId, objective: body.objective ?? `capability: ${body.toolName}` });
        return json(response, 200, runtime.capabilities.issue(body));
      }
      if (request.method === "POST" && url.pathname === "/capabilities/use") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, runtime.capabilities.consume(body.token, body));
      }
      if (request.method === "GET" && url.pathname.startsWith("/capabilities/")) {
        const runId = decodeURIComponent(url.pathname.slice("/capabilities/".length));
        return json(response, 200, runtime.capabilities.list(runId));
      }
      if (request.method === "POST" && url.pathname.startsWith("/capabilities/") && url.pathname.endsWith("/revoke")) {
        const capabilityId = decodeURIComponent(url.pathname.slice("/capabilities/".length, -"/revoke".length));
        return json(response, 200, runtime.capabilities.revoke(capabilityId));
      }
      if (request.method === "POST" && url.pathname === "/checkpoints") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        runtime.ledger.ensureRun({ runId: body.runId, objective: body.objective ?? "checkpoint" });
        return json(response, 200, runtime.snapshots.create({ ...body, workspaceRoot: root }));
      }
      if (request.method === "POST" && url.pathname.startsWith("/rewind/")) {
        const snapshotId = decodeURIComponent(url.pathname.slice("/rewind/".length));
        return json(response, 200, runtime.snapshots.restore(snapshotId, { apply: (await readJson(request, { maxBytes: requestMaxBytes })).apply === true }));
      }
      if (request.method === "POST" && url.pathname === "/capsules/export") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const output = body.output ? safeCapsulePath(state, body.output) : join(state, "capsules", `${body.runId}.odinn`);
        return json(response, 200, await runtime.capsules.export(body.runId, { ...body, output }));
      }
      if (request.method === "POST" && url.pathname === "/capsules/verify") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.capsules.verify(safeCapsulePath(state, body.path)));
      }
      if (request.method === "POST" && url.pathname === "/capsules/replay") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.capsules.replay(safeCapsulePath(state, body.path), { mode: body.mode, workspace: body.workspace }));
      }
      if (request.method === "POST" && url.pathname === "/counterfactual") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.counterfactual.create({ ...body, workspaceRoot: root }));
      }
      if (request.method === "GET" && url.pathname.startsWith("/counterfactual/")) {
        if (url.pathname.endsWith("/execute")) return json(response, 405, { ok: false, error: "counterfactual execute requires POST" });
        const groupId = decodeURIComponent(url.pathname.slice("/counterfactual/".length));
        return json(response, 200, runtime.counterfactual.compare(groupId));
      }
      if (request.method === "POST" && url.pathname.startsWith("/counterfactual/") && url.pathname.endsWith("/execute")) {
        const groupId = decodeURIComponent(url.pathname.slice("/counterfactual/".length, -"/execute".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.counterfactual.execute(groupId, {
          capabilities: runtime.capabilities,
          proof: {
            run: async (runId: string, contract: any) => proofVerifier.verify({ ...contract, runId })
          },
          policy,
          executor: (task: any, context: any) => isolatedTaskExecutor({ task, workspaceRoot: context.workspaceRoot })
        }));
      }
      if (request.method === "POST" && url.pathname.startsWith("/counterfactual/") && url.pathname.endsWith("/select")) {
        const groupId = decodeURIComponent(url.pathname.slice("/counterfactual/".length, -"/select".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await runtime.counterfactual.select(groupId, body.runId, { apply: body.apply === true }));
      }
      if (request.method === "POST" && url.pathname === "/routing/observe") {
        return json(response, 200, runtime.darwin.observe(await readJson(request, { maxBytes: requestMaxBytes })));
      }
      if (request.method === "GET" && url.pathname === "/routing/stats") {
        return json(response, 200, runtime.darwin.stats(url.searchParams.get("taskClass") ?? "general"));
      }
      if (request.method === "POST" && url.pathname === "/routing/choose") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, runtime.darwin.choose(body.taskClass ?? "general", { pinnedModel: body.pinnedModel }));
      }
      if (request.method === "GET" && url.pathname === "/runs") {
        return json(response, 200, await auditStore.readRuns());
      }
      if (request.method === "GET" && url.pathname.startsWith("/runs/")) {
        const id = decodeURIComponent(url.pathname.slice("/runs/".length));
        const run = await auditStore.readRun(id);
        return run ? json(response, 200, run) : json(response, 404, { ok: false, error: "run not found" });
      }
      if (request.method === "POST" && url.pathname.startsWith("/runs/") && url.pathname.endsWith("/replay")) {
        const id = decodeURIComponent(url.pathname.slice("/runs/".length, -"/replay".length));
        const original = await auditStore.readRun(id);
        const started = original?.events?.find((event: any) => event.type === "task.started");
        if (!original || !started?.tool || !started.data?.input) return json(response, 409, { ok: false, error: "run has no replayable task input" });
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const replayId = body.id || request.headers["idempotency-key"] || `${id}:replay:${Date.now()}`;
        return json(response, 200, await isolatedTaskExecutor({
          task: { id: replayId, tool: started.tool, input: started.data.input, actor: "gateway-replay", reason: `replay:${id}` },
        }));
      }
      if (request.method === "GET" && url.pathname === "/jobs") {
        return json(response, 200, { jobs: await supervisor.list() });
      }
      if (request.method === "GET" && url.pathname === "/cron") {
        return json(response, 200, { enabled: true, jobs: await cronStore.list(), nextWake: await cronStore.nextWake() });
      }
      if (request.method === "POST" && url.pathname === "/cron") {
        return json(response, 200, { ok: true, job: await cronStore.create(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "PATCH" && url.pathname.startsWith("/cron/")) {
        const id = decodeURIComponent(url.pathname.slice("/cron/".length));
        return json(response, 200, { ok: true, job: await cronStore.update(id, await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/cron/")) {
        const id = decodeURIComponent(url.pathname.slice("/cron/".length));
        await cronStore.remove(id);
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname.startsWith("/cron/") && url.pathname.endsWith("/run")) {
        const id = decodeURIComponent(url.pathname.slice("/cron/".length, -"/run".length));
        return json(response, 200, { ok: true, result: await runCronJob(cronStore, id, isolatedTaskExecutor) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
        const id = decodeURIComponent(url.pathname.slice("/jobs/".length));
        const job = await supervisor.get(id);
        return job ? json(response, 200, job) : json(response, 404, { ok: false, error: "job not found" });
      }
      if (request.method === "POST" && url.pathname === "/jobs") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const activeJobs = (await supervisor.list()).filter((job: any) => ["queued", "running"].includes(job.status)).length;
        if (activeJobs >= quotaGate.maximumActiveJobs) throw new GatewayError(429, "tenant active-job quota exceeded");
        const id = body.id || request.headers["idempotency-key"] || undefined;
        const requestHash = hashRequest(body);
        if (id) {
          const existing = await supervisor.get(String(id));
          if (existing) {
            if (existing.requestHash && existing.requestHash !== requestHash) return json(response, 409, { ok: false, error: "idempotency key was already used for a different request" });
            return json(response, 200, { ok: true, replayed: true, job: existing });
          }
        }
        const task = body.task && typeof body.task === "object" ? body.task : body;
        const safety = toolSafetyDescriptor(task.tool, registry.get(task.tool));
        const job = await supervisor.submit(
          { task: { ...task, ...(id ? { id: String(id) } : {}) } },
          { id: id ? String(id) : undefined, requestHash, timeoutMs: body.timeoutMs, retrySafe: safety.retrySafe === true }
        );
        return json(response, 202, { ok: true, job });
      }
      if (request.method === "POST" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/cancel")) {
        const id = decodeURIComponent(url.pathname.slice("/jobs/".length, -"/cancel".length));
        return json(response, 200, { ok: true, job: await supervisor.cancel(id) });
      }
      if (request.method === "GET" && url.pathname === "/audit") {
        return json(response, 200, await auditStore.readAll());
      }
      if (request.method === "GET" && url.pathname === "/events") {
        return streamAuditEvents(request, response, auditStore, url);
      }
      if (request.method === "GET" && url.pathname === "/approvals") {
        return json(response, 200, approvalStore.list());
      }
      if (request.method === "POST" && url.pathname.startsWith("/approvals/") && url.pathname.endsWith("/approve")) {
        const id = decodeURIComponent(url.pathname.slice("/approvals/".length, -"/approve".length));
        const pending = approvalStore.claim(id);
        if (!pending) return json(response, 404, { ok: false, error: "approval not found or expired" });
        return json(response, 200, await isolatedTaskExecutor({
          task: { id: pending.runId ?? `approval:${id}`, tool: pending.tool, input: { ...pending.input, confirmed: true }, actor: "user-approved", reason: "explicit user approval" },
        }));
      }
      if (request.method === "GET" && url.pathname === "/memory") {
        const query = url.searchParams.get("query") ?? "";
        const kind = url.searchParams.get("kind") ?? "";
        const subject = url.searchParams.get("subject") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runTask({
          task: { tool: "memory.search", input: { query, kind, subject, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/recall") {
        const query = url.searchParams.get("query") ?? "";
        const kind = url.searchParams.get("kind") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "8", 10);
        return json(response, 200, (await runTask({
          task: { tool: "memory.recall", input: { query, kind, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/browse") {
        const namespace = url.searchParams.get("namespace") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        return json(response, 200, (await runTask({
          task: { tool: "memory.browse", input: { namespace, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname.startsWith("/memory/") && !["/memory/recall", "/memory/browse", "/memory/curated"].includes(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice("/memory/".length));
        return json(response, 200, (await runTask({
          task: { tool: "memory.open", input: { id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/memory/compact") {
        return json(response, 200, (await runTask({
          task: { tool: "memory.compact", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/curated") {
        return json(response, 200, (await runTask({
          task: { tool: "memory.curate", input: {}, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/memory") {
        return json(response, 200, (await runTask({
          task: { tool: "memory.remember", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/memory/corrections") {
        return json(response, 200, (await runTask({
          task: { tool: "memory.correct", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/sessions") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runTask({
          task: { tool: "session.list", input: { limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        return json(response, 200, (await runTask({
          task: { tool: "session.create", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "PATCH" && url.pathname.startsWith("/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
        return json(response, 200, (await runTask({
          task: { tool: "session.rename", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
        return json(response, 200, (await runTask({
          task: { tool: "session.delete", input: { sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname.startsWith("/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
        return json(response, 200, (await runTask({
          task: { tool: "session.read", input: { sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/messages")) {
        const id = decodeURIComponent(url.pathname.slice("/sessions/".length, -"/messages".length));
        return json(response, 200, (await runTask({
          task: { tool: "session.message", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), sessionId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/goals") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runTask({
          task: { tool: "goal.list", input: { limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/goals") {
        return json(response, 200, (await runTask({
          task: { tool: "goal.create", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/goals/") && url.pathname.endsWith("/updates")) {
        const id = decodeURIComponent(url.pathname.slice("/goals/".length, -"/updates".length));
        return json(response, 200, (await runTask({
          task: { tool: "goal.update", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), goalId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/improvements") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runTask({
          task: { tool: "improve.list", input: { limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/improvements") {
        return json(response, 200, (await runTask({
          task: { tool: "improve.propose", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/improvements/learn") {
        return json(response, 200, (await runTask({
          task: { tool: "improve.learn", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/improvements/") && url.pathname.endsWith("/decisions")) {
        const id = decodeURIComponent(url.pathname.slice("/improvements/".length, -"/decisions".length));
        return json(response, 200, (await runTask({
          task: { tool: "improve.decide", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), improvementId: id }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/improvements/") && url.pathname.endsWith("/rollback")) {
        const id = decodeURIComponent(url.pathname.slice("/improvements/".length, -"/rollback".length));
        return json(response, 200, (await runTask({
          task: { tool: "improve.rollback", input: { improvementId: id, source: "gateway" }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname === "/run/stream") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        quotaGate.checkTool(body.tool);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        const controller = new AbortController();
        request.once("aborted", () => controller.abort(new Error("client disconnected")));
        response.once("close", () => { if (!response.writableEnded) controller.abort(new Error("client disconnected")); });
        const sendEvent = (event: string, value: any) => response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
        try {
          const result = await executeTask({
            task: { ...body, id: body.id ?? request.headers["idempotency-key"], actor: body.actor ?? "gateway" },
            auditStore,
            policy,
            registry,
            signal: controller.signal,
            runLedger: runtime.ledger,
            onModelDelta: (delta: string) => sendEvent("delta", { delta })
          });
          quotaGate.recordUsage(body.tool, result.output?.usage);
          sendEvent("result", result);
        } catch (error) {
          sendEvent("error", { error: error instanceof Error ? error.message : String(error) });
        } finally {
          response.end();
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/run") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        quotaGate.checkTool(body.tool);
        const result = await runTask({
          task: { ...body, id: body.id ?? request.headers["idempotency-key"], actor: body.actor ?? "gateway" },
          auditStore,
          policy,
          registry
        });
        quotaGate.recordUsage(body.tool, result.output?.usage);
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/plan") {
        const plan = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, await isolatedTaskExecutor({
          plan: { ...plan, id: plan.id ?? request.headers["idempotency-key"], actor: "gateway" }
        }));
      }
      return json(response, 404, { ok: false, error: "not found" });
    } catch (error: any) {
      return json(response, error.status ?? 400, { ok: false, error: error.message });
    }
  });

  const close = server.close.bind(server);
  server.close = (callback: any) => {
    if (improvementTimer) clearInterval(improvementTimer);
    clearInterval(cronTimer);
    Promise.allSettled([supervisor.shutdown(), isolatedTaskExecutor.shutdown?.()])
      .then(() => close(callback))
      .catch((error: any) => callback?.(error));
    return server;
  };
  server.on("close", () => supervisor.shutdown().catch(() => undefined));
  server.on("close", () => runtime.ledger.close());
  server.odinnAuthToken = gatewayToken;
  return server;
}

async function loadGatewayToken(state: any) {
  const path = join(state, "gateway.token");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(state, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 }).catch(async (error: any) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await chmod(path, 0o600);
  return (await readFile(path, "utf8")).trim();
}

function authorizedRequest(request: any, expectedToken: any) {
  return authenticationMode(request, expectedToken) !== undefined;
}

function authenticationMode(request: any, expectedToken: any): "bearer" | "cookie" | undefined {
  const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
  const cookie = String(request.headers.cookie ?? "").split(";").map((item: any) => item.trim()).find((item: any) => item.startsWith("odinn_gateway_token="))?.slice("odinn_gateway_token=".length) ?? "";
  let decodedCookie = "";
  try { decodedCookie = decodeURIComponent(cookie); } catch { return undefined; }
  for (const [mode, presented] of [["bearer", bearer], ["cookie", decodedCookie]] as const) {
    if (!presented || presented.length !== expectedToken.length) continue;
    if (timingSafeEqual(Buffer.from(presented), Buffer.from(expectedToken))) return mode;
  }
  return undefined;
}

function isMutatingMethod(method: any) {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method);
}

function validMutationOrigin(request: any, authentication: "bearer" | "cookie" | "disabled" | undefined) {
  if (authentication === "disabled") return true;
  if (!authentication) return false;
  const origin = request.headers.origin;
  if (authentication === "bearer" && !origin) return true;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const expected = `http://${String(request.headers.host ?? "").trim().toLowerCase()}`;
    if (parsed.origin.toLowerCase() !== expected || !validLoopbackHost(parsed.host)) return false;
    const fetchSite = String(request.headers["sec-fetch-site"] ?? "").toLowerCase();
    return !fetchSite || fetchSite === "same-origin" || authentication === "bearer";
  } catch { return false; }
}

function validHostHeader(request: any) {
  const host = request.headers.host;
  return typeof host === "string" && validLoopbackHost(host);
}

function validLoopbackHost(value: any) {
  const host = String(value || "").trim().toLowerCase();
  const match = host.match(/^([^:]+)(?::\d{1,5})?$/) || host.match(/^(\[[0-9a-f:]+\])(?::\d{1,5})?$/);
  if (!match) return false;
  return new Set(["localhost", "127.0.0.1", "[::1]"]).has(match[1]);
}

function hashRequest(value: any) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: any): any {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function safeCapsulePath(state: any, candidate: any) {
  const capsulesRoot = resolve(join(state, "capsules"));
  const target = resolve(capsulesRoot, candidate);
  if (target !== capsulesRoot && !target.startsWith(`${capsulesRoot}${sep}`)) {
    throw new GatewayError(400, "capsule paths must remain inside the gateway capsule store");
  }
  return target;
}

async function streamAuditEvents(request: any, response: any, auditStore: any, url: any) {
  const initial = Number.parseInt(request.headers["last-event-id"] ?? url.searchParams.get("since") ?? "-1", 10);
  let cursor = Number.isFinite(initial) ? Math.max(-1, initial) : -1;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff"
  });
  response.write("retry: 1000\n\n");
  const poll = setInterval(async () => {
    try {
      const events = await auditStore.readAll();
      for (let index = cursor + 1; index < events.length; index += 1) {
        response.write(`id: ${index}\ndata: ${JSON.stringify(events[index])}\n\n`);
      }
      cursor = events.length - 1;
    } catch (error: any) {
      response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    }
  }, 500);
  request.on("close", () => clearInterval(poll));
}

async function readConfig(state: any) {
  const path = join(state, "config.json");
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    await chmod(path, 0o600);
    return config;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(state, { recursive: true });
    const config = { version: 1, policy: createDefaultPolicy(), auditLog: "audit.jsonl", providers: {}, defaultModel: "", experimental: { proof: false, rewind: false, sentinel: false, capsules: false, darwin: false, capabilities: false, counterfactual: false }, selfImprovement: normalizeSelfImprovementConfig() };
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch((writeError: any) => {
      if (writeError?.code !== "EEXIST") throw writeError;
    });
    await chmod(path, 0o600);
    return config;
  }
}

async function readJson(request: any, { maxBytes = DEFAULT_REQUEST_MAX_BYTES }: any = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new GatewayError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new GatewayError(400, "request body must be valid JSON");
  }
}

function json(response: any, status: any, body: any) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function html(response: any, status: any, body: any, extraHeaders: any = {}) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(body);
}

function image(response: any, status: any, body: any, contentType: any) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

async function summarizeProviders(config: any, state: any) {
  return Promise.all(Object.entries(config.providers ?? {}).map(async ([name, provider]: any) => ({
    name,
    type: provider.type ?? "openai-compatible",
    baseUrl: provider.baseUrl,
    authMode: provider.auth?.mode ?? "api-key",
    apiKeyEnv: provider.apiKeyEnv ?? "",
    models: provider.models ?? [],
    configured: provider.auth?.mode === "oauth"
      ? await oauthTokenExists(provider, state)
      : !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv])
  })));
}

async function oauthTokenExists(provider: any, state: any) {
  try {
    await access(oauthTokenPath(provider, state));
    return true;
  } catch {
    return false;
  }
}

function renderConsoleHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ódinn Forge Console</title>
  <meta name="application-name" content="Odinn Forge Console">
  <link rel="icon" type="image/png" href="/odinn-logo.png">
  <style>
    :root {
      color-scheme: dark;
      --bg: #090c11;
      --surface: #11161e;
      --surface-2: #171d27;
      --surface-3: #202938;
      --line: #26303d;
      --line-soft: #1d2530;
      --text: #edf2f8;
      --muted: #8996a8;
      --accent: #7de0bd;
      --blue: #8baeff;
      --danger: #ff6b7a;
      --warn: #e8c96a;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body.soft-contrast {
      --bg: #0b0f15;
      --surface: #151c26;
      --surface-2: #202a37;
      --line: #425066;
      --line-soft: #354256;
      --muted: #b0bbca;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
      font-size: 14px;
    }
    button, select, textarea, input {
      border: 1px solid var(--line);
      background: #11151c;
      color: var(--text);
      border-radius: 6px;
      font: inherit;
    }
    button {
      cursor: pointer;
      min-height: 34px;
      padding: 7px 11px;
      background: #1f6f5d;
      border-color: #2f8b75;
      font-size: 13px;
      font-weight: 700;
    }
    button:hover { filter: brightness(1.08); }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    button.secondary {
      background: #202734;
      border-color: var(--line);
      color: #dbe3ee;
    }
    button.danger {
      background: #47202a;
      border-color: #7d3444;
      color: #ffdce2;
    }
    input, select {
      width: 100%;
      min-height: 36px;
      padding: 0 10px;
    }
    textarea {
      width: 100%;
      min-height: 138px;
      padding: 10px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      color: #d7dee9;
    }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 18px; }
    h2 { font-size: 15px; }
    h3 { font-size: 13px; }
    label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .shell {
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr);
      grid-template-rows: 56px minmax(0, 1fr);
      grid-template-areas:
        "nav topbar"
        "nav content";
      height: 100vh;
    }
    .sidebar {
      grid-area: nav;
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-width: 0;
      border-right: 1px solid var(--line);
      background: #0d1117;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 56px;
      padding: 0 15px;
      border-bottom: 1px solid var(--line);
    }
    .mark {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 10px;
      overflow: hidden;
      background: #07111f;
      border: 1px solid #34516e;
      box-shadow: 0 0 0 3px rgba(125, 224, 189, .05);
    }
    .mark img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .brand-title {
      min-width: 0;
    }
    .brand-tools {
      display: flex;
      align-items: center;
      margin-left: auto;
    }
    .sidebar-icon-button {
      display: inline-grid;
      place-items: center;
      width: 30px;
      min-height: 30px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: #8794a8;
    }
    .sidebar-icon-button:hover {
      border-color: var(--line);
      background: var(--surface-2);
      color: var(--text);
    }
    .brand-title strong,
    .brand-title span {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .brand-title span {
      color: var(--muted);
      font-size: 11px;
    }
    .nav {
      display: grid;
      align-content: start;
      gap: 3px;
      padding: 12px 9px;
      overflow: auto;
    }
    .nav button {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 10px;
      width: 100%;
      min-height: 40px;
      padding: 7px 9px;
      background: transparent;
      border-color: transparent;
      border-radius: 10px;
      color: #dfe6f0;
      text-align: left;
    }
    .nav button:hover {
      background: var(--surface-2);
      border-color: var(--line-soft);
    }
    .nav button.active {
      background: rgba(45, 124, 102, .18);
      border-color: rgba(91, 194, 160, .42);
      color: var(--accent);
    }
    .icon {
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      border: 1px solid #2b3544;
      border-radius: 8px;
      background: #151b24;
      color: var(--muted);
    }
    .icon-svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .nav button.active .icon {
      border-color: rgba(91, 194, 160, .55);
      color: var(--accent);
      background: #102820;
    }
    .nav-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .nav button .badge { margin-left: auto; }
    .nav-group-label {
      padding: 14px 9px 5px;
      color: #657286;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .menu-chats {
      display: grid;
      gap: 6px;
      margin: 5px 0 2px;
      padding: 0 0 10px;
      border-bottom: 1px solid var(--line-soft);
    }
    .menu-chat {
      display: grid;
      gap: 3px;
      padding: 8px;
      border: 1px solid transparent;
      border-radius: 9px;
      background: transparent;
      color: var(--text);
      cursor: pointer;
    }
    .menu-chat-main {
      min-width: 0;
    }
    .menu-chat-actions {
      display: flex;
      gap: 3px;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .menu-chat:hover .menu-chat-actions,
    .menu-chat:focus-within .menu-chat-actions,
    .menu-chat.active .menu-chat-actions {
      opacity: 1;
    }
    .chat-action,
    .session-action {
      min-width: 22px;
      min-height: 22px;
      padding: 2px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font-size: 14px;
      line-height: 1;
    }
    .chat-action:hover,
    .session-action:hover {
      color: var(--text);
      border-color: var(--accent);
      background: var(--surface-2);
    }
    .chat-action.delete:hover,
    .session-action.delete:hover {
      color: #ff9a9a;
      border-color: #9d4c55;
    }
    .session-record {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }
    .session-record-body {
      min-width: 0;
      flex: 1;
    }
    .menu-chat:hover {
      background: #151c26;
      border-color: #273342;
    }
    .menu-chat.active {
      background: rgba(44, 113, 94, .19);
      border-color: rgba(91, 194, 160, .35);
    }
    .menu-chat strong,
    .menu-chat span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .menu-chat strong {
      font-size: 12px;
    }
    .menu-chat span {
      color: var(--muted);
      font-size: 11px;
    }
    .sidebar-footer {
      display: grid;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--line);
    }
    .sidebar-footer button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .topbar {
      grid-area: topbar;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      padding: 0 14px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--bg) 84%, transparent);
    }
    .topbar-title {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .topbar-title strong,
    .topbar-title span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .topbar-title span {
      color: var(--muted);
      font-size: 12px;
    }
    .content {
      grid-area: content;
      min-width: 0;
      overflow: auto;
      padding: 14px;
    }
    .view { display: none; }
    .view.active { display: block; }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .layout-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
      gap: 12px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--surface);
      border-radius: 8px;
      padding: 12px;
      min-width: 0;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .stack { display: grid; gap: 12px; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .field { display: grid; gap: 6px; }
    .muted { color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 22px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #102820;
      color: var(--accent);
      border: 1px solid #245849;
      font-size: 11px;
      font-weight: 700;
    }
    .pill.warn {
      background: #2d2914;
      border-color: #655722;
      color: var(--warn);
    }
    .pill.danger {
      background: #321821;
      border-color: #703141;
      color: var(--danger);
    }
    .badge,
    .chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 20px;
      padding: 2px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #171d27;
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 750;
      white-space: nowrap;
    }
    .chip.ok,
    .badge.ok {
      border-color: #245849;
      background: #102820;
      color: var(--accent);
    }
    .chip.warn,
    .badge.warn {
      border-color: #655722;
      background: #2d2914;
      color: var(--warn);
    }
    .chip.danger,
    .badge.danger {
      border-color: #703141;
      background: #321821;
      color: var(--danger);
    }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .metric {
      display: grid;
      gap: 5px;
      min-height: 78px;
      padding: 12px;
      border: 1px solid var(--line);
      background: var(--surface);
      border-radius: 8px;
    }
    .metric strong { font-size: 24px; line-height: 1; }
    .metric span { color: var(--muted); font-size: 12px; }
    .list { display: grid; gap: 8px; }
    .item {
      display: grid;
      gap: 5px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #121720;
      min-width: 0;
    }
    .item.clickable { cursor: pointer; }
    .item.clickable:hover { border-color: #456071; background: #161d27; }
    .item.active {
      border-color: #2b6a5b;
      background: #132421;
    }
    .item-line {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .item-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
      overflow-x: auto;
    }
    .tabs button {
      min-width: max-content;
      background: #202734;
      border-color: var(--line);
    }
    .tabs button.active {
      background: #182a28;
      border-color: #2b6a5b;
      color: var(--accent);
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 0.75fr);
      gap: 12px;
    }
    .chat-shell {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      height: calc(100vh - 76px);
      min-height: 560px;
      overflow: hidden;
    }
    .chat-shell > * {
      min-height: 0;
      overflow: hidden;
    }
    .chat-column {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 10px;
    }
    .chat-thread {
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0c0f14;
    }
    .message {
      display: grid;
      gap: 5px;
      max-width: 82%;
      padding: 10px 12px;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      background: #151b24;
    }
    .message.user {
      align-self: flex-end;
      background: #172a28;
      border-color: #285f52;
    }
    .message.assistant {
      align-self: flex-start;
    }
    .message.system {
      align-self: center;
      max-width: 100%;
      background: transparent;
      color: var(--muted);
    }
    .message-role {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .composer {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    .composer textarea {
      min-height: 92px;
      max-height: 220px;
      font-family: inherit;
      font-size: 14px;
    }
    .session-list {
      display: grid;
      gap: 6px;
      min-height: 0;
      overflow: auto;
    }
    .chat-shell > .stack {
      min-height: 0;
      overflow: auto;
      align-content: start;
    }
    .breadcrumb-line {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: var(--muted);
      font-size: 13px;
    }
    .breadcrumb-line strong {
      color: var(--text);
      font-weight: 750;
    }
    .breadcrumb-line .current {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .breadcrumb-sep {
      color: var(--line);
    }
    .topbar-context {
      display: block;
      overflow: hidden;
      color: var(--muted);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #chat-subtitle,
    #workspace {
      display: none;
    }
    .chat-shell {
      height: calc(100vh - 76px);
      min-height: 0;
      margin: -14px;
    }
    .chat-column {
      grid-template-rows: 1fr auto;
      gap: 0;
    }
    .chat-thread {
      border: 0;
      border-radius: 0;
      background: transparent;
      align-items: stretch;
      gap: 4px;
      padding: 36px 24px 24px;
    }
    .chat-thread > * {
      width: min(100%, 820px);
      margin-right: auto;
      margin-left: auto;
    }
    .chat-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: min(520px, 62vh);
      gap: 12px;
      text-align: center;
    }
    .chat-avatar {
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      margin-bottom: 2px;
      overflow: hidden;
      border: 1px solid #2d5c88;
      border-radius: 14px;
      background: #07111f;
    }
    .chat-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .chat-empty h1 {
      font-size: 22px;
    }
    .chat-empty p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }
    .chat-empty code {
      padding: 2px 6px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--text);
    }
    .chat-prompts {
      display: grid;
      grid-template-columns: repeat(2, minmax(180px, 1fr));
      gap: 8px;
      width: min(100%, 520px);
      margin-top: 4px;
    }
    .chat-prompt {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
    }
    .chat-prompt:hover {
      border-color: #456071;
      background: var(--surface-2);
    }
    .message {
      width: min(100%, 820px);
      max-width: 820px;
      padding: 12px 0;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .message.user {
      width: fit-content;
      max-width: min(74%, 620px);
      margin-right: max(0px, calc((100% - 820px) / 2));
      margin-left: auto;
      padding: 10px 13px;
      border: 1px solid #285f52;
      border-radius: 14px;
      background: #172a28;
    }
    .message.assistant {
      align-self: center;
    }
    .message-role {
      font-size: 10px;
      letter-spacing: 0;
    }
    .composer {
      width: min(100% - 32px, 768px);
      margin: 0 auto 14px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--surface);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
    }
    .composer textarea {
      min-height: 50px;
      max-height: 160px;
      padding: 9px 8px;
      border: 0;
      background: transparent;
      resize: none;
      font-family: inherit;
      font-size: 14px;
    }
    .composer textarea:focus {
      outline: 0;
    }
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding-top: 7px;
      border-top: 1px solid var(--line-soft);
    }
    .composer-tools {
      min-width: 0;
    }
    .composer-tools select {
      width: auto;
      min-width: 160px;
      min-height: 30px;
      padding: 0 8px;
      border-color: transparent;
      background: transparent;
      font-size: 11px;
      font-weight: 700;
    }
    .composer-tools .chip {
      min-height: 20px;
    }
    .send-action {
      min-width: 62px;
      min-height: 32px;
      padding: 5px 10px;
      border-radius: 9px;
    }
    .chat-status {
      font-size: 11px;
    }
    .runtime-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 12px;
      align-items: start;
    }
    .status-completed { color: var(--accent); }
    .status-failed, .status-denied { color: var(--danger); }
    .status-running { color: var(--warn); }
    .output {
      max-height: 420px;
      overflow: auto;
      border: 1px solid var(--line-soft);
      border-radius: 6px;
      background: #0c0f14;
      padding: 10px;
    }
    .page {
      max-width: 1240px;
      margin: 0 auto;
      display: grid;
      gap: 14px;
    }
    .page-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .page-head p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
    .stat-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .stat-card {
      display: grid;
      gap: 5px;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: linear-gradient(145deg, #171d27, #121720);
    }
    .stat-card strong { font-size: 23px; line-height: 1; }
    .stat-card span { color: var(--muted); font-size: 11px; }
    .section-kicker { color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .toolbar input { width: min(300px, 100%); }
    .record-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .record-grid .item { min-height: 98px; }
    .timeline { display: grid; gap: 0; }
    .timeline-row { display: grid; grid-template-columns: 12px 1fr; gap: 10px; padding: 0 0 14px; }
    .timeline-dot { width: 10px; height: 10px; margin-top: 4px; border: 2px solid var(--accent); border-radius: 50%; background: var(--bg); }
    .timeline-row:not(:last-child) .timeline-dot::after { content: ""; display: block; width: 1px; height: 68px; margin: 6px 0 0 2px; background: var(--line); }
    .empty-state { display: grid; place-items: center; gap: 8px; min-height: 180px; padding: 20px; border: 1px dashed var(--line); border-radius: 10px; color: var(--muted); text-align: center; }
    .empty-state strong { color: var(--text); }
    .provider-card { display: grid; gap: 9px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: #121720; }
    .provider-card .provider-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .markdown-body { color: #e7edf5; font-size: 14px; line-height: 1.62; overflow-wrap: anywhere; }
    .markdown-body > :first-child { margin-top: 0; }
    .markdown-body > :last-child { margin-bottom: 0; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { margin: 1.1em 0 .45em; color: #f5f8fc; line-height: 1.25; }
    .markdown-body h1 { font-size: 1.35em; }
    .markdown-body h2 { font-size: 1.15em; }
    .markdown-body h3, .markdown-body h4 { font-size: 1em; }
    .markdown-body p { margin: .65em 0; }
    .markdown-body ul, .markdown-body ol { margin: .65em 0; padding-left: 1.45em; }
    .markdown-body li + li { margin-top: .25em; }
    .markdown-body blockquote { margin: .75em 0; padding: .25em .9em; border-left: 3px solid var(--accent); color: #b7c2d1; background: #121a20; }
    .markdown-body code { padding: .12em .35em; border: 1px solid var(--line); border-radius: 5px; background: #10151d; color: #b8e5d8; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; }
    .markdown-body pre { margin: .8em 0; padding: 12px; overflow: auto; border: 1px solid #293747; border-radius: 8px; background: #090d13; color: #d9e5f0; }
    .markdown-body pre code { padding: 0; border: 0; background: transparent; color: inherit; }
    .markdown-body a { color: #8db8ff; text-decoration: underline; text-decoration-color: #42699b; text-underline-offset: 2px; }
    .markdown-body hr { border: 0; border-top: 1px solid var(--line); margin: 1em 0; }
    .markdown-body table { width: 100%; margin: .8em 0; border-collapse: collapse; font-size: .92em; }
    .markdown-body th, .markdown-body td { padding: 7px 9px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
    .markdown-body th { background: #17202b; color: #f2f6fa; }
    .markdown-body .task-list-item { list-style: none; margin-left: -1.25em; }
    .markdown-body .task-list-item input { width: auto; min-height: auto; margin-right: 6px; accent-color: var(--accent); }
    .message-assistant-head { display: flex; align-items: center; gap: 8px; }
    .message-avatar { display: grid; place-items: center; width: 24px; height: 24px; overflow: hidden; border: 1px solid #2d5c88; border-radius: 8px; background: #07111f; }
    .message-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .sidebar-toggle {
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      width: 32px;
      min-height: 32px;
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 9px;
      background: #151b24;
      color: var(--muted);
    }
    .sidebar-toggle:hover { color: var(--text); background: var(--surface-2); }
    .shell.sidebar-collapsed { grid-template-columns: 68px minmax(0, 1fr); }
    .shell.sidebar-collapsed .brand { justify-content: center; padding: 0; }
    .shell.sidebar-collapsed .brand-title,
    .shell.sidebar-collapsed .brand-tools,
    .shell.sidebar-collapsed .nav-label,
    .shell.sidebar-collapsed .nav-group-label,
    .shell.sidebar-collapsed .menu-chats,
    .shell.sidebar-collapsed .sidebar-footer { display: none; }
    .shell.sidebar-collapsed .nav { padding: 12px 10px; }
    .shell.sidebar-collapsed .nav button { justify-content: center; padding: 7px; }
    .shell.sidebar-collapsed .nav button .badge { display: none; }
    .shell.sidebar-collapsed .nav button { position: relative; }
    .shell.sidebar-collapsed .nav button:hover::after {
      content: attr(data-title);
      position: absolute;
      z-index: 20;
      left: 54px;
      top: 50%;
      transform: translateY(-50%);
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #111822;
      color: var(--text);
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
      box-shadow: 0 8px 20px rgba(0, 0, 0, .3);
      pointer-events: none;
    }
    .capability-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
    .capabilities-page .stat-card strong { font-size: 17px; letter-spacing: .04em; }
    .browser-page-panel { padding: 10px; background: #0d1219; }
    .browser-page-text { max-height: 260px; overflow: auto; color: #cbd5e1; line-height: 1.55; }
    .browser-tab { cursor: pointer; }
    .browser-tab:hover { border-color: var(--accent); }
    .web-result a { color: var(--blue); font-weight: 750; }
    .web-result p { margin: 0; color: var(--muted); line-height: 1.45; }
    .approval-card { border-color: #735f25; background: #211e12; }
    .approval-card .approval-summary { color: #f3dda0; }

    /* Chat surface polish: keep the workspace quiet and put attention on the conversation. */
    .content {
      padding: 0;
      border: 0;
      border-radius: 0;
      background: #0b0f15;
    }
    .chat-shell {
      height: calc(100vh - 56px);
      min-height: 0;
      margin: 0;
    }
    .chat-thread {
      gap: 0;
      padding: 46px clamp(18px, 7vw, 110px) 140px;
      background: #0b0f15;
      scrollbar-gutter: stable;
    }
    .chat-thread > * {
      width: min(100%, 860px);
    }
    .chat-empty {
      min-height: min(560px, 68vh);
      gap: 10px;
    }
    .chat-empty h1 {
      font-size: 24px;
      letter-spacing: -.02em;
    }
    .chat-avatar {
      width: 44px;
      height: 44px;
      border-radius: 13px;
      border-color: #34516e;
    }
    .chat-prompts {
      width: min(100%, 560px);
      margin-top: 10px;
      gap: 9px;
    }
    .chat-prompt {
      min-height: 42px;
      border-radius: 11px;
      background: #121821;
    }
    .message {
      width: min(100%, 860px);
      max-width: 860px;
      padding: 16px 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      line-height: 1.65;
    }
    .message.user {
      width: fit-content;
      max-width: min(74%, 680px);
      margin-right: max(0px, calc((100% - 860px) / 2));
      padding: 11px 15px;
      border: 1px solid rgba(91, 194, 160, .36);
      border-radius: 16px;
      background: rgba(32, 82, 70, .28);
    }
    .message-role {
      min-height: 24px;
      font-size: 10px;
      letter-spacing: .04em;
    }
    .message-assistant-head {
      gap: 8px;
      color: #dce7f2;
      text-transform: none;
      letter-spacing: 0;
    }
    .message-avatar {
      width: 24px;
      height: 24px;
      border-radius: 8px;
    }
    .composer {
      width: min(calc(100% - 40px), 820px);
      margin: 0 auto 18px;
      padding: 8px 9px 9px;
      border: 1px solid #303b4b;
      border-radius: 17px;
      background: #151b24;
      box-shadow: 0 16px 40px rgba(0, 0, 0, .28), 0 0 0 1px rgba(255, 255, 255, .02) inset;
    }
    .composer textarea {
      min-height: 56px;
      padding: 11px 10px;
    }
    .composer-footer {
      padding: 4px 2px 0;
      border-top: 0;
    }
    .composer-tools select {
      min-width: 150px;
      font-size: 12px;
    }
    .send-action {
      min-width: 72px;
      min-height: 34px;
      border-radius: 10px;
    }
    .nav-group-label {
      padding-top: 12px;
    }
    .nav-more { margin: 4px 0 2px; }
    .nav-more summary { display: flex; align-items: center; justify-content: space-between; padding: 10px 11px 5px; color: #66758b; cursor: pointer; list-style: none; text-transform: uppercase; }
    .nav-more summary::-webkit-details-marker { display: none; }
    .nav-more summary .nav-group-label { padding: 0; }
    .nav-chevron { color: #8b98aa; font-size: 15px; transition: transform .15s ease; }
    .nav-more:not([open]) .nav-chevron { transform: rotate(-90deg); }
    .shell.sidebar-collapsed .nav-more summary { justify-content: center; padding: 10px 0 5px; }
    .shell.sidebar-collapsed .nav-more summary .nav-group-label { display: none; }
    .shell.sidebar-collapsed .nav-more summary .nav-chevron { display: none; }
    .menu-chat {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 2px 6px;
      border-radius: 9px;
    }
    .menu-chat-actions {
      grid-column: 2;
      grid-row: 1;
      align-self: center;
    }
    .menu-chat:hover .menu-chat-actions,
    .menu-chat:focus-within .menu-chat-actions,
    .menu-chat.active .menu-chat-actions {
      opacity: .9;
    }
    .menu-chat-actions .chat-action {
      color: #8492a5;
    }
    .menu-chat-actions .chat-action:hover {
      color: var(--text);
      background: #263141;
    }
    .menu-chat-actions .chat-action.delete:hover {
      color: #ff9a9a;
      background: #3a2029;
    }
    .session-rail-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 2px 1px;
      color: #718096;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .session-rail-label span:last-child { color: #526176; font-weight: 600; letter-spacing: 0; text-transform: none; }
    .rail-count { font-variant-numeric: tabular-nums; }
    .pinned-list:empty::after {
      display: block;
      padding: 4px 8px 7px;
      color: #536175;
      content: "No pinned sessions";
      font-size: 11px;
    }
    .sidebar-footer-tools {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 3px;
    }
    .sidebar-status {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 2px 4px 0;
      color: #69788c;
      font-size: 10px;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #55d391;
      box-shadow: 0 0 0 3px rgba(85, 211, 145, .1);
    }
    .sidebar-version { margin-left: auto; color: #4f5d70; font-variant-numeric: tabular-nums; }

    @media (max-width: 980px) {
      body { overflow: auto; }
      .shell {
        min-height: 100vh;
        height: 100vh;
        grid-template-columns: 1fr;
        grid-template-rows: auto auto 1fr;
        grid-template-areas:
          "topbar"
          "nav"
          "content";
      }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .topbar {
        min-height: 52px;
        padding: 7px 10px;
      }
      .topbar-title {
        overflow: hidden;
      }
      .breadcrumb-line {
        font-size: 12px;
      }
      .topbar .row {
        flex-wrap: nowrap;
      }
      #copy-status,
      #quick-smoke {
        display: none;
      }
      #health {
        min-height: 20px;
        padding: 2px 7px;
        font-size: 10px;
      }
      .brand, .sidebar-footer { display: none; }
      .nav {
        display: flex;
        overflow-x: auto;
        max-height: 154px;
        align-items: flex-start;
      }
      .nav button { width: auto; min-width: max-content; }
      .nav button .badge { display: none; }
      .menu-chats {
        display: grid;
        flex: 0 0 268px;
        max-height: 150px;
        margin: 0;
        padding: 4px 0 8px;
      }
      .menu-chats .session-list {
        max-height: 102px;
      }
      .menu-chat {
        width: 250px;
      }
      .overview-grid, .layout-grid, .split, .grid-2, .chat-shell, .stat-strip, .record-grid {
        grid-template-columns: 1fr;
      }
      .content {
        min-height: 0;
        padding: 0;
        overflow: hidden;
      }
      .view.active {
        height: 100%;
      }
      .chat-shell {
        height: 100%;
        min-height: 0;
        overflow: visible;
        margin: 0;
      }
      .chat-shell > * {
        overflow: hidden;
      }
      .chat-column {
        min-height: 0;
      }
      .chat-thread {
        padding: 24px 14px 18px;
      }
      .chat-empty {
        min-height: 0;
        height: 100%;
      }
      .message { max-width: 94%; }
      .message.user { max-width: 88%; margin-right: 0; }
      .chat-prompts { grid-template-columns: 1fr; width: min(100%, 360px); }
      .composer { width: calc(100% - 20px); margin-bottom: 10px; }
    }
    @media (max-width: 980px) {
      .chat-thread { padding: 28px 14px 122px; }
      .chat-thread > * { width: 100%; }
      .message.user { max-width: 88%; margin-right: 0; }
      .composer { width: calc(100% - 20px); margin-bottom: 10px; }
    }
    .oc-page { max-width: 1320px; }
    .oc-page .page-head h1 { color: #ff6969; }
    .summary-bar { display: flex; align-items: center; gap: 34px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: #151a22; }
    .summary-bar span { display: flex; align-items: center; gap: 10px; }
    .summary-bar small { color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
    .summary-bar strong { color: var(--text); }
    .table-panel { padding: 14px 18px; }
    .data-table { min-width: 760px; overflow-x: auto; }
    .data-row { display: grid; grid-template-columns: minmax(260px, 2fr) 110px 120px 130px minmax(120px, 1fr) 160px; align-items: center; gap: 12px; min-height: 58px; padding: 8px 10px; border-bottom: 1px solid #242b35; }
    .data-row:last-child { border-bottom: 0; }
    .data-head { min-height: 40px; color: var(--muted); background: #171c24; font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    .session-table .data-row { grid-template-columns: minmax(280px, 2fr) 90px 100px 110px 120px 90px 150px; }
    .data-primary { display: grid; gap: 4px; min-width: 0; }
    .data-primary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .data-primary small { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count-badge { display: inline-grid; place-items: center; min-width: 24px; height: 24px; border-radius: 999px; background: #222936; color: var(--muted); font-size: 12px; }
    .session-filters { display: grid; grid-template-columns: minmax(260px, 1fr) 170px 170px; gap: 10px; padding: 12px 0; }
    .session-detail { margin-top: 14px; }
    .usage-grid, .agent-layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(320px, .8fr); gap: 14px; }
    .bar-chart { display: flex; align-items: end; gap: 8px; min-height: 220px; padding-top: 20px; }
    .bar-column { display: grid; flex: 1; grid-template-rows: 1fr auto; align-items: end; gap: 8px; height: 190px; text-align: center; color: var(--muted); font-size: 10px; }
    .bar-column i { display: block; width: 100%; min-height: 3px; border-radius: 5px 5px 2px 2px; background: linear-gradient(180deg, #58c9ac, #277d69); }
    .cron-card { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--line); border-radius: 11px; background: #12171f; }
    .cron-card .cron-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; }
    .editor-dialog { width: min(760px, calc(100vw - 40px)); padding: 0; border: 1px solid var(--line); border-radius: 14px; background: #11161e; color: var(--text); }
    .editor-dialog::backdrop { background: rgba(0, 0, 0, .68); }
    .editor-dialog form { display: grid; gap: 14px; padding: 20px; }
    .editor-dialog textarea { min-height: 150px; }
    .manifest-editor, .workshop-editor { min-height: 320px !important; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .danger-button { border-color: #71323c; background: #351b22; color: #ff9da8; }
    .agent-package { cursor: pointer; }
    .agent-package.selected { border-color: var(--accent); background: #14231f; }
    .agent-inspector { display: grid; gap: 12px; }
    .agent-section { padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #0d1218; }
    .activity-event { border-left: 3px solid #456071; }
    .activity-event.error { border-left-color: #d86a78; }
    .activity-summary { margin: 8px 0 0; color: var(--text); line-height: 1.45; }
    .activity-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    .activity-meta span { color: var(--muted); font-size: 12px; }
    .activity-details { margin-top: 10px; }
    .activity-details summary { color: var(--muted); cursor: pointer; font-size: 12px; }
    .manifest-fields { display: grid; gap: 12px; }
    .manifest-advanced { border-top: 1px solid var(--line); padding-top: 12px; }
    .skill-card { min-height: 150px; }
    .skill-path { word-break: break-all; }
    @media (max-width: 900px) {
      .usage-grid, .agent-layout, .workshop-grid { grid-template-columns: 1fr; }
      .session-filters { grid-template-columns: 1fr; }
      .summary-bar { align-items: flex-start; flex-direction: column; gap: 10px; }
    }
  </style>
</head>
<body>
  <svg aria-hidden="true" width="0" height="0" style="position:absolute">
    <symbol id="icon-chat" viewBox="0 0 24 24"><path d="M5 6.5h14v9H9l-4 3v-12z"></path><path d="M8 10h8M8 13h5"></path></symbol>
    <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></symbol>
    <symbol id="icon-tool" viewBox="0 0 24 24"><path d="m14.5 6.5 3-3 3 3-3 3"></path><path d="m17.5 6.5-7 7"></path><path d="m6 15-3 3 3 3 3-3"></path><path d="m6 18 7-7"></path></symbol>
    <symbol id="icon-plan" viewBox="0 0 24 24"><path d="M6 4h12v16H6z"></path><path d="M9 8h6M9 12h6M9 16h4"></path></symbol>
    <symbol id="icon-memory" viewBox="0 0 24 24"><path d="M8 5h8v14H8z"></path><path d="M5 8h3M5 12h3M5 16h3M16 8h3M16 12h3M16 16h3"></path></symbol>
    <symbol id="icon-session" viewBox="0 0 24 24"><path d="M5 5h14v14H5z"></path><path d="M8 9h8M8 13h6M8 17h4"></path></symbol>
    <symbol id="icon-goal" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="3"></circle><path d="m17 7 3-3M17 4h3v3"></path></symbol>
    <symbol id="icon-spark" viewBox="0 0 24 24"><path d="m12 3 1.5 6.5L20 12l-6.5 1.5L12 20l-1.5-6.5L4 12l6.5-2.5z"></path></symbol>
    <symbol id="icon-audit" viewBox="0 0 24 24"><path d="M6 4h12v16H6z"></path><path d="M9 8h6M9 12h6M9 16h3"></path><path d="m14 16 1.5 1.5L19 14"></path></symbol>
    <symbol id="icon-runtime" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M8 9h2M14 9h2M8 13h2M14 13h2M8 17h8"></path></symbol>
    <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M19 8a7 7 0 0 0-12-1L5 9"></path><path d="M5 5v4h4M5 16a7 7 0 0 0 12 1l2-2"></path><path d="M19 19v-4h-4"></path></symbol>
    <symbol id="icon-edit" viewBox="0 0 24 24"><path d="m5 16-.7 3.7L8 19l10.5-10.5a2.1 2.1 0 0 0-3-3L5 16z"></path><path d="m14 7 3 3"></path></symbol>
    <symbol id="icon-trash" viewBox="0 0 24 24"><path d="M5 7h14M10 4h4l1 3H9l1-3zM8 10v7M12 10v7M16 10v7M7 7l1 13h8l1-13"></path></symbol>
    <symbol id="icon-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"></path></symbol>
    <symbol id="icon-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"></circle><path d="M4 12h16M12 4c2 2.2 3 4.9 3 8s-1 5.8-3 8c-2-2.2-3-4.9-3-8s1-5.8 3-8z"></path></symbol>
    <symbol id="icon-activity" viewBox="0 0 24 24"><path d="M4 12h4l2-6 4 12 2-6h4"></path></symbol>
    <symbol id="icon-servers" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="6" rx="1"></rect><rect x="4" y="14" width="16" height="6" rx="1"></rect><path d="M7 7h.01M7 17h.01M10 7h7M10 17h7"></path></symbol>
    <symbol id="icon-usage" viewBox="0 0 24 24"><path d="M5 19V9M12 19V5M19 19v-7"></path><path d="M3 19h18"></path></symbol>
    <symbol id="icon-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path></symbol>
    <symbol id="icon-agent" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"></circle><path d="M5 20c.6-3.5 2.9-5 7-5s6.4 1.5 7 5M12 3v2"></path></symbol>
    <symbol id="icon-skill" viewBox="0 0 24 24"><path d="m12 3 2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4z"></path><path d="m18 16 .8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z"></path></symbol>
    <symbol id="icon-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"></circle><path d="m15 15 5 5"></path></symbol>
    <symbol id="icon-settings" viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"></path><circle cx="12" cy="12" r="4"></circle></symbol>
    <symbol id="icon-monitor" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="12" rx="2"></rect><path d="M9 21h6M12 17v4"></path></symbol>
    <symbol id="icon-moon" viewBox="0 0 24 24"><path d="M19 15.5A7.5 7.5 0 0 1 8.5 5 7.5 7.5 0 1 0 19 15.5z"></path></symbol>
  </svg>
  <div class="shell" id="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="mark"><img src="/odinn-logo.png" alt="Ódinn Forge logo"></div>
        <div class="brand-title">
          <strong>Ódinn Forge</strong>
          <span>local gateway</span>
        </div>
        <div class="brand-tools">
          <button class="sidebar-icon-button" id="sidebar-search" title="Search sessions" aria-label="Search sessions" type="button"><svg class="icon-svg"><use href="#icon-search"></use></svg></button>
        </div>
      </div>
      <nav class="nav" aria-label="Console views">
        <button class="active" data-view="overview" data-title="Chat" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-chat"></use></svg></span><span class="nav-label">Chat</span><span class="badge ok" id="nav-health">...</span></button>
        <div class="menu-chats">
        <button class="secondary" id="new-chat" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-plus"></use></svg></span><span class="nav-label">New session</span></button>
          <div class="session-rail-label"><span>Pinned</span><span class="rail-count" id="pinned-count">0</span></div>
          <div id="pinned-chat-list" class="session-list pinned-list"></div>
          <div class="session-rail-label"><span>Sessions</span><span class="rail-count" id="chat-session-count">0</span></div>
          <div id="chat-session-list" class="session-list"></div>
        </div>
        <details class="nav-more" open>
          <summary><span class="nav-group-label">More</span><span class="nav-chevron">⌄</span></summary>
          <button data-view="audit" data-title="Activity" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-activity"></use></svg></span><span class="nav-label">Activity</span></button>
          <button data-view="sessions" data-title="Sessions" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-session"></use></svg></span><span class="nav-label">Sessions</span></button>
          <button data-view="usage" data-title="Usage" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-usage"></use></svg></span><span class="nav-label">Usage</span></button>
          <button data-view="cron" data-title="Cron Jobs" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-clock"></use></svg></span><span class="nav-label">Cron Jobs</span></button>
          <button data-view="tasks" data-title="Tasks" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-tool"></use></svg></span><span class="nav-label">Tasks</span></button>
          <button data-view="agents" data-title="Agents" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-agent"></use></svg></span><span class="nav-label">Agents</span></button>
          <button data-view="skills" data-title="Skills" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-skill"></use></svg></span><span class="nav-label">Skills</span></button>
          <button data-view="workshop" data-title="Skill Workshop" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-spark"></use></svg></span><span class="nav-label">Skill Workshop</span></button>
        </details>
        <div class="nav-group-label nav-advanced-label">Workspace</div>
        <button data-view="memory" data-title="Memory" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-memory"></use></svg></span><span class="nav-label">Memory</span></button>
        <button data-view="goals" data-title="Goals" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-goal"></use></svg></span><span class="nav-label">Goals</span></button>
        <button data-view="audit" data-title="Audit" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-audit"></use></svg></span><span class="nav-label">Audit</span></button>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-footer-tools">
          <button class="sidebar-icon-button" id="sidebar-settings" title="Runtime settings" aria-label="Runtime settings" type="button"><svg class="icon-svg"><use href="#icon-settings"></use></svg></button>
          <button class="sidebar-icon-button" id="sidebar-console" title="Open runtime" aria-label="Open runtime" type="button"><svg class="icon-svg"><use href="#icon-monitor"></use></svg></button>
          <button class="sidebar-icon-button" id="sidebar-theme" title="Toggle theme" aria-label="Toggle theme" type="button"><svg class="icon-svg"><use href="#icon-moon"></use></svg></button>
          <button class="sidebar-icon-button" id="refresh" title="Refresh" aria-label="Refresh" type="button"><svg class="icon-svg"><use href="#icon-refresh"></use></svg></button>
        </div>
        <div class="sidebar-status"><span class="status-dot"></span><span>Loopback beta</span><span class="sidebar-version">v0.1</span></div>
      </div>
    </aside>

    <header class="topbar">
      <button class="sidebar-toggle" id="sidebar-toggle" type="button" title="Collapse navigation" aria-label="Collapse navigation"><svg class="icon-svg"><use href="#icon-menu"></use></svg></button>
      <div class="topbar-title">
        <div class="breadcrumb-line">
          <strong>Ódinn Forge</strong>
          <span class="breadcrumb-sep">/</span>
          <strong id="view-title">Chat</strong>
          <span class="breadcrumb-sep" id="chat-context-sep">/</span>
          <span class="current" id="chat-title">New chat</span>
        </div>
        <span class="topbar-context" id="chat-subtitle">Local beta adapter</span>
        <span class="topbar-context" id="workspace">Loading local runtime...</span>
      </div>
      <div class="row">
        <span class="pill" id="health">Checking</span>
        <button class="secondary" id="copy-status" title="Copy runtime status" type="button">Status</button>
        <button id="quick-smoke" title="Run a local healthcheck" type="button">Smoke</button>
      </div>
    </header>

    <main class="content">
      <section id="view-overview" class="view active">
        <div class="chat-shell">
          <div class="chat-column">
            <div id="chat-thread" class="chat-thread"></div>
            <div class="composer">
              <textarea id="chat-input" placeholder="Message Ódinn Forge..."></textarea>
              <div class="composer-footer">
                <div class="row composer-tools">
                  <button class="secondary" data-view-jump="tasks" title="Open tasks" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-tool"></use></svg></span></button>
                  <select id="model-select" aria-label="Model">
                    <option value="">Configure a provider first</option>
                  </select>
                  <span class="chip warn" id="model-chip">no model configured</span>
                </div>
                <div class="row">
                  <button class="secondary" id="chat-smoke" title="Run a local healthcheck" type="button">Health</button>
                  <span class="muted chat-status" id="chat-status">Ready</span>
                  <button class="send-action" id="send-chat" title="Send message" type="button">Send</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="view-capabilities" class="view">
        <div class="page capabilities-page">
          <div class="page-head"><div><div class="section-kicker">Agent capability layer</div><h1>Web &amp; browser</h1><p>Search the public web, read pages, and work inside logged-in accounts through an isolated browser profile.</p></div><span class="chip ok">approval-gated</span></div>
          <div class="stat-strip"><div class="stat-card"><strong id="cap-web-status">READY</strong><span>public web access</span></div><div class="stat-card"><strong id="cap-browser-status">READY</strong><span>persistent browser</span></div><div class="stat-card"><strong id="cap-approval-count">0</strong><span>pending approvals</span></div><div class="stat-card"><strong id="cap-security-mode">SAFE</strong><span>default posture</span></div></div>
          <div class="capability-grid">
            <div class="panel stack">
              <div class="panel-head"><div><h2>Search the web</h2><span class="muted">Read-only public search</span></div><button id="web-search-run" type="button">Search</button></div>
              <div class="field"><label for="web-search-query">Query</label><input id="web-search-query" placeholder="Search current information..."></div>
              <div id="web-search-results" class="list"><div class="empty-state"><strong>Nothing searched yet</strong><span>Results will appear here with source links and snippets.</span></div></div>
            </div>
            <div class="panel stack">
              <div class="panel-head"><div><h2>Browser workspace</h2><span class="muted">Separate profile · user login required</span></div><button class="secondary" id="browser-refresh" type="button">Refresh</button></div>
              <div class="field"><label for="browser-url">Open URL</label><div class="row"><input id="browser-url" placeholder="https://example.com"><button id="browser-open" type="button">Open</button></div></div>
              <div id="browser-tabs" class="list"><div class="empty-state"><strong>Browser is waiting</strong><span>Open a site to create the persistent beta profile.</span></div></div>
              <div class="panel browser-page-panel"><div class="panel-head"><h3 id="browser-page-title">No page selected</h3><span class="chip" id="browser-page-url">—</span></div><pre id="browser-page-text" class="browser-page-text">Open or select a tab to inspect visible content.</pre></div>
            </div>
          </div>
          <div class="panel stack">
            <div class="panel-head"><div><h2>External action approvals</h2><span class="muted">Clicks, typing, and key presses stop here until you approve them.</span></div><span class="chip warn">human in the loop</span></div>
            <div id="approval-list" class="list"><div class="empty-state"><strong>No pending actions</strong><span>Ódinn Forge will show approval requests here before changing an external account.</span></div></div>
          </div>
        </div>
      </section>

      <section id="view-tasks" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Proof &amp; execution ledger</div><h1>Tasks</h1><p>Inspect work, verify captured proof, replay safe runs, and resolve failures without exposing an arbitrary tool shell.</p></div><button class="secondary" id="refresh-tasks" type="button">Refresh</button></div>
          <div class="stat-strip"><div class="stat-card"><strong id="task-total">0</strong><span>captured runs</span></div><div class="stat-card"><strong id="task-running">0</strong><span>running</span></div><div class="stat-card"><strong id="task-passed">0</strong><span>completed</span></div><div class="stat-card"><strong id="task-failed">0</strong><span>needs review</span></div></div>
          <div class="panel table-panel"><div class="toolbar"><input id="task-query" placeholder="Filter by run, tool, actor, or status"><div class="chip-row"><button class="secondary task-filter active" data-task-filter="all" type="button">All</button><button class="secondary task-filter" data-task-filter="running" type="button">Running</button><button class="secondary task-filter" data-task-filter="failed" type="button">Failed</button></div></div><div class="data-table"><div class="data-row data-head"><span>Task</span><span>Status</span><span>Actor</span><span>Updated</span><span>Evidence</span><span>Actions</span></div><div id="task-table"></div></div></div>
          <div class="panel stack"><div class="panel-head"><div><h2>Selected evidence</h2><span class="muted" id="task-detail-label">Select a task to inspect its audit and proof record.</span></div><div class="row"><button class="secondary" id="task-verify" type="button" disabled>Verify chain</button><button class="secondary" id="task-replay" type="button" disabled>Replay safe task</button></div></div><pre id="task-evidence" class="output">No task selected.</pre></div>
        </div>
      </section>

      <section id="view-cron" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Scheduled automation</div><h1>Cron Jobs</h1><p>Wakeups and recurring runs.</p></div><div class="row"><button id="new-cron" type="button">New Job</button><button class="secondary" id="refresh-cron" type="button">Refresh</button></div></div>
          <div class="summary-bar"><span><small>ENABLED</small><strong id="cron-enabled">Yes</strong></span><span><small>JOBS</small><strong id="cron-count">0</strong></span><span><small>NEXT WAKE</small><strong id="cron-next">—</strong></span></div>
          <div class="panel stack"><div class="panel-head"><div><h2>Jobs</h2><p class="muted">Persisted in the gateway and evaluated in each job's timezone.</p></div><span class="muted" id="cron-shown">0 shown</span></div><input id="cron-query" placeholder="Filter jobs"><div id="cron-list" class="list"></div></div>
          <dialog id="cron-dialog" class="editor-dialog"><form method="dialog" id="cron-form"><div class="panel-head"><h2>Schedule a job</h2><button class="secondary" value="cancel" type="submit">Close</button></div><div class="grid-2"><div class="field"><label for="cron-name">Name</label><input id="cron-name" required></div><div class="field"><label for="cron-schedule">Cron expression</label><input id="cron-schedule" value="0 9 * * 1" required></div></div><div class="grid-2"><div class="field"><label for="cron-timezone">Timezone</label><input id="cron-timezone" value="America/New_York"></div><div class="field"><label for="cron-tool">Tool</label><select id="cron-tool"></select></div></div><div class="field"><label for="cron-input">Input JSON</label><textarea id="cron-input">{}</textarea></div><div class="row"><button id="save-cron" value="default" type="submit">Save Job</button></div></form></dialog>
        </div>
      </section>

      <section id="view-memory" class="view">
        <div class="page">
          <div class="page-head"><div><div class="section-kicker">Persistent context</div><h1>Memory</h1><p>Search, curate, and correct the facts Ódinn Forge carries between sessions.</p></div><span class="chip ok">provenance tracked</span></div>
          <div class="split">
            <div class="panel stack"><div class="panel-head"><h2>Capture a memory</h2><button id="remember" type="button">Remember</button></div>
            <div class="grid-2">
              <div class="field">
                <label for="memory-kind">Kind</label>
                <select id="memory-kind">
                  <option>preference</option>
                  <option>project</option>
                  <option>person</option>
                  <option>artifact</option>
                  <option>procedure</option>
                  <option>decision</option>
                  <option>system</option>
                </select>
              </div>
              <div class="field">
                <label for="memory-subject">Subject</label>
                <input id="memory-subject" value="beta">
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <label for="memory-namespace">Namespace</label>
                <input id="memory-namespace" value="project/odinn">
              </div>
              <div class="field">
                <label for="memory-tier">Context tier</label>
                <select id="memory-tier"><option value="l0">L0 · summary</option><option value="l1" selected>L1 · fact</option><option value="l2">L2 · evidence</option></select>
              </div>
            </div>
            <div class="field">
              <label for="memory-tags">Tags</label>
              <input id="memory-tags" value="beta,gateway">
            </div>
            <div class="field">
              <label for="memory-text">Text</label>
              <textarea id="memory-text">Gateway beta testing should expose clear run, audit, memory, goal, and improvement paths.</textarea>
            </div>
          </div>
            <div class="panel stack"><div class="panel-head"><h2>Memory browser</h2><input id="memory-query" placeholder="Search subject, text, or tag"></div><div class="chip-row"><span class="chip">L0 summary</span><span class="chip">L1 fact</span><span class="chip">L2 evidence</span></div><div id="memory-list" class="list"></div></div>
          </div>
          <div class="panel stack"><div class="panel-head"><div><h2>Context namespaces</h2><p class="muted">Durable context is organized by scope instead of becoming one undifferentiated memory swamp.</p></div><button class="secondary" id="refresh-memory-tree" type="button">Refresh</button></div><div id="memory-tree" class="record-grid"></div></div>
        </div>
      </section>

      <section id="view-sessions" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Conversation archive</div><h1>Sessions</h1><p>Active sessions and defaults.</p></div><div class="row"><button id="create-session" type="button">New Session</button><button class="secondary" id="refresh-sessions" type="button">Refresh</button></div></div>
          <div class="panel table-panel"><div class="panel-head"><div><h2>Sessions <span class="count-badge" id="session-count-badge">0</span></h2><span class="muted" id="session-page-count">Loading</span></div></div><div class="session-filters"><input id="session-query" placeholder="Filter by key, agent, label, kind..."><select id="session-status-filter"><option value="all">All statuses</option><option value="open">Open</option><option value="archived">Archived</option></select><select id="session-group"><option value="none">Group by None</option><option value="source">Group by source</option><option value="status">Group by status</option></select></div><div class="data-table session-table"><div class="data-row data-head"><span>Session</span><span>Kind</span><span>Status</span><span>Runtime</span><span>Updated</span><span>Messages</span><span>Actions</span></div><div id="session-list"></div></div></div>
          <div class="panel stack session-detail"><div class="panel-head"><h2>Selected transcript</h2><span class="chip" id="selected-session-route">No session selected</span></div><div id="session-transcript" class="timeline"><div class="empty-state"><strong>Select a session</strong><span>Its messages and model route will appear here.</span></div></div></div>
        </div>
      </section>

      <section id="view-goals" class="view">
        <div class="page">
          <div class="page-head"><div><div class="section-kicker">Long-running work</div><h1>Goals</h1><p>Keep objectives visible, update their state, and surface what is blocked.</p></div><span class="chip ok">stateful</span></div>
          <div class="stat-strip"><div class="stat-card"><strong id="goal-active-count">0</strong><span>active</span></div><div class="stat-card"><strong id="goal-blocked-count">0</strong><span>blocked</span></div><div class="stat-card"><strong id="goal-completed-count">0</strong><span>completed</span></div><div class="stat-card"><strong>∞</strong><span>no hard expiry</span></div></div>
          <div class="split">
            <div class="panel stack"><div class="panel-head"><h2>New goal</h2><button id="create-goal" type="button">Create</button></div>
            <div class="field">
              <label for="goal-title">Title</label>
              <input id="goal-title" value="Reach local beta">
            </div>
            <div class="field">
              <label for="goal-note">Update Note</label>
              <input id="goal-note" value="Beta test pass from gateway console.">
            </div>
            <div class="row">
              <select id="goal-status" aria-label="Goal status">
                <option>active</option>
                <option>completed</option>
                <option>blocked</option>
                <option>paused</option>
                <option>cancelled</option>
              </select>
              <button class="secondary" id="update-goal" type="button">Update Selected</button>
            </div>
          </div>
            <div class="panel stack"><div class="panel-head"><h2>Goal board</h2><span class="muted">select a card to update</span></div><div id="goal-list" class="list"></div></div>
          </div>
        </div>
      </section>

      <section id="view-workshop" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Skill authoring pipeline</div><h1>Skill Workshop</h1><p>Draft, validate, and stage a real SKILL.md package. No vague self-improvement theater.</p></div><span class="chip warn" id="workshop-status">not validated</span></div>
          <div class="split workshop-grid"><div class="panel stack"><div class="panel-head"><h2>Skill definition</h2><button id="validate-skill" type="button">Validate</button></div><div class="field"><label for="skill-draft-name">Package name</label><input id="skill-draft-name" value="odinn-operator-workflow"></div><div class="field"><label for="skill-draft-description">Trigger description</label><textarea id="skill-draft-description">Use when an operator needs a repeatable, audited Ódinn Forge workflow.</textarea></div><div class="field"><label for="skill-draft-instructions">Instructions</label><textarea id="skill-draft-instructions" class="workshop-editor">## Workflow\n\n1. Inspect the live state.\n2. Execute the bounded operation.\n3. Capture evidence and verify the result.\n4. Stop on unknown external outcomes.</textarea></div><div class="row"><button id="save-skill-draft" type="button" disabled>Save Draft Package</button><span class="muted">Saved drafts appear in Skills.</span></div></div><div class="panel stack"><div class="panel-head"><h2>Validation report</h2><span class="chip">SKILL.md</span></div><div id="skill-validation" class="empty-state"><strong>Run validation</strong><span>Frontmatter, trigger quality, workflow depth, and digest will appear here.</span></div><pre id="skill-preview" class="output">No generated package.</pre></div></div>
        </div>
      </section>

      <section id="view-audit" class="view">
        <div class="page">
          <div class="page-head"><div><div class="section-kicker">Evidence trail</div><h1>Audit</h1><p>Every tool, model, memory, and state transition leaves a record here.</p></div><div class="row"><button class="secondary" id="refresh-audit" type="button">Refresh</button><button class="secondary" id="copy-audit" type="button">Copy</button></div></div>
          <div class="stat-strip"><div class="stat-card"><strong id="audit-count">0</strong><span>events loaded</span></div><div class="stat-card"><strong id="audit-run-count">0</strong><span>runs</span></div><div class="stat-card"><strong id="audit-model-count">0</strong><span>model calls</span></div><div class="stat-card"><strong id="audit-error-count">0</strong><span>errors</span></div></div>
          <div class="panel stack"><div class="toolbar"><div class="chip-row"><button class="secondary audit-filter active" data-audit-filter="all" type="button">All</button><button class="secondary audit-filter" data-audit-filter="model" type="button">Model</button><button class="secondary audit-filter" data-audit-filter="error" type="button">Errors</button></div><input id="audit-query" placeholder="Filter events"></div><div id="audit-events" class="list"></div><pre id="audit-log" class="output" hidden>No audit loaded.</pre></div>
        </div>
      </section>

      <section id="view-usage" class="view">
        <div class="page oc-page"><div class="page-head"><div><div class="section-kicker">Runtime consumption</div><h1>Usage</h1><p>Model tokens, tool activity, failures, and provider routing from the signed audit trail.</p></div><span class="pill" id="status-pill">Unknown</span></div><div class="stat-strip"><div class="stat-card"><strong id="usage-total-tokens">0</strong><span>total tokens</span></div><div class="stat-card"><strong id="usage-model-calls">0</strong><span>model calls</span></div><div class="stat-card"><strong id="metric-runs">0</strong><span>runs</span></div><div class="stat-card"><strong id="usage-errors">0</strong><span>errors</span></div></div><div class="usage-grid"><div class="panel stack"><div class="panel-head"><h2>Activity by day</h2><span class="muted">last 14 days</span></div><div id="usage-chart" class="bar-chart"></div></div><div class="panel stack"><div class="panel-head"><h2>Provider routes</h2><span class="muted">credentials never shown</span></div><div id="provider-list" class="list"></div></div></div><div class="panel table-panel"><div class="panel-head"><h2>Recent metered runs</h2><button class="secondary" data-view-jump="audit" type="button">Open Audit</button></div><div id="runs" class="list"></div></div><div hidden><span id="metric-tools"></span><span id="metric-completed"></span><span id="metric-policy"></span><span id="runtime-chips"></span><span id="status-workspace"></span><span id="status-state"></span><span id="tool-count"></span><select id="tool"></select><div id="tool-list"></div><div id="run-history"></div><span id="plan-run-count"></span><span id="plan-last-status"></span><div id="plan-runs"></div></div><div class="panel" hidden><button id="clear-output" type="button">Clear</button><pre id="output">Ready.</pre></div></div>
      </section>

      <section id="view-agents" class="view">
        <div class="page oc-page"><div class="page-head"><div><div class="section-kicker">Agent SDK v0.3</div><h1>Agents</h1><p>Create a manifest from the fields below, then validate and install it. Advanced JSON remains available for unusual packages.</p></div><div class="row"><button id="new-agent" type="button">Create Manifest</button><button class="secondary" id="refresh-agents" type="button">Refresh</button></div></div><div class="stat-strip"><div class="stat-card"><strong id="agent-total">0</strong><span>packages</span></div><div class="stat-card"><strong id="agent-enabled">0</strong><span>enabled</span></div><div class="stat-card"><strong id="agent-quarantined">0</strong><span>quarantined</span></div><div class="stat-card"><strong>v0.3</strong><span>SDK contract</span></div></div><div class="agent-layout"><div class="panel stack"><div class="panel-head"><h2>Package registry</h2><input id="agent-query" placeholder="Filter agents"></div><div id="agent-list" class="list"></div></div><div class="panel stack"><div class="panel-head"><h2>Package inspector</h2><span class="chip" id="agent-detail-status">No selection</span></div><div id="agent-detail" class="empty-state"><strong>Select an agent package</strong><span>Identity, instructions, tools, plugins, secrets, sandbox, network, schedules, channels, memory, integrity, and tests will appear here.</span></div><div class="row"><button id="agent-enable" type="button" disabled>Enable</button><button class="secondary" id="agent-disable" type="button" disabled>Disable</button><button class="danger-button" id="agent-quarantine" type="button" disabled>Quarantine</button></div></div></div><dialog id="agent-dialog" class="editor-dialog"><form method="dialog" id="agent-form"><div class="panel-head"><div><h2>Create Agent SDK manifest</h2><span class="muted">New packages install disabled until explicitly enabled.</span></div><button class="secondary" value="cancel" type="submit">Close</button></div><div id="manifest-fields" class="manifest-fields"><div class="grid-2"><div class="field"><label for="agent-id">Package ID</label><input id="agent-id" pattern="[a-z0-9][a-z0-9._-]{1,63}" value="example-agent" required></div><div class="field"><label for="agent-version">Version</label><input id="agent-version" value="1.0.0" required></div></div><div class="field"><label for="agent-name">Display name</label><input id="agent-name" value="Example Agent" required></div><div class="field"><label for="agent-identity">Identity name</label><input id="agent-identity" value="Example"></div><div class="field"><label for="agent-instructions">Instruction files <span class="muted">comma-separated</span></label><input id="agent-instructions" value="AGENTS.md"></div><div class="field"><label for="agent-tools">Tools <span class="muted">comma-separated</span></label><input id="agent-tools" value="workspace.readText"></div><div class="grid-2"><div class="field"><label for="agent-plugins">Plugins <span class="muted">comma-separated</span></label><input id="agent-plugins"></div><div class="field"><label for="agent-secrets">Secret names <span class="muted">comma-separated</span></label><input id="agent-secrets"></div></div><div class="grid-2"><div class="field"><label for="agent-sandbox">Sandbox mode</label><select id="agent-sandbox"><option value="workspace-write">workspace-write</option><option value="workspace-read">workspace-read</option><option value="container">container</option></select></div><div class="field"><label for="agent-network">Network allowlist <span class="muted">comma-separated</span></label><input id="agent-network" placeholder="api.example.com"></div></div></div><div class="manifest-advanced"><label><input type="checkbox" id="agent-advanced-toggle"> Edit full manifest JSON</label><textarea id="agent-manifest" class="manifest-editor" hidden>{"sdkVersion":"0.3","id":"example-agent","version":"1.0.0","name":"Example Agent","identity":{"name":"Example"},"instructions":["AGENTS.md"],"tools":["workspace.readText"],"plugins":[],"secrets":[],"sandbox":{"mode":"workspace-write"},"network":{"default":"deny","allow":[]},"schedules":[],"channels":[],"memory":{},"tests":[]}</textarea></div><div class="row"><button id="validate-agent" value="default" type="submit">Validate &amp; Install</button></div></form></dialog></div>
      </section>

      <section id="view-skills" class="view">
        <div class="page oc-page"><div class="page-head"><div><div class="section-kicker">Capability instructions</div><h1>Skills</h1><p>Discovered SKILL.md packages and installed skill extensions.</p></div><button class="secondary" id="refresh-skills" type="button">Refresh</button></div><div class="panel stack"><div class="toolbar"><input id="skill-query" placeholder="Filter by name, description, status, or path"><div class="chip-row"><button class="secondary skill-filter active" data-skill-filter="all" type="button">All</button><button class="secondary skill-filter" data-skill-filter="ready" type="button">Ready</button><button class="secondary skill-filter" data-skill-filter="draft" type="button">Drafts</button></div></div><div id="skills-list" class="record-grid"></div></div></div>
      </section>
    </main>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const state = {
      status: null,
      runs: [],
      selectedGoalId: "",
      selectedImprovementId: "",
      selectedSessionId: "",
      activeChatId: "",
      messages: [],
      modelOverride: "",
      audit: [],
      auditFilter: "all",
      browserTabId: "",
      taskFilter: "all",
      selectedTaskId: "",
      selectedAgentId: "",
      agents: [],
      skills: [],
      skillFilter: "all"
    };
    const planTemplates = {
      smoke: {
        id: "plan_console_smoke",
        name: "console-smoke",
        steps: [
          { id: "health", tool: "job.healthcheck" },
          { id: "echo", tool: "text.echo", input: { text: "ODINN_CONSOLE_OK" } }
        ]
      },
      readme: {
        id: "plan_console_readme",
        name: "readme-read",
        steps: [
          { id: "readme", tool: "workspace.readText", input: { path: "README.md", maxBytes: 2048 } }
        ]
      }
    };

    async function api(path, options) {
      const response = await fetch(path, options);
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
      return data;
    }

    async function streamApi(path, options, onDelta) {
      const response = await fetch(path, options);
      if (!response.ok || !response.body) throw new Error(response.statusText || "stream request failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\\n\\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event:\\s*(.+)$/mu.exec(block)?.[1] || "message";
          const raw = /^data:\\s*(.+)$/mu.exec(block)?.[1] || "{}";
          const value = JSON.parse(raw);
          if (event === "delta") onDelta(value.delta || "");
          if (event === "result") result = value;
          if (event === "error") throw new Error(value.error || "stream failed");
        }
      }
      if (!result) throw new Error("stream ended without a result");
      return result;
    }

    function showOutput(value) {
      $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function safeHref(value) {
      const raw = String(value || "").trim();
      if (/^(https?:|mailto:)/i.test(raw)) return raw;
      if (raw.startsWith("/")) return raw;
      return "#";
    }

    function markdownInline(value) {
      let text = escapeHtml(value);
      const code = [];
      const codeSpan = new RegExp(String.fromCharCode(96) + "([^" + String.fromCharCode(96) + "\\n]+)" + String.fromCharCode(96), "g");
      text = text.replace(codeSpan, (_, content) => {
        const key = "__ODINN_CODE_" + code.length + "__";
        code.push("<code>" + content + "</code>");
        return key;
      });
      text = text.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+&quot;([^&]*)&quot;)?\\)/g, (_, alt, href, title) => {
        const safe = safeHref(href);
        return '<img class="markdown-inline-image" loading="lazy" alt="' + alt + '" src="' + escapeHtml(safe) + '"' + (title ? ' title="' + title + '"' : "") + ">";
      });
      text = text.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+&quot;([^&]*)&quot;)?\\)/g, (_, label, href, title) => {
        const safe = safeHref(href);
        return '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noreferrer noopener"' + (title ? ' title="' + title + '"' : "") + ">" + label + "</a>";
      });
      text = text.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
      text = text.replace(/__([^_\\n]+)__/g, "<strong>$1</strong>");
      text = text.replace(/~~([^~\\n]+)~~/g, "<del>$1</del>");
      text = text.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, "$1<em>$2</em>");
      text = text.replace(/(^|[^_])_([^_\\n]+)_(?!_)/g, "$1<em>$2</em>");
      return text.replace(/__ODINN_CODE_(\\d+)__/g, (_, index) => code[Number(index)] || "");
    }

    function renderMarkdown(source) {
      const lines = String(source ?? "").replaceAll("\\r", "").split("\\n");
      const out = [];
      let paragraph = [];
      let list = null;
      let code = null;
      const flushParagraph = () => {
        if (paragraph.length) {
          out.push("<p>" + markdownInline(paragraph.join(" ")) + "</p>");
          paragraph = [];
        }
      };
      const closeList = () => {
        if (!list) return;
        out.push("</" + list.type + ">");
        list = null;
      };
      for (const line of lines) {
        const fence = line.match(new RegExp("^\\s*" + String.fromCharCode(96).repeat(3) + "(.*)$"));
        if (fence) {
          flushParagraph();
          closeList();
          if (!code) code = { lang: fence[1].trim(), lines: [] };
          else {
            out.push('<pre><code class="language-' + escapeHtml(code.lang || "text") + '">' + escapeHtml(code.lines.join("\\n")) + "</code></pre>");
            code = null;
          }
          continue;
        }
        if (code) { code.lines.push(line); continue; }
        if (!line.trim()) { flushParagraph(); closeList(); continue; }
        const heading = line.match(/^\\s*(#{1,6})\\s+(.+?)\\s*#*\\s*$/);
        if (heading) { flushParagraph(); closeList(); const level = heading[1].length; out.push("<h" + level + ">" + markdownInline(heading[2]) + "</h" + level + ">"); continue; }
        if (/^\\s*(---+|\\*\\*\\*+)\\s*$/.test(line)) { flushParagraph(); closeList(); out.push("<hr>"); continue; }
        const quote = line.match(/^\\s*>\\s?(.*)$/);
        if (quote) { flushParagraph(); closeList(); out.push("<blockquote>" + markdownInline(quote[1]) + "</blockquote>"); continue; }
        const item = line.match(/^\\s*([-+*]|\\d+\\.)\\s+(.*)$/);
        if (item) {
          flushParagraph();
          const type = /\\d+\\./.test(item[1]) ? "ol" : "ul";
          if (!list || list.type !== type) { closeList(); list = { type }; out.push("<" + type + ">"); }
          let content = item[2];
          const task = content.match(/^\\[([ xX])\\]\\s+(.*)$/);
          if (task) content = '<span class="task-list-item"><input type="checkbox" disabled' + (task[1].toLowerCase() === "x" ? " checked" : "") + ">" + markdownInline(task[2]) + "</span>";
          else content = markdownInline(content);
          out.push("<li>" + content + "</li>");
          continue;
        }
        closeList();
        paragraph.push(line.trim());
      }
      flushParagraph();
      closeList();
      if (code) out.push('<pre><code class="language-' + escapeHtml(code.lang || "text") + '">' + escapeHtml(code.lines.join("\\n")) + "</code></pre>");
      return out.join("") || '<p class="muted">No content.</p>';
    }

    function compactPath(value) {
      const text = String(value || "");
      return text.length > 46 ? "..." + text.slice(-43) : text;
    }

    function setBusy(button, busy) {
      if (!button) return;
      button.disabled = busy;
    }

    function switchView(name) {
      document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === "view-" + name));
      document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
      const button = document.querySelector('[data-view="' + name + '"]');
      $("view-title").textContent = button?.dataset.title || button?.textContent?.trim() || "Chat";
      $("chat-context-sep").style.display = name === "overview" ? "" : "none";
      $("chat-title").style.display = name === "overview" ? "" : "none";
      if (name === "audit") refreshAudit();
      if (name === "capabilities") {
        refreshApprovals().catch((error) => showOutput(error.message));
        refreshBrowser().catch((error) => showOutput(error.message));
      }
      if (name === "sessions") {
        if (state.status?.allowedCapabilities?.includes("session.read")) refreshSessions().catch((error) => showOutput(error.message));
        else $("session-list").innerHTML = '<div class="empty-state"><strong>Sessions are disabled by policy</strong><span>Add session.read/session.write to this gateway policy to manage conversations.</span></div>';
      }
      if (name === "tasks") refreshTasks().catch((error) => showOutput(error.message));
      if (name === "usage") refreshUsage().catch((error) => showOutput(error.message));
      if (name === "cron") refreshCron().catch((error) => showOutput(error.message));
      if (name === "agents") refreshAgents().catch((error) => showOutput(error.message));
      if (name === "skills") refreshSkills().catch((error) => showOutput(error.message));
    }

    function renderItemText(text, fallback) {
      const value = String(text || fallback || "");
      return escapeHtml(value.length > 180 ? value.slice(0, 177) + "..." : value);
    }

    function renderRun(run) {
      const tone = run.status === "completed" ? "ok" : run.status === "running" ? "warn" : "danger";
      return '<div class="item clickable" data-run-id="' + escapeHtml(run.id) + '">' +
        '<div class="item-line"><span class="item-title">' + escapeHtml(run.tool || run.id) + '</span>' +
        '<span class="chip ' + tone + '">' + escapeHtml(run.status) + '</span></div>' +
        '<div class="muted">' + escapeHtml(run.id) + '</div>' +
        '<div class="muted">' + escapeHtml(run.message || run.capability || "") + '</div>' +
      '</div>';
    }

    function renderAuditEvent(event) {
      const text = JSON.stringify(event);
      const isError = /fail|error|denied/i.test(text);
      const isModel = /model\.chat|provider|assistant/i.test(text);
      if (state.auditFilter === "model" && !isModel) return "";
      if (state.auditFilter === "error" && !isError) return "";
      const query = $("audit-query")?.value.trim().toLowerCase();
      if (query && !text.toLowerCase().includes(query)) return "";
      const tone = isError ? "danger" : isModel ? "ok" : "";
      const kind = event.type || event.event || "audit event";
      const labels = {
        "task.policy": "Policy decision", "task.started": "Task started", "task.completed": "Task completed",
        "task.failed": "Task failed", "task.approval_required": "Approval required", "task.cancelled": "Task cancelled",
        "model.request": "Model request", "model.response": "Model response", "memory.curate": "Memory curation"
      };
      const title = labels[kind] || event.tool || kind;
      const subject = event.tool ? "Tool " + event.tool : event.capability ? "Capability " + event.capability : "Runtime event";
      const summary = event.message || (event.decision ? "Decision: " + event.decision : event.status ? "Status: " + event.status : subject);
      const metadata = [event.actor && "Actor: " + event.actor, event.runId && "Run: " + event.runId, event.capability && "Capability: " + event.capability, event.tool && "Tool: " + event.tool].filter(Boolean);
      return '<div class="item activity-event ' + (isError ? "error" : "") + '"><div class="item-line"><strong>' + escapeHtml(title) + '</strong><span class="chip ' + tone + '">' + escapeHtml(event.status || event.decision || (isError ? "error" : "recorded")) + '</span></div><div class="muted">' + escapeHtml(event.at || event.timestamp || "") + ' · ' + escapeHtml(kind) + '</div><p class="activity-summary">' + escapeHtml(summary) + '</p><div class="activity-meta">' + metadata.map((value) => '<span>' + escapeHtml(value) + '</span>').join("") + '</div><details class="activity-details"><summary>Show event details</summary><pre>' + escapeHtml(JSON.stringify(event, null, 2)) + '</pre></details></div>';
    }

    function renderProvider(provider) {
      const configured = provider.configured;
      const auth = provider.authMode || "api-key";
      return '<div class="provider-card"><div class="provider-head"><strong>' + escapeHtml(provider.name) + '</strong><span class="chip ' + (configured ? "ok" : "warn") + '">' + (configured ? "ready" : "auth required") + '</span></div><div class="chip-row"><span class="chip">' + escapeHtml(auth) + '</span><span class="chip">' + escapeHtml(provider.type || "provider") + '</span><span class="chip">' + escapeHtml((provider.models || []).length + " models") + '</span></div><div class="muted">' + escapeHtml(provider.baseUrl || "managed transport") + '</div></div>';
    }

    function renderSessionTranscript(detail) {
      const messages = detail?.messages || [];
      $("selected-session-route").textContent = detail?.session?.title || "Selected session";
      $("session-transcript").innerHTML = messages.length
        ? messages.map((message) => '<div class="timeline-row"><span class="timeline-dot"></span><div class="item"><div class="item-line"><strong>' + escapeHtml(message.role || "message") + '</strong><span class="chip">' + escapeHtml([message.provider, message.model].filter(Boolean).join(":") || "unrouted") + '</span></div><div class="markdown-body">' + renderMarkdown(message.content) + '</div></div></div>').join("")
        : '<div class="empty-state"><strong>No messages yet</strong><span>Send the first message from Chat.</span></div>';
    }

    function renderChatSession(session) {
      const attrs = 'data-chat-session-id="' + escapeHtml(session.id) + '"';
      const active = session.id === state.activeChatId ? " active" : "";
      return '<div class="menu-chat' + active + '" ' + attrs + '>' +
        '<div class="item-line"><div class="menu-chat-main"><strong>' + renderItemText(session.title, "Untitled chat") + '</strong>' +
        '<span>' + escapeHtml(session.lastMessageRole || "open") + '</span></div>' +
        '<span class="badge">' + escapeHtml(session.messageCount || 0) + '</span></div>' +
        '<div class="menu-chat-actions"><button class="chat-action" data-session-action="rename" data-session-id="' + escapeHtml(session.id) + '" title="Rename chat" aria-label="Rename chat"><svg class="icon-svg"><use href="#icon-edit"></use></svg></button><button class="chat-action delete" data-session-action="delete" data-session-id="' + escapeHtml(session.id) + '" title="Delete chat" aria-label="Delete chat"><svg class="icon-svg"><use href="#icon-trash"></use></svg></button></div>' +
      '</div>';
    }

    function renderSessionRecord(session) {
      const updated = session.updatedAt || session.createdAt || "";
      return '<div class="data-row clickable session-record" data-session-id="' + escapeHtml(session.id) + '">' +
        '<span class="data-primary"><strong>' + renderItemText(session.title, "Untitled session") + '</strong><small>' + escapeHtml(session.id) + '</small></span>' +
        '<span class="chip">' + escapeHtml(session.source || "direct") + '</span>' +
        '<span class="chip ' + (session.status === "archived" ? "" : "ok") + '">' + escapeHtml(session.status || "open") + '</span>' +
        '<span>' + escapeHtml(session.runtime || "odinn") + '</span>' +
        '<span class="muted">' + escapeHtml(relativeTime(updated)) + '</span>' +
        '<span>' + escapeHtml(session.messageCount || 0) + '</span>' +
        '<span class="row"><button class="session-action" data-session-action="rename" data-session-id="' + escapeHtml(session.id) + '" title="Rename session" aria-label="Rename session">Rename</button><button class="session-action delete" data-session-action="delete" data-session-id="' + escapeHtml(session.id) + '" title="Delete session" aria-label="Delete session">Delete</button></span>' +
      '</div>';
    }

    function relativeTime(value) {
      const at = Date.parse(value || "");
      if (!Number.isFinite(at)) return "—";
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 60) return seconds + "s ago";
      if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
      if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
      return Math.floor(seconds / 86400) + "d ago";
    }

    async function renameChat(sessionId) {
      const detail = await api("/sessions/" + encodeURIComponent(sessionId));
      const title = window.prompt("Rename chat", detail.session?.title || "Untitled chat");
      if (title === null || !title.trim()) return;
      await api("/sessions/" + encodeURIComponent(sessionId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), source: "console-chat" })
      });
      await refreshSessions();
      if (state.activeChatId === sessionId) await loadChat(sessionId);
      if (state.selectedSessionId === sessionId && state.activeChatId !== sessionId) {
        renderSessionTranscript(await api("/sessions/" + encodeURIComponent(sessionId)));
      }
    }

    async function deleteChat(sessionId) {
      const detail = await api("/sessions/" + encodeURIComponent(sessionId));
      const title = detail.session?.title || "Untitled chat";
      if (!window.confirm('Delete chat "' + title + '"? This removes it from the chat list.')) return;
      await api("/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
      if (state.activeChatId === sessionId) {
        state.activeChatId = "";
        state.messages = [];
        $("chat-title").textContent = "New chat";
        $("chat-subtitle").textContent = "Local beta adapter";
      }
      if (state.selectedSessionId === sessionId) {
        state.selectedSessionId = "";
        $("session-transcript").innerHTML = '<div class="empty-state"><strong>Select a session</strong><span>Its messages and model route will appear here.</span></div>';
      }
      await refreshSessions();
      await refreshRuns();
    }

    function renderChatMessages(messages) {
      if (!messages.length) {
        const configured = state.status?.models?.length;
        $("chat-thread").innerHTML = '<div class="chat-empty">' +
          '<div class="chat-avatar"><img src="/odinn-logo.png" alt=""></div>' +
          '<h1>Ódinn Forge</h1>' +
          '<span class="pill ' + (configured ? "" : "warn") + '">' + (configured ? "Ready to chat" : "Provider required") + '</span>' +
          '<p>' + (configured
            ? 'Ask anything · current web context and browser access are available from Capabilities'
            : 'Configure a model provider, then refresh this page.') + '</p>' +
          (configured
            ? '<div class="chat-prompts">' +
              '<button class="chat-prompt" data-chat-prompt="What can you do?">What can you do?</button>' +
              '<button class="chat-prompt" data-chat-prompt="Search the web for the latest Ódinn Forge beta release notes.">Search the web</button>' +
              '<button class="chat-prompt" data-chat-prompt="Open the browser workspace and show me the current page.">Open browser workspace</button>' +
              '<button class="chat-prompt" data-chat-prompt="Check the current runtime health.">Check runtime health</button>' +
            '</div>'
            : "") +
          '</div>';
        return;
      }
      $("chat-thread").innerHTML = messages.map((message) => {
        const route = message.provider && message.model
          ? '<span class="chip ok">' + escapeHtml(message.provider + ":" + message.model) + '</span>'
          : "";
        return '<div class="message ' + escapeHtml(message.role) + '">' +
          '<div class="message-role">' + (message.role === "assistant" ? '<span class="message-assistant-head"><span class="message-avatar"><img src="/odinn-logo.png" alt=""></span><span>Ódinn Forge</span></span>' : escapeHtml(message.role)) + route + '</div>' +
          '<div class="markdown-body">' + renderMarkdown(message.content) + '</div>' +
        '</div>';
      }).join("");
      $("chat-thread").scrollTop = $("chat-thread").scrollHeight;
    }

    async function createChat(title = "Beta chat") {
      const session = await api("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, source: "console-chat", tags: ["chat"] })
      });
      state.activeChatId = session.id;
      state.selectedSessionId = session.id;
      $("send-chat").disabled = false;
      await loadChat(session.id);
      await refreshSessions();
      await refreshRuns();
      return session;
    }

    async function loadChat(sessionId) {
      const detail = await api("/sessions/" + encodeURIComponent(sessionId));
      state.activeChatId = sessionId;
      state.selectedSessionId = sessionId;
      state.messages = detail.messages || [];
      $("chat-title").textContent = detail.session?.title || "Untitled chat";
      $("chat-subtitle").textContent = detail.session?.id || "local model gateway";
      renderChatMessages(state.messages);
      showOutput(detail);
    }

    async function ensureChat() {
      if (state.activeChatId) return state.activeChatId;
      const session = await createChat("Gateway beta chat");
      return session.id;
    }

    function suggestedChatTitle(content) {
      const title = String(content || "")
        .replace(/^\s*[-*#>]+\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      return title.length > 38 ? title.slice(0, 35).trimEnd() + "..." : title;
    }

    async function sendChatMessage(text, options = {}) {
      const content = String(text || "").trim();
      if (!content) return;
      $("chat-status").textContent = "Thinking";
      const sessionId = await ensureChat();
      const currentTitle = $("chat-title").textContent.trim();
      if (!state.messages.length && ["Gateway beta chat", "Beta chat", "New chat"].includes(currentTitle)) {
        const title = suggestedChatTitle(content);
        if (title) {
          await api("/sessions/" + encodeURIComponent(sessionId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, source: "console-chat-auto-title" })
          });
        }
      }
      await api("/sessions/" + encodeURIComponent(sessionId) + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "user", content, source: "console-chat" })
      });
      const toolRequest = options.tool === "job.healthcheck"
          ? { tool: "job.healthcheck", input: {} }
        : {
            tool: "agent.run",
            input: {
              model: state.modelOverride || state.status?.defaultModel,
              sessionId,
              messages: [...state.messages, { role: "user", content }]
                .filter((message) => ["user", "assistant", "system", "tool"].includes(message.role))
                .map((message) => ({ role: message.role, content: message.content }))
            }
          };
      let streamed = "";
      if (options.tool !== "job.healthcheck") {
        state.messages = [...state.messages, { role: "user", content }, { role: "assistant", content: "" }];
        renderChatMessages(state.messages);
      }
      const result = options.tool === "job.healthcheck"
        ? await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolRequest) })
        : await streamApi("/run/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolRequest) }, (delta) => {
            streamed += delta;
            state.messages[state.messages.length - 1].content = streamed;
            renderChatMessages(state.messages);
          });
      const reply = options.tool === "job.healthcheck"
        ? "Healthcheck passed on " + result.output.platform + " " + result.output.release + ". Workspace: " + result.output.workspaceRoot
        : result.output.content;
      await api("/sessions/" + encodeURIComponent(sessionId) + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "assistant",
          content: reply,
          source: "console-chat",
          ...(options.tool === "job.healthcheck" ? {} : {
            model: result.output?.model,
            provider: result.output?.provider
          })
        })
      });
      $("chat-input").value = "";
      $("chat-status").textContent = "Ready";
      await loadChat(sessionId);
      await refreshSessions();
      await refreshRuns();
      if (result.output?.pendingApproval) await refreshApprovals();
      showOutput(result);
    }

    function renderRecord(record, title, meta, attrs) {
      return '<div class="item clickable" ' + (attrs || "") + '>' +
        '<div class="item-line"><span class="item-title">' + renderItemText(title, "Untitled") + '</span>' +
        '<span class="muted">' + renderItemText(record.status || record.type || "", "") + '</span></div>' +
        '<div>' + renderItemText(record.text || record.rationale || record.description || record.content || "", "") + '</div>' +
        '<div class="muted">' + renderItemText(meta, "") + '</div>' +
      '</div>';
    }

    function renderWebResult(result) {
      return '<div class="item web-result"><div class="item-line"><a href="' + escapeHtml(safeHref(result.url)) + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(result.title || result.url) + '</a><span class="chip">web</span></div><p>' + escapeHtml(result.snippet || "No snippet available.") + '</p><div class="muted">' + escapeHtml(result.url || "") + '</div></div>';
    }

    function renderBrowserTab(tab) {
      return '<div class="item browser-tab" data-browser-tab-id="' + escapeHtml(tab.id) + '"><div class="item-line"><strong>' + escapeHtml(tab.title || "Untitled page") + '</strong><span class="chip">open</span></div><div class="muted">' + escapeHtml(tab.url || "about:blank") + '</div></div>';
    }

    function renderApproval(approval) {
      return '<div class="item approval-card"><div class="item-line"><strong>' + escapeHtml(approval.tool || "browser action") + '</strong><span class="chip warn">approval required</span></div><div class="approval-summary">' + escapeHtml(approval.summary || "External action requested.") + '</div><div class="row"><span class="muted">' + escapeHtml(approval.id || "") + '</span><button data-approve-id="' + escapeHtml(approval.id) + '" type="button">Approve once</button></div></div>';
    }

    async function refreshApprovals() {
      const approvals = await api("/approvals");
      $("cap-approval-count").textContent = approvals.length;
      $("approval-list").innerHTML = approvals.map(renderApproval).join("") || '<div class="empty-state"><strong>No pending actions</strong><span>Ódinn Forge will stop before changing an external account.</span></div>';
    }

    async function refreshBrowser() {
      try {
        const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.tabs", input: {} }) });
        const tabs = result.output?.tabs || [];
        $("browser-tabs").innerHTML = tabs.map(renderBrowserTab).join("") || '<div class="empty-state"><strong>Browser is waiting</strong><span>Open a site to create the persistent beta profile.</span></div>';
        if (!state.browserTabId && tabs[0]) state.browserTabId = tabs[0].id;
        if (state.browserTabId) await inspectBrowserTab(state.browserTabId);
        $("cap-browser-status").textContent = "READY";
      } catch (error) {
        $("cap-browser-status").textContent = "OFFLINE";
        showOutput(error.message);
      }
    }

    async function inspectBrowserTab(tabId) {
      const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.snapshot", input: { tabId } }) });
      state.browserTabId = tabId;
      $("browser-page-title").textContent = result.output?.title || "Untitled page";
      $("browser-page-url").textContent = result.output?.url || "—";
      $("browser-page-text").textContent = result.output?.text || "No visible page text.";
    }

    async function runWebSearch() {
      const query = $("web-search-query").value.trim();
      if (!query) return;
      setBusy($("web-search-run"), true);
      try {
        const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "web.search", input: { query, limit: 6 } }) });
        $("web-search-results").innerHTML = (result.output?.results || []).map(renderWebResult).join("") || '<div class="empty-state"><strong>No results</strong><span>Try a broader query.</span></div>';
        showOutput(result);
      } catch (error) { showOutput(error.message); }
      finally { setBusy($("web-search-run"), false); }
    }

    async function openBrowserUrl() {
      const url = $("browser-url").value.trim();
      if (!url) return;
      setBusy($("browser-open"), true);
      try {
        const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.open", input: { url, tabId: state.browserTabId || undefined } }) });
        state.browserTabId = result.output?.id || state.browserTabId;
        await refreshBrowser();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
      finally { setBusy($("browser-open"), false); }
    }

    async function approveAction(id) {
      const result = await api("/approvals/" + encodeURIComponent(id) + "/approve", { method: "POST" });
      await refreshApprovals();
      await refreshBrowser();
      showOutput(result);
    }

    async function refresh() {
      try {
        const status = await api("/status");
        state.status = status;
        $("health").textContent = "Online";
        $("nav-health").textContent = "online";
        $("status-pill").textContent = "Online";
        $("workspace").textContent = compactPath(status.workspaceRoot) + " | " + compactPath(status.state);
        $("status-workspace").textContent = status.workspaceRoot;
        $("status-state").textContent = status.state;
        $("tool-count").textContent = status.tools.length + " capabilities";
        $("provider-list").innerHTML = status.providers?.length
          ? status.providers.map(renderProvider).join("")
          : '<div class="empty-state"><strong>No providers configured</strong><span>Run <code>pnpm odinn onboard --provider openai</code> to connect one.</span></div>';
        const modelSelect = $("model-select");
        const selectedModel = state.modelOverride || status.defaultModel;
        modelSelect.innerHTML = status.models?.length
          ? status.models.map((model) => '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(model.id) + '</option>').join("")
          : '<option value="">Configure a provider first</option>';
        const resolvedModel = status.models?.some((model) => model.id === selectedModel)
          ? selectedModel
          : (status.defaultModel || "");
        modelSelect.value = resolvedModel;
        if (state.modelOverride && resolvedModel !== state.modelOverride) state.modelOverride = "";
        $("model-chip").textContent = status.models?.length ? (status.providers?.some((provider) => provider.configured) ? "provider ready" : "auth required") : "no model configured";
        $("model-chip").className = "chip " + (status.models?.length && status.providers?.some((provider) => provider.configured) ? "ok" : "warn");
        $("metric-tools").textContent = status.tools.length;
        $("metric-policy").textContent = status.allowedCapabilities.length;
        $("runtime-chips").innerHTML = [
          '<span class="chip ok">online</span>',
          '<span class="chip">loopback</span>',
          '<span class="chip">' + escapeHtml(status.tools.length) + ' tools</span>',
          '<span class="chip">' + escapeHtml(status.allowedCapabilities.length) + ' caps</span>'
        ].join("");
        $("cap-web-status").textContent = status.security?.web?.enabled === false ? "OFF" : "READY";
        $("cap-browser-status").textContent = status.security?.browser?.enabled === false ? "OFF" : "READY";
        $("cap-security-mode").textContent = status.security?.browser?.requireApproval === false ? "OPEN" : "SAFE";
        $("tool").innerHTML = status.tools.map((tool) => '<option value="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</option>').join("");
        $("cron-tool").innerHTML = status.tools.map((tool) => '<option value="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</option>').join("");
        $("tool-list").innerHTML = status.toolDetails.map((tool) => renderRecord(tool, tool.name, tool.capability + " | " + tool.description)).join("");
        const background = [refreshRuns()];
        if (status.allowedCapabilities.includes("memory.read")) background.push(refreshMemory());
        if (status.allowedCapabilities.includes("session.read")) background.push(refreshSessions());
        if (status.allowedCapabilities.includes("goal.read")) background.push(refreshGoals());
        await Promise.allSettled(background);
        await refreshApprovals();
      } catch (error) {
        $("health").textContent = "Error";
        $("nav-health").textContent = "error";
        $("status-pill").textContent = "Error";
        $("status-pill").className = "pill danger";
        showOutput(error.message);
      }
    }

    async function refreshRuns() {
      const runs = await api("/runs");
      state.runs = runs;
      $("metric-runs").textContent = runs.length;
      $("metric-completed").textContent = runs.filter((run) => run.status === "completed").length;
      $("runs").innerHTML = runs.slice(0, 12).map(renderRun).join("") || '<div class="muted">No runs yet.</div>';
      const planRuns = runs.filter((run) => run.tool === "plan" || String(run.id).startsWith("plan_"));
      $("run-history").innerHTML = runs.slice(0, 8).map(renderRun).join("") || '<div class="empty-state"><strong>No executions yet</strong><span>Run a capability to see its evidence here.</span></div>';
      $("plan-runs").innerHTML = planRuns.slice(0, 12).map(renderRun).join("") || '<div class="empty-state"><strong>No plan runs yet</strong><span>Choose a starter template and run it.</span></div>';
      $("plan-run-count").textContent = planRuns.length;
      $("plan-last-status").textContent = planRuns[0]?.status || "—";
    }

    async function refreshTasks() {
      const runs = await api("/runs");
      state.runs = runs;
      const query = $("task-query")?.value.trim().toLowerCase() || "";
      const filtered = runs.filter((run) => (state.taskFilter === "all" || run.status === state.taskFilter || (state.taskFilter === "failed" && ["failed", "blocked", "cancelled"].includes(run.status))) && (!query || JSON.stringify(run).toLowerCase().includes(query)));
      $("task-total").textContent = runs.length;
      $("task-running").textContent = runs.filter((run) => run.status === "running").length;
      $("task-passed").textContent = runs.filter((run) => run.status === "completed").length;
      $("task-failed").textContent = runs.filter((run) => ["failed", "blocked", "cancelled"].includes(run.status)).length;
      $("task-table").innerHTML = filtered.map((run) => {
        const started = run.events?.find((event) => event.type === "task.started") || {};
        const last = run.events?.at(-1) || {};
        const proofCount = run.events?.filter((event) => /proof|verify|audit/i.test(event.type || "")).length || 0;
        const tone = run.status === "completed" ? "ok" : run.status === "running" ? "warn" : "danger";
        return '<div class="data-row task-row" data-task-id="' + escapeHtml(run.id) + '"><span class="data-primary"><strong>' + escapeHtml(run.tool || run.id) + '</strong><small>' + escapeHtml(run.id) + '</small></span><span class="chip ' + tone + '">' + escapeHtml(run.status) + '</span><span>' + escapeHtml(started.actor || "gateway") + '</span><span class="muted">' + escapeHtml(relativeTime(last.at || started.at)) + '</span><span>' + escapeHtml(proofCount ? proofCount + " proof events" : (run.events?.length || 0) + " audit events") + '</span><span class="row"><button class="secondary" data-task-inspect="' + escapeHtml(run.id) + '" type="button">Inspect</button></span></div>';
      }).join("") || '<div class="empty-state"><strong>No matching tasks</strong><span>The proof and audit ledger is quiet.</span></div>';
    }

    async function inspectTask(id) {
      const detail = await api("/runs/" + encodeURIComponent(id));
      state.selectedTaskId = id;
      $("task-detail-label").textContent = id;
      $("task-evidence").textContent = JSON.stringify(detail, null, 2);
      $("task-verify").disabled = false;
      const started = detail.events?.find((event) => event.type === "task.started");
      $("task-replay").disabled = !started;
    }

    async function refreshUsage() {
      const [audit, runs] = await Promise.all([api("/audit"), api("/runs")]);
      const modelEvents = audit.filter((event) => /model\.chat|agent\.run|provider/i.test(JSON.stringify(event)));
      const totalTokens = audit.reduce((sum, event) => sum + Number(event.data?.output?.usage?.totalTokens || event.data?.output?.usage?.total_tokens || 0), 0);
      $("usage-total-tokens").textContent = totalTokens.toLocaleString();
      $("usage-model-calls").textContent = modelEvents.filter((event) => event.type === "task.completed").length;
      $("usage-errors").textContent = audit.filter((event) => /fail|error|denied/i.test(JSON.stringify(event))).length;
      const days = [];
      for (let offset = 13; offset >= 0; offset -= 1) {
        const day = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
        days.push({ day, count: audit.filter((event) => String(event.at || event.timestamp || "").startsWith(day)).length });
      }
      const max = Math.max(1, ...days.map((day) => day.count));
      $("usage-chart").innerHTML = days.map((day) => '<span class="bar-column" title="' + escapeHtml(day.day + ': ' + day.count + ' events') + '"><i style="height:' + Math.max(3, Math.round(day.count / max * 165)) + 'px"></i><small>' + escapeHtml(day.day.slice(5)) + '</small></span>').join("");
      $("runs").innerHTML = runs.slice(0, 12).map(renderRun).join("") || '<div class="empty-state"><strong>No usage yet</strong><span>Model and tool activity will appear here.</span></div>';
    }

    async function refreshCron() {
      const data = await api("/cron");
      state.cronJobs = data.jobs || [];
      const query = $("cron-query")?.value.trim().toLowerCase() || "";
      const jobs = state.cronJobs.filter((job) => !query || JSON.stringify(job).toLowerCase().includes(query));
      $("cron-enabled").textContent = data.enabled ? "Yes" : "No";
      $("cron-count").textContent = data.jobs.length;
      $("cron-next").textContent = data.nextWake ? new Date(data.nextWake).toLocaleString() : "—";
      $("cron-shown").textContent = jobs.length + " shown of " + data.jobs.length;
      $("cron-list").innerHTML = jobs.map((job) => '<div class="cron-card"><div class="item-line"><strong>' + escapeHtml(job.name) + '</strong><span class="chip ' + (job.lastStatus === "error" ? "danger" : job.enabled ? "ok" : "") + '">' + escapeHtml(job.enabled ? (job.lastStatus || "enabled") : "disabled") + '</span></div><div class="cron-meta"><span>Cron ' + escapeHtml(job.schedule) + ' (' + escapeHtml(job.timezone) + ')</span><span>Tool: ' + escapeHtml(job.tool) + '</span><span>Last: ' + escapeHtml(relativeTime(job.lastRunAt)) + '</span></div><div class="row"><button class="secondary" data-cron-run="' + escapeHtml(job.id) + '" type="button">Run</button><button class="secondary" data-cron-toggle="' + escapeHtml(job.id) + '" data-enabled="' + escapeHtml(job.enabled) + '" type="button">' + (job.enabled ? "Disable" : "Enable") + '</button><button class="secondary" data-cron-delete="' + escapeHtml(job.id) + '" type="button">Delete</button></div></div>').join("") || '<div class="empty-state"><strong>No scheduled jobs</strong><span>Create a persisted recurring run.</span></div>';
    }

    async function refreshAgents() {
      const data = await api("/agents");
      state.agents = data.agents || [];
      const query = $("agent-query")?.value.trim().toLowerCase() || "";
      const agents = state.agents.filter((agent) => !query || JSON.stringify(agent).toLowerCase().includes(query));
      $("agent-total").textContent = state.agents.length;
      $("agent-enabled").textContent = state.agents.filter((agent) => agent.status === "enabled").length;
      $("agent-quarantined").textContent = state.agents.filter((agent) => agent.status === "quarantined").length;
      $("agent-list").innerHTML = agents.map((agent) => '<div class="item agent-package ' + (agent.id === state.selectedAgentId ? "selected" : "") + '" data-agent-id="' + escapeHtml(agent.id) + '"><div class="item-line"><strong>' + escapeHtml(agent.name) + '</strong><span class="chip ' + (agent.status === "enabled" ? "ok" : agent.status === "quarantined" ? "danger" : "") + '">' + escapeHtml(agent.status) + '</span></div><div class="muted">' + escapeHtml(agent.id + '@' + agent.version) + '</div><div class="chip-row"><span class="chip">' + escapeHtml((agent.tools || []).length + " tools") + '</span><span class="chip">' + escapeHtml((agent.plugins || []).length + " plugins") + '</span><span class="chip">' + escapeHtml((agent.tests || []).length + " tests") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No agent packages installed</strong><span>Install an Agent SDK v0.3 manifest to start.</span></div>';
      if (state.selectedAgentId) renderAgentDetail(state.agents.find((agent) => agent.id === state.selectedAgentId));
    }

    function renderAgentDetail(agent) {
      if (!agent) return;
      state.selectedAgentId = agent.id;
      $("agent-detail-status").textContent = agent.status;
      $("agent-detail-status").className = "chip " + (agent.status === "enabled" ? "ok" : agent.status === "quarantined" ? "danger" : "");
      const sections = ["identity", "instructions", "tools", "plugins", "secrets", "sandbox", "network", "schedules", "channels", "memory", "tests", "integrity"];
      $("agent-detail").className = "agent-inspector";
      $("agent-detail").innerHTML = sections.map((name) => '<div class="agent-section"><strong>' + escapeHtml(name) + '</strong><pre>' + escapeHtml(JSON.stringify(agent[name], null, 2)) + '</pre></div>').join("");
      ["agent-enable", "agent-disable", "agent-quarantine"].forEach((id) => $(id).disabled = false);
      document.querySelectorAll("[data-agent-id]").forEach((item) => item.classList.toggle("selected", item.dataset.agentId === agent.id));
    }

    async function refreshSkills() {
      const data = await api("/skills");
      state.skills = data.skills || [];
      const query = $("skill-query")?.value.trim().toLowerCase() || "";
      const skills = state.skills.filter((skill) => (state.skillFilter === "all" || skill.status === state.skillFilter) && (!query || JSON.stringify(skill).toLowerCase().includes(query)));
      $("skills-list").innerHTML = skills.map((skill) => '<div class="item skill-card"><div class="item-line"><strong>' + escapeHtml(skill.name) + '</strong><span class="chip ' + (skill.status === "ready" ? "ok" : "warn") + '">' + escapeHtml(skill.status) + '</span></div><p>' + escapeHtml(skill.description || "No description") + '</p><div class="muted skill-path">' + escapeHtml(skill.path || skill.entrypoint || "") + '</div><div class="chip-row"><span class="chip">' + escapeHtml(skill.bytes ? skill.bytes + " bytes" : skill.version || "package") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No matching skills</strong><span>Create a draft in Skill Workshop.</span></div>';
    }

    async function refreshMemory() {
      const query = $("memory-query").value.trim();
      const data = query ? await api("/memory?query=" + encodeURIComponent(query)) : await api("/memory/curated");
      const memories = query ? (data.memories || []) : Object.values(data.kinds || {}).flat();
      $("memory-list").innerHTML = memories.slice(0, 16).map((memory) =>
        renderRecord(memory, (memory.namespace ? memory.namespace + " · " : "") + (memory.subject || memory.kind), (memory.tier || "l1") + " · " + (memory.tags || []).join(", "), "")
      ).join("") || '<div class="muted">No memory records.</div>';
      const tree = await api("/memory/browse");
      $("memory-tree").innerHTML = (tree.namespaces || []).map((entry) =>
        '<div class="item"><div class="item-line"><strong>' + escapeHtml(entry.namespace) + '</strong><span class="chip">' + escapeHtml(entry.count + " records") + '</span></div><div class="muted">' + escapeHtml(Object.entries(entry.tiers || {}).map(([tier, count]) => tier + ":" + count).join(" · ")) + '</div></div>'
      ).join("") || '<div class="empty-state"><strong>No namespaces yet</strong><span>New durable context will appear here.</span></div>';
    }

    async function refreshSessions() {
      const data = await api("/sessions");
      const sessions = data.sessions || [];
      state.sessions = sessions;
      const chatSessions = sessions.filter((session) => Number(session.messageCount || 0) > 0 || session.id === state.activeChatId);
      const recent = [];
      const seenGenericTitles = new Set();
      for (const session of chatSessions) {
        const title = String(session.title || "").trim();
        const generic = /^(gateway beta chat|beta chat|new chat)$/i.test(title);
        if (generic && seenGenericTitles.has(title.toLowerCase()) && session.id !== state.activeChatId) continue;
        if (generic) seenGenericTitles.add(title.toLowerCase());
        recent.push(session);
        if (recent.length >= 8) break;
      }
      const pinned = chatSessions.filter((session) => session.pinned === true).slice(0, 6);
      $("pinned-chat-list").innerHTML = pinned.map(renderChatSession).join("");
      $("pinned-count").textContent = pinned.length;
      $("chat-session-list").innerHTML = recent.map(renderChatSession).join("") || '<div class="muted session-empty">Your saved chats will appear here.</div>';
      $("chat-session-count").textContent = sessions.length;
      $("session-page-count").textContent = sessions.length + " sessions";
      $("session-count-badge").textContent = sessions.length;
      if (!state.activeChatId && sessions.length) {
        const initial = sessions.find((session) => Number(session.messageCount || 0) === 0) || sessions[0];
        await loadChat(initial.id);
      } else {
        renderChatMessages(state.messages);
      }
      renderSessionTable();
    }

    function renderSessionTable() {
      const query = $("session-query")?.value.trim().toLowerCase() || "";
      const status = $("session-status-filter")?.value || "all";
      const sessions = (state.sessions || []).filter((session) => (!query || JSON.stringify(session).toLowerCase().includes(query)) && (status === "all" || (session.status || "open") === status));
      $("session-list").innerHTML = sessions.map(renderSessionRecord).join("") || '<div class="empty-state"><strong>No matching sessions</strong><span>Change the filters or create a new session.</span></div>';
    }

    async function refreshGoals() {
      const data = await api("/goals");
      $("goal-active-count").textContent = (data.goals || []).filter((goal) => goal.status === "active").length;
      $("goal-blocked-count").textContent = (data.goals || []).filter((goal) => goal.status === "blocked").length;
      $("goal-completed-count").textContent = (data.goals || []).filter((goal) => goal.status === "completed").length;
      $("goal-list").innerHTML = (data.goals || []).slice(0, 16).map((goal) =>
        renderRecord(goal, goal.title, goal.status, 'data-goal-id="' + escapeHtml(goal.id) + '"')
      ).join("") || '<div class="empty-state"><strong>No active goals</strong><span>Create one to make long-running work visible.</span></div>';
    }

    async function refreshAudit() {
      const audit = await api("/audit");
      state.audit = audit.slice(-120).reverse();
      $("audit-count").textContent = audit.length;
      $("audit-run-count").textContent = audit.filter((event) => event.tool || event.type === "run").length;
      $("audit-model-count").textContent = audit.filter((event) => /model\.chat|provider/i.test(JSON.stringify(event))).length;
      $("audit-error-count").textContent = audit.filter((event) => /fail|error|denied/i.test(JSON.stringify(event))).length;
      $("audit-events").innerHTML = state.audit.map(renderAuditEvent).join("") || '<div class="empty-state"><strong>No matching audit events</strong><span>Try another filter or run something.</span></div>';
      $("audit-log").textContent = JSON.stringify(audit.slice(-80), null, 2);
    }

    async function showRunDetail(runId) {
      const detail = await api("/runs/" + encodeURIComponent(runId));
      if ($("detail-label")) $("detail-label").textContent = runId;
      if ($("run-detail")) $("run-detail").textContent = JSON.stringify(detail, null, 2);
      showOutput(detail);
    }

    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    document.querySelectorAll("[data-view-jump]").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.viewJump));
    });

    $("sidebar-toggle").addEventListener("click", () => {
      const collapsed = $("shell").classList.toggle("sidebar-collapsed");
      $("sidebar-toggle").title = collapsed ? "Open navigation" : "Collapse navigation";
      $("sidebar-toggle").setAttribute("aria-label", collapsed ? "Open navigation" : "Collapse navigation");
    });
    $("web-search-run").addEventListener("click", runWebSearch);
    $("web-search-query").addEventListener("keydown", (event) => {
      if (event.key === "Enter") runWebSearch();
    });
    $("browser-open").addEventListener("click", openBrowserUrl);
    $("browser-refresh").addEventListener("click", refreshBrowser);
    $("browser-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-browser-tab-id]");
      if (tab) inspectBrowserTab(tab.dataset.browserTabId).catch((error) => showOutput(error.message));
    });
    $("approval-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-approve-id]");
      if (button) approveAction(button.dataset.approveId).catch((error) => showOutput(error.message));
    });

    $("refresh").addEventListener("click", refresh);
    $("sidebar-search").addEventListener("click", () => {
      const query = window.prompt("Search sessions", "");
      if (query === null) return;
      const normalized = query.trim().toLowerCase();
      document.querySelectorAll(".menu-chat").forEach((item) => {
        item.hidden = Boolean(normalized) && !item.textContent.toLowerCase().includes(normalized);
      });
    });
    $("sidebar-settings").addEventListener("click", () => switchView("usage"));
    $("sidebar-console").addEventListener("click", () => switchView("usage"));
    $("sidebar-theme").addEventListener("click", () => {
      document.body.classList.toggle("soft-contrast");
      showOutput(document.body.classList.contains("soft-contrast") ? "Soft contrast enabled." : "Soft contrast disabled.");
    });
    $("model-select").addEventListener("change", (event) => {
      state.modelOverride = event.currentTarget.value;
    });
    $("new-chat").addEventListener("click", async (event) => {
      try {
        setBusy(event.currentTarget, true);
        await createChat("Gateway beta chat");
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    function handleChatRailClick(event) {
      const action = event.target.closest("[data-session-action]");
      if (action) {
        event.stopPropagation();
        const operation = action.dataset.sessionAction === "rename" ? renameChat : deleteChat;
        operation(action.dataset.sessionId).catch((error) => showOutput(error.message));
        return;
      }
      const item = event.target.closest("[data-chat-session-id]");
      if (item) loadChat(item.dataset.chatSessionId).catch((error) => showOutput(error.message));
    }
    $("chat-session-list").addEventListener("click", handleChatRailClick);
    $("pinned-chat-list").addEventListener("click", handleChatRailClick);
    $("chat-thread").addEventListener("click", (event) => {
      const prompt = event.target.closest("[data-chat-prompt]");
      if (!prompt) return;
      $("chat-input").value = prompt.dataset.chatPrompt || "";
      $("chat-input").focus();
    });
    $("send-chat").addEventListener("click", async (event) => {
      try {
        setBusy(event.currentTarget, true);
        await sendChatMessage($("chat-input").value);
      } catch (error) {
        $("chat-status").textContent = "Error";
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    $("chat-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        $("send-chat").click();
      }
    });
    $("chat-smoke").addEventListener("click", async (event) => {
      try {
        setBusy(event.currentTarget, true);
        await sendChatMessage("Run a local healthcheck.", { tool: "job.healthcheck" });
      } catch (error) {
        $("chat-status").textContent = "Error";
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    $("clear-output").addEventListener("click", () => showOutput("Ready."));
    $("copy-status").addEventListener("click", async () => {
      await navigator.clipboard?.writeText(JSON.stringify(state.status, null, 2));
      showOutput("Status copied.");
    });
    $("copy-audit").addEventListener("click", async () => {
      await navigator.clipboard?.writeText($("audit-log").textContent);
      showOutput("Audit copied.");
    });
    $("refresh-audit").addEventListener("click", refreshAudit);
    $("memory-query").addEventListener("input", () => refreshMemory().catch((error) => showOutput(error.message)));
    $("refresh-memory-tree").addEventListener("click", () => refreshMemory().catch((error) => showOutput(error.message)));
    document.querySelectorAll(".audit-filter").forEach((button) => {
      button.addEventListener("click", () => {
        state.auditFilter = button.dataset.auditFilter || "all";
        document.querySelectorAll(".audit-filter").forEach((item) => item.classList.toggle("active", item === button));
        $("audit-events").innerHTML = state.audit.map(renderAuditEvent).join("") || '<div class="empty-state"><strong>No matching audit events</strong><span>Try another filter or run something.</span></div>';
      });
    });
    $("audit-query").addEventListener("input", () => {
      $("audit-events").innerHTML = state.audit.map(renderAuditEvent).join("") || '<div class="empty-state"><strong>No matching audit events</strong><span>Try another filter or run something.</span></div>';
    });

    $("runs").addEventListener("click", (event) => {
      const item = event.target.closest("[data-run-id]");
      if (item) showRunDetail(item.dataset.runId).catch((error) => showOutput(error.message));
    });
    $("plan-runs").addEventListener("click", (event) => {
      const item = event.target.closest("[data-run-id]");
      if (item) showRunDetail(item.dataset.runId).catch((error) => showOutput(error.message));
    });
    $("goal-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-goal-id]");
      if (!item) return;
      state.selectedGoalId = item.dataset.goalId;
      showOutput("Selected goal " + state.selectedGoalId);
    });
    $("session-list").addEventListener("click", async (event) => {
      const action = event.target.closest("[data-session-action]");
      if (action) {
        event.stopPropagation();
        const operation = action.dataset.sessionAction === "rename" ? renameChat : deleteChat;
        await operation(action.dataset.sessionId).catch((error) => showOutput(error.message));
        return;
      }
      const item = event.target.closest("[data-session-id]");
      if (!item) return;
      state.selectedSessionId = item.dataset.sessionId;
      const detail = await api("/sessions/" + encodeURIComponent(state.selectedSessionId));
      renderSessionTranscript(detail);
      showOutput(detail);
    });

    $("quick-smoke").addEventListener("click", async (event) => {
      try {
        setBusy(event.currentTarget, true);
        showOutput(await api("/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(planTemplates.smoke)
        }));
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    $("remember").addEventListener("click", async (event) => {
      try {
        setBusy(event.currentTarget, true);
        showOutput(await api("/memory", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: $("memory-kind").value,
            subject: $("memory-subject").value,
            namespace: $("memory-namespace").value,
            tier: $("memory-tier").value,
            text: $("memory-text").value,
            tags: $("memory-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
            source: "console"
          })
        }));
        await refreshMemory();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    $("create-session").addEventListener("click", async (event) => {
      try {
        const title = window.prompt("Session title", "New session");
        if (!title?.trim()) return;
        setBusy(event.currentTarget, true);
        const session = await api("/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: title.trim(), source: "console" })
        });
        state.selectedSessionId = session.id;
        showOutput(session);
        await refreshSessions();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    $("create-goal").addEventListener("click", async (event) => {
      try {
        setBusy(event.currentTarget, true);
        const goal = await api("/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: $("goal-title").value, source: "console" })
        });
        state.selectedGoalId = goal.id;
        showOutput(goal);
        await refreshGoals();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    $("update-goal").addEventListener("click", async (event) => {
      try {
        if (!state.selectedGoalId) throw new Error("Select or create a goal first.");
        setBusy(event.currentTarget, true);
        showOutput(await api("/goals/" + encodeURIComponent(state.selectedGoalId) + "/updates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: $("goal-status").value, note: $("goal-note").value, source: "console" })
        }));
        await refreshGoals();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(event.currentTarget, false);
      }
    });
    $("refresh-sessions").addEventListener("click", () => refreshSessions().catch((error) => showOutput(error.message)));
    $("session-query").addEventListener("input", renderSessionTable);
    $("session-status-filter").addEventListener("change", renderSessionTable);

    $("refresh-tasks").addEventListener("click", () => refreshTasks().catch((error) => showOutput(error.message)));
    $("task-query").addEventListener("input", () => refreshTasks().catch((error) => showOutput(error.message)));
    document.querySelectorAll(".task-filter").forEach((button) => button.addEventListener("click", () => {
      state.taskFilter = button.dataset.taskFilter || "all";
      document.querySelectorAll(".task-filter").forEach((item) => item.classList.toggle("active", item === button));
      refreshTasks().catch((error) => showOutput(error.message));
    }));
    $("task-table").addEventListener("click", (event) => {
      const button = event.target.closest("[data-task-inspect]");
      if (button) inspectTask(button.dataset.taskInspect).catch((error) => showOutput(error.message));
    });
    $("task-verify").addEventListener("click", async () => {
      if (!state.selectedTaskId) return;
      try { $("task-evidence").textContent = JSON.stringify(await api("/runtime/runs/" + encodeURIComponent(state.selectedTaskId) + "/verify"), null, 2); }
      catch (error) { $("task-evidence").textContent = "Verification unavailable: " + error.message; }
    });
    $("task-replay").addEventListener("click", async () => {
      if (!state.selectedTaskId || !window.confirm("Replay this task only if its tool is safe and idempotent?")) return;
      showOutput(await api("/runs/" + encodeURIComponent(state.selectedTaskId) + "/replay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      await refreshTasks();
    });

    $("new-cron").addEventListener("click", () => $("cron-dialog").showModal());
    $("refresh-cron").addEventListener("click", () => refreshCron().catch((error) => showOutput(error.message)));
    $("cron-query").addEventListener("input", () => refreshCron().catch((error) => showOutput(error.message)));
    $("cron-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        await api("/cron", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("cron-name").value, schedule: $("cron-schedule").value, timezone: $("cron-timezone").value, tool: $("cron-tool").value, input: JSON.parse($("cron-input").value || "{}") }) });
        $("cron-dialog").close();
        await refreshCron();
      } catch (error) { showOutput(error.message); }
    });
    $("cron-list").addEventListener("click", async (event) => {
      const run = event.target.closest("[data-cron-run]");
      const toggle = event.target.closest("[data-cron-toggle]");
      const remove = event.target.closest("[data-cron-delete]");
      try {
        if (run) showOutput(await api("/cron/" + encodeURIComponent(run.dataset.cronRun) + "/run", { method: "POST" }));
        if (toggle) await api("/cron/" + encodeURIComponent(toggle.dataset.cronToggle), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: toggle.dataset.enabled !== "true" }) });
        if (remove && window.confirm("Delete this scheduled job?")) await api("/cron/" + encodeURIComponent(remove.dataset.cronDelete), { method: "DELETE" });
        await refreshCron();
      } catch (error) { showOutput(error.message); }
    });

    $("new-agent").addEventListener("click", () => $("agent-dialog").showModal());
    $("agent-advanced-toggle").addEventListener("change", (event) => {
      $("agent-manifest").hidden = !event.target.checked;
      $("manifest-fields").hidden = event.target.checked;
    });
    $("refresh-agents").addEventListener("click", () => refreshAgents().catch((error) => showOutput(error.message)));
    $("agent-query").addEventListener("input", () => refreshAgents().catch((error) => showOutput(error.message)));
    $("agent-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        const list = (id) => $(id).value.split(",").map((value) => value.trim()).filter(Boolean);
        const manifest = $("agent-advanced-toggle").checked ? JSON.parse($("agent-manifest").value) : {
          sdkVersion: "0.3", id: $("agent-id").value.trim(), version: $("agent-version").value.trim(), name: $("agent-name").value.trim(),
          identity: { name: $("agent-identity").value.trim() }, instructions: list("agent-instructions"), tools: list("agent-tools"), plugins: list("agent-plugins"), secrets: list("agent-secrets"),
          sandbox: { mode: $("agent-sandbox").value }, network: { default: "deny", allow: list("agent-network") }, schedules: [], channels: [], memory: {}, tests: []
        };
        await api("/agents/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        const result = await api("/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        state.selectedAgentId = result.agent.id;
        $("agent-dialog").close();
        await refreshAgents();
        renderAgentDetail(result.agent);
      } catch (error) { showOutput(error.message); }
    });
    $("agent-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-agent-id]");
      if (item) renderAgentDetail(state.agents.find((agent) => agent.id === item.dataset.agentId));
    });
    for (const [buttonId, action] of [["agent-enable", "enable"], ["agent-disable", "disable"], ["agent-quarantine", "quarantine"]]) {
      $(buttonId).addEventListener("click", async () => {
        if (!state.selectedAgentId) return;
        await api("/agents/" + encodeURIComponent(state.selectedAgentId) + "/lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
        await refreshAgents();
      });
    }

    $("refresh-skills").addEventListener("click", () => refreshSkills().catch((error) => showOutput(error.message)));
    $("skill-query").addEventListener("input", () => refreshSkills().catch((error) => showOutput(error.message)));
    document.querySelectorAll(".skill-filter").forEach((button) => button.addEventListener("click", () => {
      state.skillFilter = button.dataset.skillFilter || "all";
      document.querySelectorAll(".skill-filter").forEach((item) => item.classList.toggle("active", item === button));
      refreshSkills().catch((error) => showOutput(error.message));
    }));

    async function validateSkillDraft() {
      const result = await api("/skills/workshop/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("skill-draft-name").value, description: $("skill-draft-description").value, instructions: $("skill-draft-instructions").value }) });
      state.skillDraft = result;
      $("workshop-status").textContent = result.valid ? "valid" : "needs work";
      $("workshop-status").className = "chip " + (result.valid ? "ok" : "danger");
      $("save-skill-draft").disabled = !result.valid;
      $("skill-validation").className = result.valid ? "item" : "empty-state";
      $("skill-validation").innerHTML = result.valid ? '<strong>Package is valid</strong><span class="muted">SHA-256 ' + escapeHtml(result.digest) + '</span>' : '<strong>Validation failed</strong><span>' + escapeHtml(result.errors.join(" · ")) + '</span>';
      $("skill-preview").textContent = result.content;
      return result;
    }
    $("validate-skill").addEventListener("click", () => validateSkillDraft().catch((error) => showOutput(error.message)));
    $("save-skill-draft").addEventListener("click", async () => {
      const result = state.skillDraft?.valid ? state.skillDraft : await validateSkillDraft();
      if (!result.valid) return;
      const saved = await api("/skills/workshop/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("skill-draft-name").value, description: $("skill-draft-description").value, instructions: $("skill-draft-instructions").value }) });
      showOutput(saved);
      await refreshSkills();
      switchView("skills");
    });
    refresh();
  </script>
</body>
</html>
`;
}

function invocationRoot() {
  return resolve(process.env.INIT_CWD ?? process.cwd());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.ODINN_HOST ?? "127.0.0.1";
  assertLoopbackHost(host);
  const port = Number.parseInt(process.env.ODINN_PORT ?? "18790", 10);
  const stateDir = resolve(invocationRoot(), process.env.ODINN_STATE_DIR ?? ".odinn");
  const server = await createGatewayServer({ stateDir, workspaceRoot: invocationRoot() });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error: any) => {
      if (error) console.error(error);
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, host, () => {
    console.log(JSON.stringify({ ok: true, host, port: (server.address() as any).port, stateDir }, null, 2));
  });
}

function assertLoopbackHost(host: any) {
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
  if (loopback.has(host) || process.env.ODINN_ALLOW_REMOTE === "1") return;
  throw new Error(`refusing non-loopback gateway host ${host}; set ODINN_ALLOW_REMOTE=1 to override`);
}
