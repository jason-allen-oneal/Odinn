import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, rename, rm, stat as statPath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApprovalStore, createAuditStore, createBuiltInRegistry, createDifferentiatedRuntime, createIsolatedTaskExecutor, ExtensionRegistry, JobSupervisor, listConfiguredModels, normalizeExperimentalFlags, normalizeModelConfig, normalizeSelfImprovementConfig, oauthTokenPath, ProofVerifier, runTask as executeTask, SkillPackageStore, toolSafetyDescriptor, validatePolicy, validateSkillPackage, withStateMutationLock } from "@odinn/kernel";
import { createDefaultPolicy, evaluateTaskPolicy } from "@odinn/policy";
import { FileJobStore, ensureSecureStateDirectory } from "@odinn/store-file";

const DEFAULT_REQUEST_MAX_BYTES = 65_536;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const PACKAGE_FILE = fileURLToPath(new URL("../../../package.json", import.meta.url));

async function productVersion() {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_FILE, "utf8"));
    return String(pkg.version || "development");
  } catch {
    return String(process.env.ODINN_VERSION || "development");
  }
}

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
  const sources = [
    { directory: root, status: "unmanaged", source: "workspace" },
    { directory: join(state, "skill-workshop"), status: "draft", source: "legacy-draft" },
    { directory: join(state, "imports"), status: "unmanaged", source: "import" }
  ];
  const stateRoot = resolve(state);
  const walk = async (directory: string, depth: number, descriptor: any) => {
    if (depth > 9 || results.length >= 250) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (descriptor.source === "workspace" && resolve(path) === stateRoot) continue;
      if (entry.isDirectory()) await walk(path, depth + 1, descriptor);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        const content = await readFile(path, "utf8");
        const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(content)?.[1] || "";
        const name = /^name:\s*["']?([^\n"']+)/mu.exec(frontmatter)?.[1]?.trim() || path.split(sep).at(-2) || "skill";
        const description = /^description:\s*["']?([^\n"']+)/mu.exec(frontmatter)?.[1]?.trim() || "No description";
        results.push({ id: createHash("sha256").update(path).digest("hex").slice(0, 16), name, description, path, bytes: Buffer.byteLength(content), status: descriptor.status, source: descriptor.source });
      }
    }
  };
  for (const descriptor of sources) await walk(descriptor.directory, 0, descriptor);
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

function auditEventOutcome(event: any) {
  if (["task.failed", "plan.failed"].includes(event.type)) return "failed";
  if (event.type === "task.blocked" || event.decision === "deny") return "denied";
  if (event.type === "task.approval_required") return "approval";
  if (["task.completed", "plan.completed"].includes(event.type)) return "completed";
  if (["task.started", "plan.started"].includes(event.type)) return "running";
  return "recorded";
}

function auditEventTokens(event: any) {
  if (event.type !== "task.completed") return 0;
  const usage = event.data?.output?.usage;
  const total = Number(usage?.totalTokens ?? usage?.total_tokens ?? usage?.total ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(usage?.inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const output = Number(usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  return Number.isFinite(input + output) ? input + output : 0;
}

function summarizeAuditEvents(events: any[]) {
  const runIds = new Set(events.map((event) => event.runId).filter(Boolean));
  const modelRuns = new Set(events
    .filter((event) => event.type === "task.completed" && ["model.chat", "agent.run"].includes(event.tool))
    .map((event) => event.runId));
  const errorEvents = events.filter((event) => ["failed", "denied"].includes(auditEventOutcome(event)));
  return {
    events: events.length,
    runs: runIds.size,
    modelRuns: modelRuns.size,
    errors: errorEvents.length,
    totalTokens: events.reduce((sum, event) => sum + auditEventTokens(event), 0),
    firstAt: events[0]?.at ?? null,
    lastAt: events.at(-1)?.at ?? null
  };
}

function auditFacet(events: any[], key: string) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const value = key === "outcome" ? auditEventOutcome(event) : String(event[key] || "").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function queryAuditEvents(events: any[], url: URL) {
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const type = String(url.searchParams.get("type") || "").trim();
  const tool = String(url.searchParams.get("tool") || "").trim();
  const actor = String(url.searchParams.get("actor") || "").trim();
  const outcome = String(url.searchParams.get("outcome") || "").trim();
  const from = Date.parse(url.searchParams.get("from") || "");
  const to = Date.parse(url.searchParams.get("to") || "");
  const filtered = events.filter((event) => {
    const at = Date.parse(event.at || "");
    return (!query || JSON.stringify(event).toLowerCase().includes(query))
      && (!type || event.type === type)
      && (!tool || event.tool === tool)
      && (!actor || event.actor === actor)
      && (!outcome || auditEventOutcome(event) === outcome)
      && (!Number.isFinite(from) || at >= from)
      && (!Number.isFinite(to) || at <= to + 86_399_999);
  });
  const pageSize = Math.max(10, Math.min(100, Number.parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const sorted = filtered.slice().sort((left, right) => String(right.at).localeCompare(String(left.at)));
  const offset = (page - 1) * pageSize;
  return {
    events: sorted.slice(offset, offset + pageSize),
    pagination: { page, pageSize, pages, total: filtered.length, from: filtered.length ? offset + 1 : 0, to: Math.min(offset + pageSize, filtered.length) },
    summary: summarizeAuditEvents(events),
    filteredSummary: summarizeAuditEvents(filtered),
    facets: {
      types: auditFacet(events, "type"),
      tools: auditFacet(events, "tool"),
      actors: auditFacet(events, "actor"),
      outcomes: auditFacet(events, "outcome")
    }
  };
}

function classifyTask(run: any) {
  const systemReadTools = new Set([
    "session.list", "session.read", "memory.search", "memory.browse", "memory.curate", "memory.candidates",
    "goal.list", "project.list", "job.healthcheck", "browser.tabs", "browser.snapshot", "improve.list"
  ]);
  if (run.actor === "gateway" && systemReadTools.has(run.tool)) return "system";
  if (/^(?:autonomous|automatic|automation)/u.test(String(run.actor || "")) || run.actor === "cron") return "automation";
  if (run.actor === "agent" || run.tool === "agent.run" || run.tool === "model.chat") return "agent";
  return "user";
}

function taskTitle(tool: string) {
  const labels: Record<string, string> = {
    "agent.run": "Agent response", "model.chat": "Model response", "web.search": "Web search", "web.fetch": "Read webpage",
    "session.create": "Create session", "session.message": "Save message", "memory.remember": "Store memory", "memory.compact": "Compact session memory", "memory.forget": "Forget memory"
  };
  return labels[tool] || String(tool || "Task").split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" · ");
}

function taskStatusMatches(value: string, filter: string) {
  if (!filter || filter === "all") return true;
  if (filter === "active") return ["queued", "running", "cancelling", "awaiting_approval"].includes(value);
  if (filter === "review") return ["failed", "denied", "blocked", "cancelled", "needs-review"].includes(value);
  return value === filter;
}

function summarizeTasks(runs: any[], events: any[], jobs: any[], registry: any, includeSystem: boolean) {
  const eventsByRun = new Map<string, any[]>();
  for (const event of events) {
    const current = eventsByRun.get(event.runId) ?? [];
    current.push(event);
    eventsByRun.set(event.runId, current);
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const runIds = new Set(runs.map((run) => run.id));
  const allRuns = runs.slice();
  for (const job of jobs) {
    if (runIds.has(job.id)) continue;
    const task = job.payload?.task && typeof job.payload.task === "object" ? job.payload.task : {};
    allRuns.push({
      id: job.id,
      tool: task.tool || "job",
      status: job.status,
      actor: task.actor || "job",
      startedAt: job.startedAt || job.createdAt,
      lastEventAt: job.updatedAt || job.completedAt || job.createdAt,
      eventCount: 0,
      message: job.error || ""
    });
  }
  return allRuns.map((run) => {
    const runEvents = eventsByRun.get(run.id) ?? [];
    const started = runEvents.find((event) => ["task.started", "plan.started"].includes(event.type));
    const finished = [...runEvents].reverse().find((event) => ["task.completed", "task.failed", "task.blocked", "plan.completed", "plan.failed"].includes(event.type));
    const startedAt = run.startedAt || started?.at;
    const updatedAt = run.lastEventAt || finished?.at || startedAt;
    const durationMs = startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : null;
    const category = classifyTask(run);
    const safety = toolSafetyDescriptor(run.tool, registry.get(run.tool));
    const proofEvents = runEvents.filter((event) => /^(?:proof\.|verification\.|snapshot\.|artifact\.)/u.test(event.type));
    const job: any = jobsById.get(run.id);
    return {
      id: run.id,
      title: taskTitle(run.tool),
      tool: run.tool,
      status: run.status,
      actor: run.actor || "local",
      category,
      startedAt: startedAt ?? null,
      updatedAt: updatedAt ?? null,
      durationMs,
      eventCount: run.eventCount ?? runEvents.length,
      evidenceCount: proofEvents.length,
      message: run.message || finished?.message || "",
      replayable: safety.retrySafe === true && Boolean(started?.data?.input),
      replayReason: safety.retrySafe !== true
        ? "Tool is not declared retry-safe"
        : started?.data?.input ? "Recorded input is retry-safe" : "No audited task input is available",
      cancellable: Boolean(job && ["queued", "running", "cancelling"].includes(job.status)),
      source: job ? "job" : category,
      events: runEvents
    };
  }).filter((task) => includeSystem || task.category !== "system");
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
  const version = await productVersion();
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
  const skillStore = new SkillPackageStore(state);
  const extensionRegistry = new ExtensionRegistry(join(state, "extensions.json"));
  const runControlTask = (task: any) => executeTask({ task, auditStore, policy, registry });
  await supervisor.start();
  const cronTimer = setInterval(() => runDueCronJobs(cronStore, isolatedTaskExecutor).catch(() => undefined), 30_000);
  cronTimer.unref();
  const selfImprovement = normalizeSelfImprovementConfig(config.selfImprovement);
  let improvementCycle: Promise<any> | undefined;
  const runImprovementCycle = () => {
    if (improvementCycle) return improvementCycle;
    improvementCycle = runControlTask({
      tool: "improve.learn",
      input: { limit: 1000 },
      actor: "autonomous-improvement"
    }).catch(() => undefined).finally(() => { improvementCycle = undefined; });
    return improvementCycle;
  };
  const automaticImprovement = selfImprovement.enabled && selfImprovement.mode === "auto";
  const improvementStartupTimer = automaticImprovement ? setTimeout(runImprovementCycle, 2_000) : undefined;
  improvementStartupTimer?.unref?.();
  const improvementTimer = automaticImprovement
    ? setInterval(runImprovementCycle, selfImprovement.intervalMs)
    : undefined;
  improvementTimer?.unref?.();

  const server: any = createServer(async (request: any, response: any) => {
    const requestId = String(request.headers["x-odinn-request-id"] || randomUUID());
    response.setHeader("x-odinn-request-id", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!validHostHeader(request)) return json(response, 421, { ok: false, error: "invalid gateway Host header" });
      if (request.method === "GET" && url.pathname === "/odinn-logo.png") {
        return image(response, 200, await readFile(join(PUBLIC_DIR, "odinn-logo.png")), "image/png");
      }
      if (request.method === "GET" && url.pathname === "/") {
        return html(response, 200, renderConsoleHtml(version), {
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
      if (request.method === "GET" && url.pathname === "/config") {
        const editable = await readEditableConfig(state);
        return json(response, 200, {
          ok: true,
          ...editable,
          restartRequired: !configsMatch(editable.config, config)
        });
      }
      if (request.method === "PUT" && url.pathname === "/config") {
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        const saved = await writeEditableConfig(state, body);
        return json(response, 200, {
          ok: true,
          ...saved,
          restartRequired: !configsMatch(saved.config, config)
        });
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return json(response, 200, {
          ok: true,
          version,
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
          selfImprovement: {
            ...selfImprovement,
            automatic: automaticImprovement,
            advisor: normalizeModelConfig(config).defaultModel
              ? { source: "configured-provider", model: normalizeModelConfig(config).defaultModel }
              : { source: "waiting-for-provider", model: "" }
          },
          pendingApprovals: approvalStore.list()
        });
      }
      if (request.method === "GET" && url.pathname === "/diagnostics") {
        return json(response, 200, await diagnostics({ state, config, featureFlags, auditStore, approvalStore, supervisor }));
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
        const [managed, files, extensions] = await Promise.all([skillStore.list(), discoverSkills(root, state), extensionRegistry.list()]);
        return json(response, 200, {
          sdkVersion: "0.1",
          skills: [
            ...managed.map((skill: any) => ({ ...skill, source: "managed", path: join(skill.packagePath, "SKILL.md") })),
            ...files,
            ...extensions.filter((extension: any) => extension.type === "skill").map((extension: any) => ({ ...extension, source: "legacy-extension", status: "unmanaged", path: extension.entrypoint }))
          ]
        });
      }
      if (request.method === "POST" && url.pathname === "/skills/validate") {
        return json(response, 200, { ok: true, ...validateSkillPackage(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "POST" && url.pathname === "/skills") {
        return json(response, 200, { ok: true, skill: await skillStore.install(await readJson(request, { maxBytes: requestMaxBytes })) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/skills/") && url.pathname.endsWith("/verify")) {
        const id = decodeURIComponent(url.pathname.slice("/skills/".length, -"/verify".length));
        return json(response, 200, await skillStore.verify(id));
      }
      if (request.method === "POST" && url.pathname.startsWith("/skills/") && url.pathname.endsWith("/lifecycle")) {
        const id = decodeURIComponent(url.pathname.slice("/skills/".length, -"/lifecycle".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, { ok: true, skill: await skillStore.transition(id, body.action) });
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
        if (featureFlags.proof !== true) throw new GatewayError(409, "experimental.proof is disabled; enable it in config and restart the gateway");
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
            run: async (runId: string, contract: any, { workspaceRoot = root }: any = {}) => {
              if (featureFlags.proof !== true) throw new GatewayError(409, "experimental.proof is disabled; counterfactual verification cannot run");
              return new ProofVerifier({
                runLedger: runtime.ledger,
                allowedRoot: workspaceRoot,
                allowedCommands: config.proof?.allowedCommands ?? []
              }).verify({ ...contract, runId });
            }
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
        const safety = toolSafetyDescriptor(started.tool, registry.get(started.tool));
        if (safety.retrySafe !== true) return json(response, 409, { ok: false, error: `tool ${started.tool} is not declared retry-safe and cannot be replayed from the console` });
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
      if (request.method === "GET" && url.pathname === "/audit/query") {
        return json(response, 200, queryAuditEvents(await auditStore.readAll(), url));
      }
      if (request.method === "GET" && url.pathname === "/audit/verify") {
        return json(response, 200, await auditStore.verifyIntegrity());
      }
      if (request.method === "GET" && url.pathname === "/usage") {
        const events = await auditStore.readAll();
        const runs = await auditStore.readRuns();
        const summary = summarizeAuditEvents(events);
        const days = [];
        for (let offset = 13; offset >= 0; offset -= 1) {
          const day = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
          const dayEvents = events.filter((event: any) => String(event.at || "").startsWith(day));
          days.push({ day, events: dayEvents.length, tokens: dayEvents.reduce((sum: number, event: any) => sum + auditEventTokens(event), 0) });
        }
        return json(response, 200, { summary, days, runs: runs.filter((run: any) => ["model.chat", "agent.run"].includes(run.tool)).slice(0, 25) });
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        const includeSystem = url.searchParams.get("includeSystem") === "true";
        const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
        const pageSize = Math.min(100, Math.max(5, Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10) || 25));
        const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
        const status = String(url.searchParams.get("status") || "all");
        const category = String(url.searchParams.get("category") || "all");
        const [runs, events, jobs] = await Promise.all([auditStore.readRuns(), auditStore.readAll(), supervisor.list()]);
        const allTasks = summarizeTasks(runs, events, jobs, registry, includeSystem);
        const filtered = allTasks
          .filter((task: any) => taskStatusMatches(task.status, status))
          .filter((task: any) => category === "all" || task.category === category)
          .filter((task: any) => !query || [task.title, task.tool, task.message, task.actor, task.category].some((value) => String(value || "").toLowerCase().includes(query)))
          .sort((left: any, right: any) =>
            String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
            || String(right.id || "").localeCompare(String(left.id || "")));
        const total = filtered.length;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const currentPage = Math.min(page, pages);
        const offset = (currentPage - 1) * pageSize;
        const tasks = filtered.slice(offset, offset + pageSize).map(({ events: _events, ...task }: any) => task);
        return json(response, 200, {
          tasks,
          summary: {
            total,
            running: filtered.filter((task: any) => ["queued", "running", "cancelling", "awaiting_approval"].includes(task.status)).length,
            completed: filtered.filter((task: any) => task.status === "completed").length,
            needsReview: filtered.filter((task: any) => ["failed", "denied", "blocked", "cancelled", "needs-review"].includes(task.status)).length
          },
          pagination: {
            page: currentPage,
            pageSize,
            pages,
            total,
            from: total ? offset + 1 : 0,
            to: Math.min(offset + pageSize, total)
          }
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/tasks/")) {
        const id = decodeURIComponent(url.pathname.slice("/tasks/".length));
        const [run, job] = await Promise.all([auditStore.readRun(id), supervisor.get(id)]);
        if (!run && !job) return json(response, 404, { ok: false, error: "task not found" });
        const tasks = summarizeTasks(run ? [run] : [], run?.events || [], job ? [job] : [], registry, true);
        const ledger = runtime.ledger.getRun(id);
        return json(response, 200, { task: tasks[0] ?? job, run, job, ledger });
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
        const scopeType = url.searchParams.get("scopeType") ?? "";
        const scopeId = url.searchParams.get("scopeId") ?? "";
        const projectId = url.searchParams.get("projectId") ?? "";
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runTask({
          task: { tool: "memory.search", input: { query, kind, subject, scopeType, scopeId, projectId, sessionId, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/memory/recall") {
        const query = url.searchParams.get("query") ?? "";
        const kind = url.searchParams.get("kind") ?? "";
        const projectId = url.searchParams.get("projectId") ?? "";
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "8", 10);
        return json(response, 200, (await runTask({
          task: { tool: "memory.recall", input: { query, kind, projectId, sessionId, limit }, actor: "gateway" },
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
      if (request.method === "GET" && url.pathname === "/memory/status") {
        const allows = (toolName: string, input: any = {}) => evaluateTaskPolicy({
          policy,
          request: { tool: toolName, input },
          tool: registry.get(toolName)
        }).allowed;
        const agentRun = allows("agent.run");
        const readAllowed = ["memory.curate", "memory.search", "memory.browse", "memory.open", "memory.candidates"].every((toolName) => allows(toolName));
        const writeAllowed = ["memory.remember", "memory.correct", "memory.forget", "memory.suggest", "memory.decide"].every((toolName) => allows(toolName));
        const integration = {
          agentRun,
          readAllowed,
          writeAllowed,
          recallAllowed: allows("memory.recall"),
          compactAllowed: allows("memory.compact"),
          autoRecall: agentRun && allows("memory.recall") && config.memory?.autoRecall !== false,
          autoLearn: agentRun && allows("memory.suggest") && config.memory?.autoLearn !== false,
          autoCompact: agentRun && allows("memory.compact") && config.memory?.autoCompact !== false
        };
        if (!integration.readAllowed) return json(response, 200, { working: false, records: null, namespaces: null, latestAt: null, integration });
        const curated = await runTask({ task: { tool: "memory.curate", input: { limit: 1000 }, actor: "gateway" }, auditStore, policy, registry });
        const records = Object.values(curated.output.kinds || {}).flat() as any[];
        const namespaces = new Set<string>();
        for (const record of records) {
          const parts = String(record.namespace || "general").split("/").filter(Boolean);
          for (let index = 1; index <= parts.length; index += 1) namespaces.add(parts.slice(0, index).join("/"));
        }
        return json(response, 200, {
          working: true,
          records: curated.output.count || 0,
          namespaces: namespaces.size,
          latestAt: records.map((record) => record.at).filter(Boolean).sort().at(-1) || null,
          integration
        });
      }
      if (request.method === "GET" && url.pathname.startsWith("/memory/") && !["/memory/recall", "/memory/browse", "/memory/curated", "/memory/status", "/memory/candidates"].includes(url.pathname)) {
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
      if (request.method === "GET" && url.pathname === "/memory/candidates") {
        const status = url.searchParams.get("status") ?? "pending";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        return json(response, 200, (await runTask({
          task: { tool: "memory.candidates", input: { status, limit }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/memory/candidates/") && url.pathname.endsWith("/decision")) {
        const candidateId = decodeURIComponent(url.pathname.slice("/memory/candidates/".length, -"/decision".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, (await runTask({
          task: { tool: "memory.decide", input: { ...body, candidateId }, actor: "gateway" },
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
      if (request.method === "POST" && url.pathname.startsWith("/memory/") && url.pathname.endsWith("/forget")) {
        const targetId = decodeURIComponent(url.pathname.slice("/memory/".length, -"/forget".length));
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, (await runTask({
          task: { tool: "memory.forget", input: { ...body, targetId }, actor: "gateway" },
          auditStore,
          policy,
          registry
        })).output);
      }
      if (request.method === "GET" && url.pathname === "/sessions") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const projectId = url.searchParams.get("projectId") ?? "";
        return json(response, 200, (await runTask({
          task: { tool: "session.list", input: { limit, projectId }, actor: "gateway" },
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
        const body = await readJson(request, { maxBytes: requestMaxBytes });
        return json(response, 200, (await runTask({
          task: { tool: "session.update", input: { ...body, sessionId: id }, actor: "gateway" },
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
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const projectId = url.searchParams.get("projectId") ?? "";
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const status = url.searchParams.get("status") ?? "";
        return json(response, 200, (await runTask({
          task: { tool: "goal.list", input: { limit, projectId, sessionId, status }, actor: "gateway" },
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
      if (request.method === "GET" && url.pathname === "/projects") {
        const includeArchived = url.searchParams.get("includeArchived") === "true";
        return json(response, 200, (await runTask({ task: { tool: "project.list", input: { includeArchived, limit: 100 }, actor: "gateway" }, auditStore, policy, registry })).output);
      }
      if (request.method === "POST" && url.pathname === "/projects") {
        return json(response, 200, (await runTask({ task: { tool: "project.create", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" }, auditStore, policy, registry })).output);
      }
      if (request.method === "PATCH" && url.pathname.startsWith("/projects/")) {
        const id = decodeURIComponent(url.pathname.slice("/projects/".length));
        return json(response, 200, (await runTask({ task: { tool: "project.update", input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), projectId: id }, actor: "gateway" }, auditStore, policy, registry })).output);
      }
      if (request.method === "GET" && url.pathname === "/improvements") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        return json(response, 200, (await runControlTask({ tool: "improve.list", input: { limit }, actor: "gateway" })).output);
      }
      if (request.method === "POST" && url.pathname === "/improvements") {
        return json(response, 200, (await runControlTask({ tool: "improve.propose", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" })).output);
      }
      if (request.method === "POST" && url.pathname === "/improvements/learn") {
        return json(response, 200, (await runControlTask({ tool: "improve.learn", input: await readJson(request, { maxBytes: requestMaxBytes }), actor: "gateway" })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/improvements/") && url.pathname.endsWith("/decisions")) {
        const id = decodeURIComponent(url.pathname.slice("/improvements/".length, -"/decisions".length));
        return json(response, 200, (await runControlTask({
          tool: "improve.decide",
          input: { ...(await readJson(request, { maxBytes: requestMaxBytes })), improvementId: id },
          actor: "gateway"
        })).output);
      }
      if (request.method === "POST" && url.pathname.startsWith("/improvements/") && url.pathname.endsWith("/rollback")) {
        const id = decodeURIComponent(url.pathname.slice("/improvements/".length, -"/rollback".length));
        return json(response, 200, (await runControlTask({
          tool: "improve.rollback",
          input: { improvementId: id, source: "gateway" },
          actor: "gateway"
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
          sendEvent("error", publicError(error, requestId));
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
      return json(response, error.status ?? 400, publicError(error, requestId));
    }
  });

  const close = server.close.bind(server);
  server.close = (callback: any) => {
    if (improvementStartupTimer) clearTimeout(improvementStartupTimer);
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
      response.write(`event: error\ndata: ${JSON.stringify(publicError(error, String(request.headers["x-odinn-request-id"] || "audit-stream")))}\n\n`);
    }
  }, 500);
  request.on("close", () => clearInterval(poll));
}

async function readConfig(state: any) {
  const path = join(state, "config.json");
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    validateGatewayConfig(config);
    await chmod(path, 0o600);
    return config;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return withStateMutationLock(state, async () => {
      try {
        const existing = JSON.parse(await readFile(path, "utf8"));
        validateGatewayConfig(existing);
        await chmod(path, 0o600);
        return existing;
      } catch (readError: any) {
        if (readError?.code !== "ENOENT") throw readError;
      }
      await mkdir(state, { recursive: true });
      const config = { version: 1, policy: createDefaultPolicy(), auditLog: "audit.jsonl", providers: {}, defaultModel: "", experimental: { proof: false, rewind: false, sentinel: false, capsules: false, darwin: false, capabilities: false, counterfactual: false }, selfImprovement: normalizeSelfImprovementConfig() };
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await chmod(path, 0o600);
      return config;
    });
  }
}

function assertConfigObject(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "config must be a JSON object");
  }
}

function assertConfigRecord(value: any, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, `${label} must be a JSON object`);
  }
}

function assertConfigStringArray(value: any, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GatewayError(400, `${label} must be an array of strings`);
  }
}

function assertOptionalConfigBoolean(record: any, key: string, label: string) {
  if (record[key] !== undefined && typeof record[key] !== "boolean") {
    throw new GatewayError(400, `${label}.${key} must be true or false`);
  }
}

function validateGatewayConfig(config: any) {
  assertConfigObject(config);
  if (config.version !== undefined && config.version !== 1) {
    throw new GatewayError(400, "config.version must be 1");
  }
  if (config.auditLog !== undefined && (typeof config.auditLog !== "string" || !/^(?:audit|audit[-_.][a-z0-9][a-z0-9._-]{0,110})\.jsonl$/i.test(config.auditLog))) {
    throw new GatewayError(400, "config.auditLog must be audit.jsonl or an audit-*.jsonl filename");
  }
  if (config.defaultModel !== undefined && typeof config.defaultModel !== "string") {
    throw new GatewayError(400, "config.defaultModel must be a string");
  }

  if (config.providers !== undefined) {
    assertConfigRecord(config.providers, "config.providers");
    for (const [name, provider] of Object.entries(config.providers) as Array<[string, any]>) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
        throw new GatewayError(400, `config.providers contains an invalid provider name: ${name}`);
      }
      assertConfigRecord(provider, `config.providers.${name}`);
      for (const key of ["type", "baseUrl", "apiKeyEnv", "transport"]) {
        if (provider[key] !== undefined && typeof provider[key] !== "string") {
          throw new GatewayError(400, `config.providers.${name}.${key} must be a string`);
        }
      }
      if (provider.models !== undefined) assertConfigStringArray(provider.models, `config.providers.${name}.models`);
      if (provider.auth !== undefined) assertConfigRecord(provider.auth, `config.providers.${name}.auth`);
    }
  }

  let normalizedModels;
  try {
    normalizedModels = normalizeModelConfig(config);
    for (const provider of Object.values(normalizedModels.providers) as any[]) {
      if (["oauth", "device"].includes(provider.auth?.mode)) oauthTokenPath(provider, ".");
    }
  } catch (error) {
    throw new GatewayError(400, error instanceof Error ? error.message : "model provider configuration is invalid");
  }

  if (config.policy !== undefined) {
    assertConfigRecord(config.policy, "config.policy");
    if (config.policy.deniedTools !== undefined) assertConfigStringArray(config.policy.deniedTools, "config.policy.deniedTools");
    if (config.policy.allowedCapabilities !== undefined) assertConfigStringArray(config.policy.allowedCapabilities, "config.policy.allowedCapabilities");
    if (config.policy.maxInputBytes !== undefined && (!Number.isSafeInteger(config.policy.maxInputBytes) || config.policy.maxInputBytes < 1)) {
      throw new GatewayError(400, "config.policy.maxInputBytes must be a positive integer");
    }
    if (config.policy.security !== undefined) {
      assertConfigRecord(config.policy.security, "config.policy.security");
      for (const surfaceName of ["web", "browser"]) {
        const surface = config.policy.security[surfaceName];
        if (surface === undefined) continue;
        assertConfigRecord(surface, `config.policy.security.${surfaceName}`);
        for (const key of ["enabled", "allowPrivateNetwork", "requireApproval", "allowDownloads", "allowUploads"]) {
          assertOptionalConfigBoolean(surface, key, `config.policy.security.${surfaceName}`);
        }
        for (const key of ["allowedDomains", "blockedDomains"]) {
          if (surface[key] !== undefined) assertConfigStringArray(surface[key], `config.policy.security.${surfaceName}.${key}`);
        }
      }
    }
    createDefaultPolicy(config.policy);
  }

  if (config.proof !== undefined) {
    assertConfigRecord(config.proof, "config.proof");
    if (config.proof.allowedCommands !== undefined) {
      if (!Array.isArray(config.proof.allowedCommands) || config.proof.allowedCommands.some((command: any) =>
        !Array.isArray(command) || command.length === 0 || command.some((part: any) => typeof part !== "string") || !isAbsolute(command[0]))) {
        throw new GatewayError(400, "config.proof.allowedCommands must contain exact argument arrays beginning with an absolute executable path");
      }
    }
  }

  if (config.experimental !== undefined) {
    assertConfigRecord(config.experimental, "config.experimental");
    for (const key of ["proof", "rewind", "sentinel", "capsules", "darwin", "capabilities", "counterfactual"]) {
      assertOptionalConfigBoolean(config.experimental, key, "config.experimental");
    }
    normalizeExperimentalFlags(config.experimental);
  }

  if (config.selfImprovement !== undefined) {
    assertConfigRecord(config.selfImprovement, "config.selfImprovement");
    assertOptionalConfigBoolean(config.selfImprovement, "enabled", "config.selfImprovement");
    assertOptionalConfigBoolean(config.selfImprovement, "rollbackOnFailure", "config.selfImprovement");
    if (config.selfImprovement.mode !== undefined && !["disabled", "propose", "auto"].includes(config.selfImprovement.mode)) {
      throw new GatewayError(400, "config.selfImprovement.mode must be disabled, propose, or auto");
    }
    for (const [key, minimum, maximum] of [["intervalMs", 30_000, 86_400_000], ["maxChangesPerCycle", 1, 3]] as const) {
      const value = config.selfImprovement[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
        throw new GatewayError(400, `config.selfImprovement.${key} must be an integer from ${minimum} through ${maximum}`);
      }
    }
    normalizeSelfImprovementConfig(config.selfImprovement);
  }

  if (config.runtime !== undefined) {
    assertConfigRecord(config.runtime, "config.runtime");
    if (config.runtime.modelRetries !== undefined && (!Number.isSafeInteger(config.runtime.modelRetries) || config.runtime.modelRetries < 0 || config.runtime.modelRetries > 4)) {
      throw new GatewayError(400, "config.runtime.modelRetries must be an integer from 0 through 4");
    }
  }

  if (config.memory !== undefined) {
    assertConfigRecord(config.memory, "config.memory");
    for (const key of ["autoRecall", "autoLearn", "autoCompact"]) assertOptionalConfigBoolean(config.memory, key, "config.memory");
  }
}

function configFingerprint(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

function canonicalConfig(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalConfig(value[key])]));
}

function configsMatch(left: any, right: any) {
  return JSON.stringify(canonicalConfig(left)) === JSON.stringify(canonicalConfig(right));
}

async function openEditableConfigFile(path: string) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new GatewayError(409, "config.json is not a regular private file");
    }
    return handle;
  } catch (error: any) {
    await handle?.close().catch(() => undefined);
    if (error instanceof GatewayError) throw error;
    if (["ELOOP", "EMLINK"].includes(String(error?.code ?? ""))) {
      throw new GatewayError(409, "config.json must not be a symbolic link");
    }
    throw error;
  }
}

async function readEditableConfig(state: string) {
  const path = join(state, "config.json");
  const handle = await openEditableConfigFile(path);
  let contents;
  try {
    contents = await handle.readFile("utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    throw new GatewayError(409, "config.json is not valid JSON");
  }
  validateGatewayConfig(config);
  return { config, fingerprint: configFingerprint(contents) };
}

async function writeEditableConfig(state: string, input: any) {
  validateGatewayConfig(input?.config);
  const expectedFingerprint = String(input?.fingerprint ?? "");
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new GatewayError(400, "a current config fingerprint is required");
  }
  const serialized = `${JSON.stringify(input.config, null, 2)}\n`;
  return withStateMutationLock(state, async () => {
    const path = join(state, "config.json");
    const handle = await openEditableConfigFile(path);
    let current;
    try {
      current = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (configFingerprint(current) !== expectedFingerprint) {
      throw new GatewayError(409, "config changed after this page loaded; reload it before saving");
    }
    const temporary = join(state, `.config.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { config: input.config, fingerprint: configFingerprint(serialized) };
  });
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

async function diagnostics({ state, config, featureFlags, auditStore, approvalStore, supervisor }: any) {
  let audit = { valid: true, events: 0, unsigned: 0, failureCount: 0 };
  try {
    const auditPath = join(state, config.auditLog ?? "audit.jsonl");
    if (await access(auditPath).then(() => true).catch(() => false)) {
      const verification: any = await auditStore.verifyIntegrity({ allowUnsigned: true });
      audit = { valid: verification.valid, events: verification.events, unsigned: verification.unsigned, failureCount: verification.failures?.length ?? 0 };
    }
  } catch { audit = { valid: false, events: 0, unsigned: 0, failureCount: 1 }; }
  const jobs = await supervisor.list();
  const pendingApprovals = approvalStore.list();
  let recovery: any = { status: "clear" };
  try { recovery = JSON.parse(await readFile(join(state, "browser-recovery.json"), "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") recovery = { status: "unavailable" }; }
  let ownerOnly = false;
  try { ownerOnly = ((await statPath(state)).mode & 0o077) === 0; } catch {}
  const normalized = normalizeModelConfig(config);
  let version = "unknown";
  try { version = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")).version ?? version; } catch {}
  let commit = process.env.ODINN_COMMIT ?? "";
  if (!commit) {
    try { commit = JSON.parse(await readFile(new URL("../../../install-metadata.json", import.meta.url), "utf8")).commit ?? ""; } catch {}
  }
  return {
    ok: audit.valid,
    command: "diagnostics",
    version,
    commit: commit || "unknown",
    platform: { os: process.platform, arch: process.arch, node: process.version },
    providerMode: await Promise.all(Object.entries(normalized.providers ?? {}).map(async ([name, provider]: any) => ({
      name,
      type: provider.type ?? "openai-compatible",
      authMode: provider.auth?.mode ?? "api-key",
      configured: provider.auth?.mode === "oauth" ? await oauthTokenExists(provider, state) : !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv]),
      models: provider.models ?? []
    }))),
    experimental: featureFlags,
    audit,
    approvals: { pending: pendingApprovals.length, ids: pendingApprovals.map((approval: any) => approval.id) },
    browserRecovery: { status: recovery.status ?? "clear", pending: ["executing", "unknown"].includes(recovery.status), id: recovery.id ?? undefined },
    jobs: {
      total: jobs.length,
      queued: jobs.filter((job: any) => job.status === "queued").length,
      running: jobs.filter((job: any) => job.status === "running").length,
      failed: jobs.filter((job: any) => job.status === "failed").length,
      needsReview: jobs.filter((job: any) => job.status === "needs-review").length,
      completed: jobs.filter((job: any) => job.status === "completed").length
    },
    state: { ownerOnly, runtimeStateOutsideSourceCheckout: true, secretsExcludedFromDiagnostics: true }
  };
}

function publicError(error: any, requestId: string) {
  const status = Number(error?.status ?? 400);
  const raw = error instanceof Error ? error.message : String(error);
  const code = String(error?.code ?? "");
  const category = code === "BROWSER_RECOVERY_REQUIRED" || /outcome is unknown|uncertain outcome/i.test(raw)
    ? "browser-recovery"
    : code.includes("CAPABILITY") || /policy|approval|disabled/i.test(raw)
      ? "policy"
      : /timeout|timed out/i.test(raw)
        ? "timeout"
        : /browser(?:type|context| tab| proxy)|chromium|playwright|locator\./i.test(raw)
          ? "browser"
        : /provider|model/i.test(raw)
          ? "provider"
          : status === 404 ? "not-found" : status >= 500 ? "runtime" : "validation";
  const safe = error instanceof GatewayError || /experimental\.[a-z-]+ is disabled|request body must be valid JSON|request body exceeds \d+ bytes|origin rejected|gateway authentication required|outcome is unknown|uncertain outcome/i.test(raw)
    ? raw.slice(0, 240)
    : category === "timeout" ? "The operation timed out. Retry it or inspect diagnostics."
      : category === "provider" ? "The provider operation failed. Check the configured provider and retry."
        : category === "browser" ? "The browser operation failed. Check the browser runtime and retry."
        : category === "policy" ? "The operation was blocked by policy or approval state. Review the policy and pending approvals."
          : "The operation failed. Run `odinn doctor` for a safe diagnostic report.";
  return { ok: false, error: safe, category, nextAction: category === "browser-recovery" ? "Inspect and resolve the browser recovery record before retrying." : "Run `odinn doctor` and retry after correcting the reported condition.", requestId };
}

async function oauthTokenExists(provider: any, state: any) {
  try {
    await access(oauthTokenPath(provider, state));
    return true;
  } catch {
    return false;
  }
}

const EXPERIMENTAL_CONSOLE_PAGES = [
  {
    key: "proof",
    view: "lab-run-checks",
    title: "Run Checks",
    technicalName: "Proof",
    summary: "Confirm that completed work produced the files, responses, or repository state you expected.",
    benefit: "Use this when an important run needs a clear pass-or-fail check.",
    steps: ["Choose a recent run", "Pick what should be true", "Review the results"]
  },
  {
    key: "sentinel",
    view: "lab-safety-preview",
    title: "Safety Preview",
    technicalName: "Sentinel",
    summary: "Preview whether a planned action fits your safety rules before anything runs.",
    benefit: "Use this to understand why an action would be allowed or stopped.",
    steps: ["Describe the planned action", "Preview the decision", "Adjust the plan if needed"]
  },
  {
    key: "capabilities",
    view: "lab-temporary-access",
    title: "Temporary Access",
    technicalName: "Capability Tokens",
    summary: "Grant narrow, short-lived permission for one specific action.",
    benefit: "Access expires automatically and can be revoked at any time.",
    steps: ["Choose an action", "Set a short expiry", "Copy the access pass once"]
  },
  {
    key: "rewind",
    view: "lab-restore-points",
    title: "Restore Points",
    technicalName: "Rewind",
    summary: "Save selected workspace files and preview a restore before changing anything.",
    benefit: "Use this before risky local work or when you want an easy way back.",
    steps: ["Create a restore point", "Preview what would change", "Restore only when ready"]
  },
  {
    key: "capsules",
    view: "lab-portable-runs",
    title: "Portable Runs",
    technicalName: "Capsules",
    summary: "Package a completed run so it can be checked or replayed without live tools.",
    benefit: "Useful for sharing, archiving, and reproducing work safely.",
    steps: ["Choose a run", "Create a portable copy", "Check or replay the copy"]
  },
  {
    key: "counterfactual",
    view: "lab-scenario-compare",
    title: "Compare Approaches",
    technicalName: "Counterfactuals",
    summary: "Try multiple approaches in separate workspace copies and compare the outcomes.",
    benefit: "See the evidence side by side before choosing which result to keep.",
    steps: ["Create alternatives", "Run each approach", "Preview and choose a result"]
  },
  {
    key: "darwin",
    view: "lab-model-routing",
    title: "Smart Routing",
    technicalName: "Darwin Router",
    summary: "Learn which configured model works best for different kinds of tasks.",
    benefit: "Recommendations improve as verified outcomes accumulate.",
    steps: ["Record an outcome", "Review what has been learned", "Ask for a recommendation"]
  }
];

function experimentalConsoleNavigation() {
  return EXPERIMENTAL_CONSOLE_PAGES.map((feature) => `
            <button data-view="${feature.view}" data-title="${feature.title}" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-spark"></use></svg></span><span class="nav-label">${feature.title}</span></button>`).join("");
}

function experimentalConsolePages() {
  return EXPERIMENTAL_CONSOLE_PAGES.map((feature) => `
      <section id="view-${feature.view}" class="view" data-experimental-page="${feature.key}">
        <div class="page oc-page">
          <div class="page-head">
            <div><div class="section-kicker">Experimental feature</div><h1>${feature.title}</h1><p>${feature.summary}</p></div>
            <div class="row"><span class="chip warn" data-role="feature-status">Checking status</span><button class="secondary" data-refresh-experimental type="button">Refresh</button></div>
          </div>
          <div class="feature-hero panel">
            <div><span class="feature-eyebrow">Why use it</span><h2>${feature.benefit}</h2></div>
            <ol class="feature-steps">${feature.steps.map((step, index) => `<li><span>${index + 1}</span>${step}</li>`).join("")}</ol>
          </div>
          <div class="experimental-page-layout">
            <div class="panel stack">
              <div class="panel-head"><div><h2>Choose an action</h2><span class="muted">Common workflows for ${feature.title.toLowerCase()}.</span></div></div>
              <div class="feature-action-list" data-role="action-list"></div>
            </div>
            <div class="panel stack feature-workspace">
              <div class="panel-head"><div><h2 data-role="action-title">Choose an action</h2><span class="muted" data-role="action-description">Select an option to get started.</span></div><span class="chip" data-role="action-risk">Guided</span></div>
              <div class="field" data-role="target-field" hidden><label data-role="target-label">What should this use?</label><input data-role="target" autocomplete="off"></div>
              <details class="advanced-options">
                <summary>Advanced options</summary>
                <p>These settings are intended for experienced users. The guided defaults are usually enough.</p>
                <textarea data-role="payload" spellcheck="false">{}</textarea>
              </details>
              <div class="row"><button data-role="run" type="button" disabled>Choose an action</button></div>
              <div class="friendly-result" data-role="result" aria-live="polite"><div class="empty-state"><strong>No result yet</strong><span>Your result will appear here in plain language.</span></div></div>
            </div>
          </div>
        </div>
      </section>`).join("");
}

function renderConsoleHtml(version = "development") {
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
    [hidden] { display: none !important; }
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
    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible,
    [role="button"]:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--blue) 70%, white);
      outline-offset: 2px;
    }
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
    input[type="checkbox"], input[type="radio"] {
      width: auto;
      min-height: auto;
      padding: 0;
      accent-color: var(--accent);
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
      font-size: 12px;
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
      min-height: 0;
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
      font-size: 12px;
    }
    .nav {
      display: grid;
      align-content: start;
      gap: 3px;
      min-height: 0;
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
      font-size: 11px;
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
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-height: 52px;
      padding: 9px 10px;
      border: 1px solid var(--line-soft);
      border-radius: 9px;
      background: #10151d;
      color: var(--text);
      cursor: pointer;
    }
    .menu-chat-main {
      min-width: 0;
    }
    .menu-chat-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      opacity: .5;
      transition: opacity 120ms ease;
    }
    .menu-chat:hover .menu-chat-actions,
    .menu-chat:focus-within .menu-chat-actions,
    .menu-chat.active .menu-chat-actions {
      opacity: 1;
    }
    .chat-action,
    .session-action {
      min-width: 30px;
      min-height: 30px;
      padding: 5px;
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
      font-size: 13px;
    }
    .menu-chat span {
      color: var(--muted);
      font-size: 12px;
    }
    .menu-chat-main {
      display: grid;
      gap: 4px;
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
      font-size: 12px;
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
      font-size: 12px;
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
      font-size: 12px;
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
      font-size: 11px;
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
      font-size: 12px;
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
      font-size: 12px;
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
    .stat-card span { color: var(--muted); font-size: 12px; }
    .section-kicker { color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .toolbar input { width: min(300px, 100%); }
    .filter-grid { display: grid; grid-template-columns: minmax(220px, 1fr) repeat(4, minmax(130px, .55fr)); gap: 10px; }
    .pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 4px; }
    .pagination .row { flex-wrap: nowrap; }
    .pagination select { width: auto; }
    .switch-label { display: inline-flex; align-items: center; gap: 8px; color: var(--text); text-transform: none; font-size: 13px; cursor: pointer; }
    .inline-error { min-height: 18px; color: var(--danger); font-size: 12px; }
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
    .mobile-scrim {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 80;
      min-height: 100%;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: rgba(2, 6, 12, .72);
      cursor: default;
    }
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
    .browser-page-text { max-height: 260px; overflow: auto; color: #cbd5e1; line-height: 1.55; white-space: pre-wrap; }
    .browser-tab { cursor: pointer; }
    .browser-tab:hover { border-color: var(--accent); }
    .web-result a { color: var(--blue); font-weight: 750; }
    .web-result p { margin: 0; color: var(--muted); line-height: 1.45; }
    .approval-card { border-color: #735f25; background: #211e12; }
    .approval-card .approval-summary { color: #f3dda0; }
    .provider-setup {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 0 2px 8px;
      padding: 10px 12px;
      border: 1px solid #655722;
      border-radius: 10px;
      background: #242013;
      color: #f1dfa6;
      font-size: 13px;
    }
    .provider-setup code { color: #fff2bd; }
    .toast-region {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 120;
      width: min(420px, calc(100vw - 36px));
      min-height: 44px;
      padding: 12px 14px;
      border: 1px solid #396b5e;
      border-radius: 10px;
      background: #10231f;
      color: #e7fff7;
      box-shadow: 0 14px 38px rgba(0, 0, 0, .38);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: opacity .16s ease, transform .16s ease;
    }
    .toast-region.visible { opacity: 1; transform: translateY(0); }
    .toast-region.error { border-color: #82404c; background: #311a21; color: #ffe3e8; }

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
      font-size: 11px;
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
    .nav-labs {
      margin: 2px 0;
    }
    .nav-labs > summary {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 40px;
      padding: 7px 9px;
      border: 1px solid transparent;
      border-radius: 10px;
      color: #dfe6f0;
      cursor: pointer;
      list-style: none;
    }
    .nav-labs > summary::-webkit-details-marker { display: none; }
    .nav-labs > summary:hover,
    .nav-labs[open] > summary {
      border-color: var(--line-soft);
      background: var(--surface-2);
    }
    .nav-labs > summary .badge { margin-left: auto; }
    .nav-labs > summary .nav-chevron {
      color: var(--muted);
      transition: transform .16s ease;
    }
    .nav-labs[open] > summary .nav-chevron { transform: rotate(180deg); }
    .nav-more { margin: 4px 0 2px; }
    .nav-more summary { display: flex; align-items: center; justify-content: space-between; padding: 10px 11px 5px; color: #66758b; cursor: pointer; list-style: none; text-transform: uppercase; }
    .nav-more summary::-webkit-details-marker { display: none; }
    .nav-more summary .nav-group-label { padding: 0; }
    .nav-chevron { color: #8b98aa; font-size: 15px; transition: transform .15s ease; }
    .nav-more:not([open]) .nav-chevron { transform: rotate(-90deg); }
    .nav-more .nav-labs > summary {
      justify-content: flex-start;
      min-height: 40px;
      padding: 7px 9px;
      color: #dfe6f0;
      text-transform: none;
    }
    .nav-more .nav-labs > summary .nav-group-label { display: flex; align-items: center; gap: 10px; }
    .nav-more .nav-labs > summary .nav-chevron { display: inline; }
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
      font-size: 11px;
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
      font-size: 12px;
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
      font-size: 11px;
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
      body { overflow: hidden; }
      .shell {
        min-height: 100dvh;
        height: 100dvh;
        grid-template-columns: 1fr;
        grid-template-rows: auto minmax(0, 1fr);
        grid-template-areas:
          "topbar"
          "content";
      }
      .sidebar {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 90;
        display: grid;
        width: min(86vw, 328px);
        max-width: 100%;
        border-right: 1px solid var(--line);
        background: #0d1117;
        box-shadow: 18px 0 44px rgba(0, 0, 0, .36);
        transform: translateX(-105%);
        transition: transform .2s ease;
      }
      .shell.nav-open .sidebar {
        transform: translateX(0);
      }
      .shell.nav-open .mobile-scrim {
        display: block;
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
      .brand, .sidebar-footer { display: flex; }
      .sidebar-footer { display: grid; }
      .nav {
        display: grid;
        overflow: auto;
        max-height: none;
        align-content: start;
      }
      .nav button { width: 100%; min-width: 0; min-height: 44px; }
      .menu-chats {
        display: grid;
        max-height: none;
        margin: 5px 0 2px;
        padding: 0 0 10px;
      }
      .menu-chats .session-list {
        max-height: 190px;
      }
      .menu-chat {
        width: 100%;
      }
      .overview-grid, .layout-grid, .split, .grid-2, .chat-shell, .capability-grid, .stat-strip, .record-grid {
        grid-template-columns: 1fr;
      }
      .stat-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .page-head,
      .experimental-warning,
      .config-actions,
      .pagination {
        align-items: stretch;
        flex-direction: column;
      }
      .page-head > .row,
      .page-head > div > .row {
        width: 100%;
      }
      .content {
        min-height: 0;
        padding: 12px;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .view.active {
        min-height: 100%;
        height: auto;
      }
      #view-overview.active {
        height: 100%;
        min-height: 0;
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
      .composer-footer {
        display: grid;
        align-items: stretch;
        grid-template-columns: 1fr;
      }
      .composer-footer > .row {
        justify-content: space-between;
      }
      .composer-footer > .row:last-child {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .composer-footer > .row:last-child .chat-status {
        grid-column: 1 / -1;
        grid-row: 2;
      }
      .composer-tools select {
        min-width: 0;
        flex: 1 1 170px;
      }
      .composer-tools .chip {
        display: none;
      }
      .table-panel {
        max-width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }
      .data-table {
        width: max-content;
        min-width: 760px;
        overflow: visible;
      }
      .provider-setup { align-items: flex-start; flex-direction: column; }
      button, .sidebar-icon-button, .sidebar-toggle { min-height: 44px; }
      .sidebar-icon-button, .sidebar-toggle { width: 44px; }
      .toast-region { right: 10px; bottom: 10px; width: calc(100vw - 20px); }
    }
    @media (max-width: 980px) {
      .chat-thread { padding: 28px 14px 122px; }
      .chat-thread > * { width: 100%; }
      .message.user { max-width: 88%; margin-right: 0; }
      .composer { width: calc(100% - 20px); margin-bottom: 10px; }
    }
    .oc-page { max-width: 1320px; }
    .oc-page .page-head h1 { color: var(--text); }
    .config-page { max-width: 980px; }
    .config-editor { min-height: min(62vh, 720px); padding: 16px; font-size: 13px; line-height: 1.55; tab-size: 2; }
    .config-guidance { margin: 0; color: var(--muted); line-height: 1.55; }
    .config-actions { justify-content: space-between; }
    .config-actions > .row { gap: 8px; }
    .config-restart { display: grid; gap: 4px; padding: 13px 15px; border: 1px solid #7b632c; border-radius: 10px; background: #2b2414; color: #f3d891; }
    .config-restart strong { color: #ffe5a2; }
    .summary-bar { display: flex; align-items: center; gap: 34px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: #151a22; }
    .summary-bar span { display: flex; align-items: center; gap: 10px; }
    .summary-bar small { color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .08em; }
    .summary-bar strong { color: var(--text); }
    .table-panel { padding: 14px 18px; }
    .data-table { min-width: 760px; overflow-x: auto; }
    .data-row { display: grid; grid-template-columns: minmax(260px, 2fr) 110px 120px 130px minmax(120px, 1fr) 160px; align-items: center; gap: 12px; min-height: 58px; padding: 8px 10px; border-bottom: 1px solid #242b35; }
    .data-row:last-child { border-bottom: 0; }
    .data-head { min-height: 40px; color: var(--muted); background: #171c24; font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    .session-table .data-row { grid-template-columns: minmax(250px, 2fr) 150px 100px 100px 120px 80px 280px; }
    .session-project-select { max-width: 130px; }
    .data-group { min-height: 40px; background: #101720; }
    .data-primary { display: grid; gap: 4px; min-width: 0; }
    .data-primary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .data-primary small { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count-badge { display: inline-grid; place-items: center; min-width: 24px; height: 24px; border-radius: 999px; background: #222936; color: var(--muted); font-size: 12px; }
    .session-filters { display: grid; grid-template-columns: minmax(240px, 1fr) 190px 150px 150px; gap: 10px; padding: 12px 0; }
    .session-detail { margin-top: 14px; }
    .usage-grid, .agent-layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(320px, .8fr); gap: 14px; }
    .projects-page { gap: 10px; }
    .project-layout { display: grid; grid-template-columns: minmax(280px, .8fr) minmax(0, 1.2fr); gap: 10px; align-items: start; }
    .project-layout .panel { padding: 14px; }
    .project-layout .empty-state { min-height: 120px; }
    .project-card p { margin: 2px 0 5px; line-height: 1.45; }
    .activity-tabs { display: flex; gap: 6px; padding: 4px; border: 1px solid var(--line); border-radius: 10px; background: #0f141b; }
    .activity-tabs button { flex: 1; background: transparent; }
    .activity-tabs button.active { border-color: #2b6a5b; background: #173029; color: var(--accent); }
    .activity-panel { display: none; }
    .activity-panel.active { display: grid; gap: 14px; }
    .compact-head { margin: 0; padding-top: 4px; }
    .task-management { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0 2px; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
    .task-management .row { gap: 6px; }
    .task-select-label { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: center; min-width: 0; }
    .task-select-label input { width: auto; min-height: auto; }
    .task-select-copy { display: grid; gap: 4px; min-width: 0; }
    .goal-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; }
    .goal-card { align-content: start; min-height: 180px; padding: 14px; }
    .goal-card p { margin: 3px 0 6px; color: var(--muted); line-height: 1.5; }
    .goal-card .goal-actions { margin-top: auto; padding-top: 8px; }
    .goal-filter-bar { display: grid; grid-template-columns: minmax(220px, 1fr) 180px 200px; gap: 10px; }
    .memory-page { gap: 12px; }
    .memory-status-bar {
      display: grid;
      grid-template-columns: auto minmax(240px, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 13px 15px;
    }
    .memory-status-icon {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border: 1px solid #2f6658;
      border-radius: 50%;
      color: #9ce3ca;
      background: #153029;
      font-size: 18px;
      font-weight: 900;
    }
    .memory-status-copy { display: grid; gap: 4px; min-width: 0; }
    .memory-status-copy .row { gap: 8px; }
    .memory-status-copy p { margin: 0; color: var(--muted); line-height: 1.45; }
    .memory-status-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .memory-status-summary span {
      padding-left: 10px;
      border-left: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .memory-status-summary strong { color: var(--text); }
    .memory-tabs { display: flex; gap: 6px; padding: 4px; border: 1px solid var(--line); border-radius: 11px; background: #0f141b; }
    .memory-tabs button { display: flex; flex: 0 1 220px; align-items: center; justify-content: center; gap: 8px; background: transparent; }
    .memory-tabs button.active { border-color: #2b6a5b; background: #173029; color: var(--accent); }
    .memory-tabs .count-badge { background: rgba(255, 255, 255, .08); color: currentColor; }
    .memory-tab-panel { display: grid; gap: 12px; }
    .memory-tab-panel[hidden] { display: none; }
    .memory-candidate-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
    .memory-suggestion-card {
      display: grid;
      align-content: start;
      gap: 11px;
      min-width: 0;
      padding: 15px;
      border: 1px solid var(--line);
      border-radius: 11px;
      background: linear-gradient(145deg, #171d26, #11171f);
    }
    .memory-suggestion-card h3 { margin: 0; font-size: 15px; line-height: 1.35; }
    .memory-suggestion-card p { margin: 0; color: #dbe4ee; line-height: 1.5; }
    .memory-suggestion-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .memory-destination { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0; text-transform: none; }
    .memory-destination select { width: 100%; }
    .memory-suggestion-actions { display: flex; gap: 8px; padding-top: 2px; }
    .memory-suggestion-actions button { flex: 1; }
    .memory-management-layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr); gap: 10px; align-items: start; }
    .memory-card { width: 100%; overflow: hidden; color: var(--text); text-align: left; white-space: normal; }
    .memory-card .item-line strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .memory-card .item-line .chip { flex: 0 0 auto; }
    .memory-card p { margin: 6px 0; color: #dbe4ee; line-height: 1.45; overflow-wrap: anywhere; white-space: normal; }
    .memory-empty { min-height: 190px; }
    .memory-empty .row { justify-content: center; margin-top: 6px; }
    .memory-organization summary { display: flex; justify-content: space-between; gap: 12px; cursor: pointer; }
    .bar-chart { display: flex; align-items: end; gap: 8px; min-height: 220px; padding-top: 20px; }
    .bar-column { display: grid; flex: 1; grid-template-rows: 1fr auto; align-items: end; gap: 8px; height: 190px; text-align: center; color: var(--muted); font-size: 11px; }
    .bar-column i { display: block; width: 100%; min-height: 3px; border-radius: 5px 5px 2px 2px; background: linear-gradient(180deg, #58c9ac, #277d69); }
    .cron-card { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--line); border-radius: 11px; background: #12171f; }
    .cron-card .cron-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; }
    .editor-dialog { width: min(760px, calc(100vw - 40px)); max-height: calc(100dvh - 24px); overflow: auto; padding: 0; border: 1px solid var(--line); border-radius: 14px; background: #11161e; color: var(--text); }
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
    .project-card.selected, .memory-card.selected, .skill-card.selected { border-color: var(--accent); background: #14231f; }
    .scope-label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .task-timeline { max-height: 360px; overflow: auto; }
    .audit-filter-panel { display: grid; gap: 10px; }
    .experimental-warning {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      border-color: #655722;
      background: linear-gradient(135deg, rgba(101, 87, 34, .18), rgba(17, 22, 30, .92));
    }
    .experimental-warning p { margin: 5px 0 0; color: var(--muted); line-height: 1.5; }
    .beta-boundary { display: grid; gap: 12px; border-color: #3b4b5f; background: linear-gradient(145deg, rgba(34, 48, 64, .7), rgba(17, 22, 30, .96)); }
    .beta-boundary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .beta-boundary-card { display: grid; gap: 7px; min-height: 132px; padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: rgba(12, 15, 20, .48); }
    .beta-boundary-card strong { color: var(--text); font-size: 12px; line-height: 1.3; }
    .beta-boundary-card p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .beta-boundary-card.verified { border-color: #245849; }
    .beta-boundary-card.experimental { border-color: #655722; }
    .beta-boundary-card.dependent { border-color: #456071; }
    .beta-boundary-card.unsupported { border-color: #703141; }
    .beta-boundary-limits { margin: 0; padding: 10px 12px 10px 28px; border-top: 1px solid var(--line-soft); color: #c8d2df; font-size: 12px; line-height: 1.5; }
    .beta-boundary-limits li + li { margin-top: 4px; }
    .experimental-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(245px, 1fr));
      gap: 10px;
    }
    .experimental-card {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 10px;
      min-height: 178px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 11px;
      background: linear-gradient(145deg, #171d27, #10151d);
    }
    .experimental-card.enabled { border-color: #2c6656; box-shadow: inset 0 1px rgba(125, 224, 189, .08); }
    .experimental-card.disabled { opacity: .78; }
    .experimental-card p { margin: 0; color: var(--muted); line-height: 1.45; }
    .experimental-card code { color: #b8c8dd; font-size: 11px; }
    .experimental-workbench {
      display: grid;
      grid-template-columns: minmax(290px, .72fr) minmax(0, 1.28fr);
      gap: 14px;
      align-items: start;
    }
    .experimental-controls { display: grid; gap: 12px; }
    .experimental-controls textarea { min-height: 260px; }
    .experimental-result { min-height: 260px; max-height: 520px; }
    .experimental-config { max-height: none; color: #b9d7cc; }
    .experimental-run-card { cursor: pointer; }
    .experimental-run-card:hover { border-color: #456071; }
    .labs-nav { margin: 4px 0 2px; padding-left: 8px; border-left: 1px solid var(--line); }
    .labs-nav button { min-height: 34px; font-size: 12px; }
    .feature-hero {
      display: grid;
      grid-template-columns: minmax(260px, .7fr) minmax(0, 1.3fr);
      gap: 24px;
      align-items: center;
      background: linear-gradient(135deg, rgba(45, 105, 90, .2), rgba(17, 22, 30, .96));
    }
    .feature-hero h2 { max-width: 620px; margin-top: 6px; font-size: 18px; line-height: 1.4; }
    .feature-eyebrow { color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .feature-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0; padding: 0; list-style: none; }
    .feature-steps li {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      min-height: 58px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      color: #cbd5e1;
      background: rgba(12, 17, 23, .62);
      line-height: 1.35;
    }
    .feature-steps li span { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: #234b42; color: #b9f4df; font-weight: 800; }
    .experimental-page-layout { display: grid; grid-template-columns: minmax(260px, .68fr) minmax(0, 1.32fr); gap: 14px; align-items: start; }
    .feature-action-list { display: grid; gap: 8px; }
    .feature-action {
      display: grid;
      width: 100%;
      gap: 5px;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--text);
      background: #141a23;
      text-align: left;
    }
    .feature-action strong { font-size: 13px; }
    .feature-action span { color: var(--muted); font-size: 12px; line-height: 1.4; }
    .feature-action.selected { border-color: #4b9f88; background: #172a26; box-shadow: inset 3px 0 #70d6b7; }
    .feature-workspace { min-height: 360px; }
    .advanced-options { border-top: 1px solid var(--line-soft); padding-top: 12px; }
    .advanced-options summary { color: var(--muted); cursor: pointer; font-size: 12px; }
    .advanced-options p { margin: 8px 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .advanced-options textarea { min-height: 180px; }
    .friendly-result { min-height: 140px; padding-top: 4px; }
    .result-summary { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 11px; background: #10161e; }
    .result-summary.success { border-color: #2d6a58; background: #11231f; }
    .result-summary.error { border-color: #753744; background: #24151a; }
    .result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .result-fact { display: grid; gap: 4px; padding: 10px; border-radius: 8px; background: rgba(9, 13, 18, .58); }
    .result-fact small { color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    .result-fact strong { overflow-wrap: anywhere; font-size: 13px; }
    .human-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .human-list li { padding: 9px 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: rgba(9, 13, 18, .42); }
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
    .detail-card { display: grid; gap: 5px; min-width: 0; padding: 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: #0f141b; }
    .detail-card span { color: var(--muted); font-size: 11px; }
    .technical-token { font-family: inherit; overflow-wrap: anywhere; }
    .technical-details pre { max-height: 260px; overflow: auto; margin-top: 8px; }
    @media (max-width: 900px) {
      .usage-grid, .agent-layout, .project-layout, .memory-management-layout, .workshop-grid, .experimental-workbench, .experimental-page-layout, .feature-hero { grid-template-columns: 1fr; }
      .feature-steps { grid-template-columns: 1fr; }
      .beta-boundary-grid { grid-template-columns: 1fr 1fr; }
      .session-filters { grid-template-columns: 1fr; }
      .filter-grid { grid-template-columns: 1fr 1fr; }
      .summary-bar { align-items: flex-start; flex-direction: column; gap: 10px; }
      .goal-filter-bar { grid-template-columns: 1fr; }
      .memory-status-bar { grid-template-columns: auto minmax(0, 1fr); }
      .memory-status-summary { grid-column: 1 / -1; }
      .memory-status-summary span:first-child { padding-left: 0; border-left: 0; }
    }
    @media (max-width: 600px) {
      .beta-boundary-grid, .filter-grid { grid-template-columns: 1fr; }
      .memory-status-bar { align-items: start; }
      .memory-status-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 10px; }
      .memory-status-summary span { padding: 0; border: 0; white-space: normal; }
      .memory-tabs button { flex: 1; min-width: 0; padding-inline: 8px; }
      .memory-candidate-list { grid-template-columns: 1fr; }
      .memory-suggestion-actions { flex-direction: column; }
      .memory-card.selected p,
      .memory-card.selected .scope-label,
      .memory-card.selected .muted { display: none; }
      .task-table-panel {
        overflow-x: visible;
      }
      .task-table-shell,
      .session-table {
        width: 100%;
        min-width: 0;
      }
      .task-table-shell .data-head,
      .session-table .data-head {
        display: none;
      }
      .task-table-shell .task-row {
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 9px 12px;
        min-width: 0;
        padding: 14px 10px;
      }
      .task-table-shell .task-row > .data-primary {
        grid-column: 1 / -1;
      }
      .task-table-shell .task-row > :nth-child(3) {
        grid-column: 2;
        grid-row: 2;
        color: var(--muted);
        font-size: 12px;
      }
      .task-table-shell .task-row > :nth-child(4) {
        grid-column: 1;
        grid-row: 3;
      }
      .task-table-shell .task-row > :nth-child(5) {
        display: none;
      }
      .task-table-shell .task-row > :nth-child(6) {
        grid-column: 2;
        grid-row: 3;
      }
      .session-table .session-record {
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px 12px;
        min-width: 0;
        padding: 14px 10px;
      }
      .session-table .session-record > .data-primary,
      .session-table .session-record > :nth-child(7) {
        grid-column: 1 / -1;
      }
      .session-table .session-record > :nth-child(2) {
        color: var(--muted);
        font-size: 12px;
      }
      .session-table .session-record > :nth-child(5) {
        grid-column: 1;
      }
      .session-table .session-record > :nth-child(6) {
        display: none;
      }
      .session-table .session-record > :nth-child(7) {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
      }
      .session-table .session-project-select {
        width: 100%;
        max-width: none;
      }
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
    <symbol id="icon-project" viewBox="0 0 24 24"><path d="M4 7h6l2 2h8v10H4z"></path><path d="M4 7V5h6l2 2"></path></symbol>
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
    <aside class="sidebar" id="console-sidebar" aria-label="Primary navigation">
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
        <button data-view="sessions" data-title="Sessions" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-session"></use></svg></span><span class="nav-label">Sessions</span></button>
        <div class="menu-chats">
          <button class="secondary" id="new-chat" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-plus"></use></svg></span><span class="nav-label">New session</span></button>
          <div class="session-rail-label"><span>Pinned</span><span class="rail-count" id="pinned-count">0</span></div>
          <div id="pinned-chat-list" class="session-list pinned-list"></div>
          <div class="session-rail-label"><span>Recent</span><span class="rail-count" id="chat-session-count">0</span></div>
          <div id="chat-session-list" class="session-list"></div>
        </div>
        <details class="nav-more" open>
          <summary><span class="nav-group-label">More</span><span class="nav-chevron">⌄</span></summary>
          <button data-view="capabilities" data-title="Web tools" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-globe"></use></svg></span><span class="nav-label">Web tools</span></button>
          <button data-view="usage" data-title="Activity" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-usage"></use></svg></span><span class="nav-label">Activity</span></button>
          <button data-view="cron" data-title="Schedules" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-clock"></use></svg></span><span class="nav-label">Schedules</span></button>
          <button data-view="tasks" data-title="Tasks" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-tool"></use></svg></span><span class="nav-label">Tasks</span></button>
          <button data-view="agents" data-title="Agent SDK" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-agent"></use></svg></span><span class="nav-label">Agent SDK</span></button>
          <button data-view="skills" data-title="Skills SDK" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-skill"></use></svg></span><span class="nav-label">Skills SDK</span></button>
          <button data-view="automatic-improvements" data-title="Automatic improvements" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-refresh"></use></svg></span><span class="nav-label">Automatic improvements</span></button>
          <details class="nav-labs">
            <summary><span class="nav-group-label"><svg class="icon-svg"><use href="#icon-spark"></use></svg> Labs</span><span class="badge warn" id="nav-experimental-count">0/7</span><span class="nav-chevron">⌄</span></summary>
            <div class="labs-nav">
            ${experimentalConsoleNavigation()}
            </div>
          </details>
        </details>
        <div class="nav-group-label nav-advanced-label">Workspace</div>
        <button data-view="projects" data-title="Projects" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-project"></use></svg></span><span class="nav-label">Projects</span></button>
        <button data-view="memory" data-title="Memory" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-memory"></use></svg></span><span class="nav-label">Memory</span></button>
        <button data-view="goals" data-title="Goals" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-goal"></use></svg></span><span class="nav-label">Goals</span></button>
        <button data-view="config" data-title="Configuration" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-settings"></use></svg></span><span class="nav-label">Configuration</span></button>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-footer-tools">
          <button class="sidebar-icon-button" id="sidebar-settings" title="Open configuration" aria-label="Open configuration" type="button"><svg class="icon-svg"><use href="#icon-settings"></use></svg></button>
          <button class="sidebar-icon-button" id="sidebar-console" title="Open Web and browser tools" aria-label="Open Web and browser tools" type="button"><svg class="icon-svg"><use href="#icon-monitor"></use></svg></button>
          <button class="sidebar-icon-button" id="sidebar-theme" title="Toggle theme" aria-label="Toggle theme" type="button"><svg class="icon-svg"><use href="#icon-moon"></use></svg></button>
          <button class="sidebar-icon-button" id="refresh" title="Refresh" aria-label="Refresh" type="button"><svg class="icon-svg"><use href="#icon-refresh"></use></svg></button>
        </div>
        <div class="sidebar-status"><span class="status-dot"></span><span id="gateway-context">Local gateway</span><span class="sidebar-version" id="product-version">v${version}</span></div>
      </div>
    </aside>
    <button class="mobile-scrim" id="mobile-scrim" type="button" aria-label="Close navigation" tabindex="-1"></button>

    <header class="topbar">
      <button class="sidebar-toggle" id="sidebar-toggle" type="button" title="Collapse navigation" aria-label="Collapse navigation" aria-controls="console-sidebar" aria-expanded="true"><svg class="icon-svg"><use href="#icon-menu"></use></svg></button>
      <div class="topbar-title">
        <div class="breadcrumb-line">
          <strong>Ódinn Forge</strong>
          <span class="breadcrumb-sep">/</span>
          <strong id="view-title">Chat</strong>
          <span class="breadcrumb-sep" id="chat-context-sep">/</span>
          <span class="current" id="chat-title">New chat</span>
        </div>
          <span class="topbar-context" id="chat-subtitle">Your local assistant</span>
        <span class="topbar-context" id="workspace">Loading your workspace...</span>
      </div>
      <div class="row">
        <button class="secondary" id="remote-signout" type="button" hidden>Sign out</button>
      </div>
    </header>

    <main class="content">
      <section id="view-overview" class="view active">
        <div class="chat-shell">
          <div class="chat-column">
            <div id="chat-thread" class="chat-thread"></div>
            <div class="composer">
              <div class="provider-setup" id="provider-cta" role="status">
                <span>No connected model provider. Run <code>odinn onboard</code> in a terminal, then refresh this page.</span>
                <div class="row"><button class="secondary" data-view-jump="usage" type="button">View provider status</button><button class="secondary" id="copy-onboard-command" type="button">Copy command</button></div>
              </div>
              <textarea id="chat-input" aria-label="Message Ódinn Forge" placeholder="Connect a provider to start chatting" disabled></textarea>
              <div class="composer-footer">
                <div class="row composer-tools">
                  <button class="secondary" data-view-jump="tasks" title="Open tasks" type="button"><span class="icon"><svg class="icon-svg"><use href="#icon-tool"></use></svg></span></button>
                  <select id="model-select" aria-label="Model" disabled>
                    <option value="">Configure a provider first</option>
                  </select>
                  <span class="chip warn" id="model-chip">no model configured</span>
                </div>
                <div class="row">
                  <span class="muted chat-status" id="chat-status" role="status" aria-live="polite">Checking provider</span>
                  <button class="send-action" id="send-chat" title="Send message" type="button" disabled>Send</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="view-capabilities" class="view">
        <div class="page capabilities-page">
          <div class="page-head"><div><div class="section-kicker">Current information and website work</div><h1>Web tools</h1><p>Use these when Ódinn needs up-to-date public information or has to work on a website for you.</p></div><span class="chip" id="browser-approval-mode">Checking safeguards</span></div>
          <div class="stat-strip"><div class="stat-card"><strong id="cap-web-status">CHECKING</strong><span>public web</span></div><div class="stat-card"><strong id="cap-browser-status">CHECKING</strong><span>browser workspace</span></div><div class="stat-card"><strong id="cap-approval-count">—</strong><span>waiting for you</span></div><div class="stat-card"><strong id="cap-security-mode">CHECKING</strong><span>action safeguards</span></div></div>
          <div class="capability-grid">
            <div class="panel stack">
              <div class="panel-head"><div><h2>Public web search</h2><span class="chip ok">read only</span></div><button id="web-search-run" type="button">Search</button></div>
              <p>Find current facts, documentation, news, and public pages. This does not sign in or change anything.</p>
              <div class="field"><label for="web-search-query">What do you want to find?</label><input id="web-search-query" placeholder="Search current information..."></div>
              <div id="web-search-results" class="list"><div class="empty-state"><strong>Nothing searched yet</strong><span>Results will appear here with clear source links.</span></div></div>
            </div>
            <div class="panel stack">
              <div class="panel-head"><div><h2>Signed-in browser</h2><span class="chip warn">asks before changes</span></div><button class="secondary" id="browser-refresh" type="button">Refresh</button></div>
              <p>Open a separate browser workspace for sites that need an account, forms, or multi-step navigation. Ódinn pauses before actions that change an external account.</p>
              <div class="field"><label for="browser-url">Website address</label><div class="row"><input id="browser-url" placeholder="https://example.com"><button id="browser-open" type="button">Open</button></div></div>
              <div id="browser-tabs" class="list"><div class="empty-state"><strong>Browser is waiting</strong><span>Open a site to begin.</span></div></div>
              <div class="panel browser-page-panel"><div class="panel-head"><h3 id="browser-page-title">No page selected</h3><span class="chip" id="browser-page-url">—</span></div><div id="browser-page-text" class="browser-page-text">Open or select a tab to inspect visible content.</div></div>
            </div>
          </div>
          <div class="panel stack">
            <div class="panel-head"><div><h2>Actions waiting for you</h2><span class="muted" id="browser-approval-copy">Checking whether a browser action needs your confirmation.</span></div><span class="chip warn">you stay in control</span></div>
            <div id="approval-list" class="list"><div class="empty-state"><strong>Nothing is waiting</strong><span>Ódinn will pause here before changing an external account.</span></div></div>
          </div>
        </div>
      </section>

      <section id="view-tasks" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Work in one place</div><h1>Tasks</h1><p>Find, stop, inspect, or run work again. Turn on System activity only when you need routine background updates.</p></div><button class="secondary" id="refresh-tasks" type="button">Refresh</button></div>
          <div class="stat-strip"><div class="stat-card"><strong id="task-total">0</strong><span>visible tasks</span></div><div class="stat-card"><strong id="task-running">0</strong><span>active or waiting</span></div><div class="stat-card"><strong id="task-passed">0</strong><span>completed</span></div><div class="stat-card"><strong id="task-failed">0</strong><span>need attention</span></div></div>
          <div class="panel table-panel task-table-panel">
            <div class="toolbar"><input id="task-query" aria-label="Search tasks" placeholder="Search tasks by name or area"><div class="row"><select id="task-status-filter" aria-label="Task status"><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option><option value="review">Needs attention</option></select><select id="task-category-filter" aria-label="Task origin"><option value="all">Started by anyone</option><option value="user">You</option><option value="agent">Agent SDK</option><option value="automation">Automatic</option></select><label class="switch-label"><input id="task-system-toggle" type="checkbox"> System activity</label></div></div>
            <div class="task-management"><label class="switch-label"><input id="task-select-page" type="checkbox"> Select this page</label><span class="muted" id="task-selection-count">No tasks selected</span><div class="row"><button class="secondary" id="task-rerun-selected" type="button" disabled>Run selected again</button><button class="secondary" id="task-cancel-selected" type="button" disabled>Stop selected</button><button class="secondary" id="task-clear-selection" type="button" disabled>Clear</button></div></div>
            <div class="data-table task-table-shell"><div class="data-row data-head"><span>Task</span><span>Status</span><span>Started by</span><span>Updated</span><span>Updates</span><span>Actions</span></div><div id="task-table"></div></div>
            <div class="pagination"><span class="muted" id="task-page-label">Page 1 of 1</span><div class="row"><label class="switch-label">Items <select id="task-page-size"><option>10</option><option selected>25</option><option>50</option></select></label><button class="secondary" id="task-prev" type="button">Previous</button><button class="secondary" id="task-next" type="button">Next</button></div></div>
          </div>
          <div class="panel stack"><div class="panel-head"><div><h2>Task detail</h2><span class="muted" id="task-detail-label">Select a task for its timeline and outcome.</span></div><div class="row"><button class="secondary" id="task-verify" type="button" disabled>Check record integrity</button><button class="secondary" id="task-cancel" type="button" disabled>Stop</button><button class="secondary" id="task-replay" type="button" disabled>Run again</button></div></div><div id="task-summary" class="record-grid"></div><div id="task-evidence" class="timeline task-timeline"><div class="empty-state"><strong>No task selected</strong><span>Choose Inspect from the history above.</span></div></div></div>
        </div>
      </section>

      <section id="view-cron" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Scheduled work</div><h1>Schedules</h1><p>Ask Ódinn to run a recurring action while the local gateway is online.</p></div><div class="row"><button id="new-cron" type="button">New schedule</button><button class="secondary" id="refresh-cron" type="button">Refresh</button></div></div>
          <div class="summary-bar"><span><small>SCHEDULING</small><strong id="cron-enabled">On</strong></span><span><small>SCHEDULES</small><strong id="cron-count">0</strong></span><span><small>NEXT RUN</small><strong id="cron-next">—</strong></span></div>
          <div class="panel stack"><div class="panel-head"><div><h2>Recurring actions</h2><p class="muted">Times follow the timezone saved with each schedule.</p></div><span class="muted" id="cron-shown">0 shown</span></div><input id="cron-query" aria-label="Filter schedules" placeholder="Filter schedules"><div id="cron-list" class="list"></div></div>
          <dialog id="cron-dialog" class="editor-dialog"><form method="dialog" id="cron-form"><div class="panel-head"><h2>Create a schedule</h2><button class="secondary" value="cancel" type="submit">Close</button></div><div class="field"><label for="cron-name">Name</label><input id="cron-name" placeholder="Monday project check-in" required></div><div class="grid-2"><div class="field"><label for="cron-frequency">Repeat</label><select id="cron-frequency"><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Every week</option><option value="hourly">Every hour</option><option value="custom">Custom</option></select></div><div class="field" id="cron-time-field"><label for="cron-time">Time</label><input id="cron-time" type="time" value="09:00"></div></div><div class="field" id="cron-weekday-field" hidden><label for="cron-weekday">Day</label><select id="cron-weekday"><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option></select></div><details id="cron-custom-options" class="advanced-options"><summary>Custom timing</summary><div class="field"><label for="cron-schedule">Schedule pattern</label><input id="cron-schedule" value="0 9 * * *" required><span class="muted">Use this only when the common repeat options do not fit.</span></div></details><div class="grid-2"><div class="field"><label for="cron-timezone">Timezone</label><input id="cron-timezone" value="America/New_York"></div><div class="field"><label for="cron-tool">Action</label><select id="cron-tool"></select></div></div><details class="advanced-options"><summary>Advanced action input</summary><div class="field"><label for="cron-input">Structured input</label><textarea id="cron-input">{}</textarea></div></details><div class="row"><button id="save-cron" value="default" type="submit">Save schedule</button></div></form></dialog>
        </div>
      </section>

      <section id="view-projects" class="view">
        <div class="page oc-page projects-page">
          <div class="page-head"><div><div class="section-kicker">Organized workspaces</div><h1>Projects</h1><p>Group related sessions and goals in one workspace.</p></div><div class="row"><button id="new-project" type="button">New Project</button><button class="secondary" id="refresh-projects" type="button">Refresh</button></div></div>
          <div class="stat-strip"><div class="stat-card"><strong id="project-total">0</strong><span>active projects</span></div><div class="stat-card"><strong id="project-session-count">0</strong><span>sessions</span></div><div class="stat-card"><strong id="project-goal-count">0</strong><span>goals</span></div><div class="stat-card"><strong id="project-active-goal-count">0</strong><span>active goals</span></div></div>
          <div class="project-layout"><div class="panel stack"><div class="panel-head"><h2>Projects</h2><input id="project-query" aria-label="Filter projects" placeholder="Filter projects"></div><div id="project-list" class="list"></div></div><div class="panel stack"><div class="panel-head"><h2>Project detail</h2><span class="chip" id="project-detail-status">No selection</span></div><div id="project-detail" class="empty-state"><strong>Select a project</strong><span>Its sessions and scoped goals will appear here.</span></div><div class="row"><button class="secondary" id="project-open-sessions" type="button" disabled>Open Sessions</button><button class="secondary" id="project-open-goals" type="button" disabled>Open Goals</button><button class="danger-button" id="project-archive" type="button" disabled>Archive</button></div></div></div>
          <dialog id="project-dialog" class="editor-dialog"><form method="dialog" id="project-form"><div class="panel-head"><div><h2>Create project</h2><span class="muted">Sessions and goals can be moved here after creation.</span></div><button class="secondary" value="cancel" type="submit">Close</button></div><div class="field"><label for="project-name">Project name</label><input id="project-name" placeholder="Website launch" required></div><div class="field"><label for="project-description">Description</label><textarea id="project-description" placeholder="What belongs in this project?"></textarea></div><div class="row"><button value="default" type="submit">Create Project</button></div></form></dialog>
        </div>
      </section>

      <section id="view-memory" class="view">
        <div class="page oc-page memory-page">
          <div class="page-head"><div><div class="section-kicker">Context that improves with you</div><h1>Memory</h1><p>Review what Ódinn has noticed and manage the details it can use in future conversations.</p></div><div class="row"><button id="memory-new-toggle" type="button">Add memory</button><button class="secondary" id="refresh-memory-tree" type="button">Refresh</button></div></div>
          <div class="panel memory-status-bar">
            <div class="memory-status-icon" aria-hidden="true">✓</div>
            <div class="memory-status-copy"><div class="row"><strong>Automatic memory</strong><span class="chip" id="memory-health">Checking</span></div><p id="memory-status-copy">Checking what Ódinn can remember and recall.</p></div>
            <div class="memory-status-summary" aria-label="Memory summary"><span><strong id="memory-record-count">0</strong> saved</span><span><strong id="memory-candidate-count">0</strong> suggestions</span><span><strong id="memory-recall-status">Recall off</strong></span><span id="memory-last-update">No updates yet</span></div>
          </div>
          <div class="memory-tabs" role="tablist" aria-label="Memory views"><button id="memory-tab-suggestions" class="active" type="button" role="tab" tabindex="0" aria-selected="true" aria-controls="memory-suggestions-panel" data-memory-tab="suggestions">Suggestions <span class="count-badge" id="memory-tab-suggestions-count">0</span></button><button id="memory-tab-saved" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="memory-saved-panel" data-memory-tab="saved">Saved memories <span class="count-badge" id="memory-tab-saved-count">0</span></button></div>
          <div id="memory-suggestions-panel" class="memory-tab-panel" role="tabpanel" aria-labelledby="memory-tab-suggestions">
            <div class="panel stack">
              <div class="panel-head"><div><h2>Review suggestions</h2><p class="muted">Keep useful details. Dismiss anything temporary, incorrect, or too personal.</p></div><span class="chip" id="memory-candidate-badge">0 to review</span></div>
              <div id="memory-candidate-list" class="memory-candidate-list"><div class="empty-state memory-empty"><strong>You are all caught up</strong><span>New suggestions will appear here after Ódinn notices something useful in a conversation.</span></div></div>
            </div>
          </div>
          <div id="memory-saved-panel" class="memory-tab-panel" role="tabpanel" aria-labelledby="memory-tab-saved" hidden>
            <div class="memory-management-layout">
              <div class="panel stack"><div class="panel-head"><div><h2>Saved memories</h2><span class="muted" id="memory-result-count">0 saved</span></div></div><div class="filter-grid"><input id="memory-query" aria-label="Search saved memories" placeholder="Search saved memories"><select id="memory-kind-filter" aria-label="Filter saved memories by type"><option value="">All types</option><option value="preference">Preferences</option><option value="project">Project details</option><option value="person">People</option><option value="artifact">Resources</option><option value="procedure">Routines</option><option value="decision">Decisions</option><option value="system">System settings</option></select><select id="memory-scope-filter" aria-label="Filter saved memories by where they apply"><option value="">All locations</option><option value="global">Available everywhere</option><option value="project">One project</option><option value="session">One conversation</option></select></div><div id="memory-list" class="list"></div></div>
              <div class="panel stack" id="memory-detail-panel"><div class="panel-head"><h2>Selected memory</h2><span class="chip" id="memory-detail-kind">No selection</span></div><div id="memory-detail" class="empty-state"><strong>Choose a saved memory</strong><span>You will see what Ódinn remembers and where it can use it.</span></div><div class="row"><button class="secondary" id="memory-correct" type="button" disabled>Edit memory</button><button class="secondary" id="memory-recall-test" type="button">Test recall</button><button class="danger-button" id="memory-forget" type="button" disabled>Forget memory</button></div><div id="memory-recall-result" class="result-summary" role="status" aria-live="polite" hidden></div></div>
            </div>
            <details class="panel stack memory-organization"><summary><strong>Memory organization</strong><span class="muted">See how saved context is grouped</span></summary><div id="memory-tree" class="record-grid"></div></details>
          </div>
          <dialog id="memory-dialog" class="editor-dialog"><form method="dialog" id="memory-form"><div class="panel-head"><div><h2>Add a memory</h2><span class="muted">Save a lasting detail that will be useful in future conversations.</span></div><button class="secondary" id="memory-dialog-close" type="button">Close</button></div><div class="grid-2"><div class="field"><label for="memory-kind">What kind of detail is this?</label><select id="memory-kind"><option value="preference">Preference</option><option value="project">Project detail</option><option value="person">Person</option><option value="artifact">Resource</option><option value="procedure">Routine</option><option value="decision">Decision</option><option value="system">System setting</option></select></div><div class="field"><label for="memory-subject">Short title</label><input id="memory-subject" placeholder="Deployment preferences" required></div></div><div class="grid-2"><div class="field"><label for="memory-scope-type">Where can Ódinn use it?</label><select id="memory-scope-type"><option value="global">Everywhere</option><option value="project">One project</option><option value="session">One conversation</option></select></div><div class="field" id="memory-scope-target-field" hidden><label for="memory-scope-id">Choose the project or conversation</label><select id="memory-scope-id" disabled><option value="">Available everywhere</option></select></div></div><div class="field"><label for="memory-text">What should Ódinn remember?</label><textarea id="memory-text" placeholder="Write the preference, fact, or decision in plain language." required></textarea></div><details><summary>Advanced organization</summary><div class="grid-2"><div class="field"><label for="memory-namespace">Group</label><input id="memory-namespace" placeholder="preferences/development"></div><div class="field"><label for="memory-tier">Level of detail</label><select id="memory-tier"><option value="l0">Summary</option><option value="l1" selected>Key detail</option><option value="l2">Supporting detail</option></select></div></div><div class="field"><label for="memory-tags">Labels</label><input id="memory-tags" placeholder="typescript, workflow"></div></details><div class="row"><button value="default" type="submit">Save memory</button></div></form></dialog>
          <dialog id="memory-correction-dialog" class="editor-dialog"><form method="dialog" id="memory-correction-form"><div class="panel-head"><div><h2>Edit saved memory</h2><span class="muted">Ódinn keeps the previous version in its private history.</span></div><button class="secondary" id="memory-correction-dialog-close" type="button">Close</button></div><div class="field"><label for="memory-correction-text">What should Ódinn remember instead?</label><textarea id="memory-correction-text" required></textarea></div><div class="field"><label for="memory-correction-reason">Why did this change? <span class="muted">(optional)</span></label><input id="memory-correction-reason" placeholder="The earlier detail is out of date"></div><div class="row"><button value="default" type="submit">Save change</button></div></form></dialog>
        </div>
      </section>

      <section id="view-sessions" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Conversation archive</div><h1>Sessions</h1><p>Browse conversations, move them between projects, and see which model was used.</p></div><div class="row"><button id="create-session" type="button">New Session</button><button class="secondary" id="refresh-sessions" type="button">Refresh</button></div></div>
          <div class="panel table-panel"><div class="panel-head"><div><h2>Sessions <span class="count-badge" id="session-count-badge">0</span></h2><span class="muted" id="session-page-count">Loading</span></div></div><div class="session-filters"><input id="session-query" aria-label="Filter sessions" placeholder="Filter by title or source"><select id="session-project-filter" aria-label="Filter sessions by project"><option value="all">All projects</option></select><select id="session-status-filter" aria-label="Filter sessions by status"><option value="all">All statuses</option><option value="open">Open</option><option value="closed">Closed</option></select><select id="session-group" aria-label="Group sessions"><option value="none">No grouping</option><option value="project">Group by project</option><option value="source">Group by source</option><option value="status">Group by status</option></select></div><div class="data-table session-table"><div class="data-row data-head"><span>Session</span><span>Project</span><span>Source</span><span>Status</span><span>Updated</span><span>Messages</span><span>Actions</span></div><div id="session-list"></div></div></div>
          <div class="panel stack session-detail"><div class="panel-head"><h2>Selected transcript</h2><span class="chip" id="selected-session-route">No session selected</span></div><div id="session-transcript" class="timeline"><div class="empty-state"><strong>Select a session</strong><span>Its messages and model route will appear here.</span></div></div></div>
        </div>
      </section>

      <section id="view-goals" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Outcomes you care about</div><h1>Goals</h1><p>Keep important outcomes visible, update progress quickly, and pause work without losing context.</p></div><div class="row"><button id="new-goal" type="button">New goal</button><button class="secondary" id="refresh-goals" type="button">Refresh</button></div></div>
          <div class="stat-strip"><div class="stat-card"><strong id="goal-active-count">0</strong><span>active</span></div><div class="stat-card"><strong id="goal-paused-count">0</strong><span>paused</span></div><div class="stat-card"><strong id="goal-blocked-count">0</strong><span>blocked</span></div><div class="stat-card"><strong id="goal-completed-count">0</strong><span>completed</span></div></div>
          <div class="panel goal-filter-bar"><input id="goal-query" aria-label="Search goals" placeholder="Search goals"><select id="goal-status-filter" aria-label="Filter goals by status"><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="blocked">Blocked</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select><select id="goal-project-filter" aria-label="Filter goals by project"><option value="all">All projects</option></select></div>
          <div id="goal-list" class="goal-board"></div>
          <dialog id="goal-dialog" class="editor-dialog">
            <form method="dialog" id="goal-form">
              <div class="panel-head"><div><h2 id="goal-editor-title">Create goal</h2><span class="muted">Write a clear outcome and where it belongs.</span></div><button class="secondary" id="goal-cancel-edit" value="cancel" type="submit">Close</button></div>
              <div class="field"><label for="goal-title">Objective</label><input id="goal-title" placeholder="Finish the onboarding flow" required></div>
              <div class="grid-2"><div class="field"><label for="goal-scope-type">Belongs to</label><select id="goal-scope-type"><option value="project">Project</option><option value="session">Session</option></select></div><div class="field"><label for="goal-scope-id">Target</label><select id="goal-scope-id"></select></div></div>
              <div class="field"><label for="goal-description">Success looks like</label><textarea id="goal-description" placeholder="Define the concrete outcome."></textarea></div>
              <div id="goal-status-field" class="grid-2" hidden><div class="field"><label for="goal-status">Status</label><select id="goal-status"><option>active</option><option>completed</option><option>blocked</option><option>paused</option><option>cancelled</option></select></div><div class="field" id="goal-note-field"><label for="goal-note">Progress update</label><input id="goal-note" placeholder="What changed?"></div></div>
              <div class="row"><button id="create-goal" value="default" type="submit">Create goal</button><button class="secondary" id="update-goal" value="default" type="submit" hidden>Save changes</button></div>
            </form>
          </dialog>
        </div>
      </section>

      <section id="view-config" class="view">
        <div class="page oc-page config-page">
          <div class="page-head">
            <div>
              <div class="section-kicker">Advanced workspace setup</div>
              <h1>Configuration</h1>
              <p>Edit the JSON that Ódinn reads from <code>.odinn/config.json</code>. Changes are written safely and remain local to this workspace.</p>
            </div>
            <span class="chip" id="config-state">Not loaded</span>
          </div>
          <div class="panel stack">
            <div class="panel-head"><div><h2>Configuration JSON</h2><span class="muted">Unknown settings are preserved.</span></div><span class="chip warn">Advanced</span></div>
            <p class="config-guidance">Use valid JSON with an object at the top level. Credentials and OAuth tokens should stay outside this file; use environment variables or Ódinn's connection setup for secrets.</p>
            <div class="field">
              <label for="config-editor">config.json</label>
              <textarea id="config-editor" class="config-editor" aria-describedby="config-guidance config-error" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
              <span id="config-guidance" class="muted">Saving preserves a private owner-only file. Runtime settings take effect after the gateway restarts.</span>
              <div id="config-error" class="inline-error" role="alert" aria-live="assertive"></div>
            </div>
            <div class="row config-actions">
              <div class="row"><button class="secondary" id="format-config" type="button">Format JSON</button><button class="secondary" id="reload-config" type="button">Reload from disk</button></div>
              <button id="save-config" type="button">Save configuration</button>
            </div>
          </div>
          <div id="config-restart" class="config-restart" role="status" hidden>
            <strong id="config-restart-title">Restart required</strong>
            <span id="config-restart-copy">Restart the Ódinn gateway when you are ready to apply these settings.</span>
          </div>
        </div>
      </section>

      <section id="view-automatic-improvements" class="view">
        <div class="page oc-page">
          <div class="page-head"><div><div class="section-kicker">Automatic care</div><h1>Automatic improvements</h1><p>Ódinn watches for recurring reliability problems, asks the connected model for a plain-language assessment, and applies only a small set of reversible reliability adjustments.</p></div><div class="row"><span class="chip warn" id="improvement-mode-chip">Starting</span><button class="secondary" id="refresh-improvements" type="button">Refresh</button><button id="learn-improvements" type="button">Check now</button></div></div>
          <div class="summary-bar"><span><small>AUTOMATION</small><strong id="improvement-controller-state">ON</strong></span><span><small>MODEL</small><strong id="improvement-mode">CONNECTING</strong></span><span><small>OBSERVATIONS</small><strong id="improvement-count">0</strong></span><span><small>APPLIED</small><strong id="improvement-review-count">0</strong></span></div>
          <div class="panel detail-grid" id="self-improvement-config"><div class="detail-card"><span>Learning schedule</span><strong>Checking…</strong></div><div class="detail-card"><span>Model</span><strong id="self-improvement-model">Checking…</strong></div><div class="detail-card"><span>Changes per check</span><strong id="self-improvement-limit">1 maximum</strong></div><div class="detail-card"><span>Recovery</span><strong>Keeps a restore point</strong></div></div>
          <div class="agent-layout">
            <div class="panel stack"><div class="panel-head"><div><h2>What Ódinn has noticed</h2><span class="muted">Runs quietly in the background.</span></div></div><div id="improvement-list" class="list"><div class="empty-state"><strong>Nothing needs attention</strong><span>Ódinn will keep watching in the background.</span></div></div></div>
            <div class="panel stack"><div class="panel-head"><h2>Improvement detail</h2><span class="chip" id="improvement-detail-status">No selection</span></div><div id="improvement-detail" class="empty-state"><strong>Select an observation</strong><span>The reason, result, and recovery option will appear here.</span></div><div class="row"><button class="danger" id="improvement-rollback" type="button" disabled>Undo applied change</button></div></div>
          </div>
        </div>
      </section>

      ${experimentalConsolePages()}

      <section id="view-usage" class="view">
        <div class="page oc-page activity-page">
          <div class="page-head"><div><div class="section-kicker">A clear view of what Ódinn has been doing</div><h1>Activity</h1><p>See model use, recent work, and a searchable history in one place. Token totals are recorded activity, not a provider bill.</p></div><span class="pill" id="status-pill">Unknown</span></div>
          <div class="activity-tabs" role="tablist" aria-label="Activity views"><button id="activity-tab-overview" class="active" role="tab" aria-selected="true" aria-controls="activity-overview" type="button">Overview</button><button id="activity-tab-history" role="tab" aria-selected="false" aria-controls="activity-history" type="button">History</button></div>
          <div id="activity-overview" class="activity-panel active" role="tabpanel" aria-labelledby="activity-tab-overview">
            <div class="stat-strip"><div class="stat-card"><strong id="usage-total-tokens">0</strong><span>tokens recorded</span></div><div class="stat-card"><strong id="usage-model-calls">0</strong><span>model conversations</span></div><div class="stat-card"><strong id="metric-runs">0</strong><span>pieces of work</span></div><div class="stat-card"><strong id="usage-errors">0</strong><span>need attention</span></div></div>
            <div class="usage-grid"><div class="panel stack"><div class="panel-head"><h2>Activity by day</h2><span class="muted">last 14 days</span></div><div id="usage-chart" class="bar-chart"></div></div><div class="panel stack"><div class="panel-head"><h2>Model connections</h2><span class="muted">Account details stay hidden</span></div><div id="provider-list" class="list"></div></div></div>
            <div class="panel table-panel"><div class="panel-head"><div><h2>Recent model activity</h2><span class="muted">Latest four conversations</span></div></div><div id="runs" class="list"></div></div>
          </div>
          <div id="activity-history" class="activity-panel" role="tabpanel" aria-labelledby="activity-tab-history" hidden>
            <div class="page-head compact-head"><div><h2>Searchable history</h2><p>Find completed work, automatic actions, and problems that may need attention.</p></div><div class="row"><button class="secondary" id="audit-verify" type="button">Check history integrity</button><button class="secondary" id="refresh-audit" type="button">Refresh</button><button class="secondary" id="copy-audit" type="button">Copy summary</button><button class="secondary" id="export-audit" type="button">Download records</button></div></div>
            <div class="stat-strip"><div class="stat-card"><strong id="audit-count">0</strong><span>activity updates</span></div><div class="stat-card"><strong id="audit-run-count">0</strong><span>pieces of work</span></div><div class="stat-card"><strong id="audit-model-count">0</strong><span>model conversations</span></div><div class="stat-card"><strong id="audit-error-count">0</strong><span>need attention</span></div></div>
            <div class="panel audit-filter-panel"><div class="filter-grid"><input id="audit-query" aria-label="Search activity" placeholder="Search activity"><select id="audit-type-filter" aria-label="Filter by activity type"><option value="">All activity types</option></select><select id="audit-tool-filter" aria-label="Filter by area"><option value="">All areas</option></select><select id="audit-actor-filter" aria-label="Filter by who started it"><option value="">Started by anyone</option></select><select id="audit-outcome-filter" aria-label="Filter by result"><option value="">All results</option></select></div><div class="toolbar"><div class="row"><input id="audit-from" type="date" aria-label="From date"><input id="audit-to" type="date" aria-label="To date"><button class="secondary" id="audit-reset" type="button">Reset filters</button></div><span class="chip" id="audit-integrity">Not checked</span></div></div>
            <div class="panel stack"><div class="panel-head"><h2>History</h2><span class="muted" id="audit-showing">0 updates</span></div><div id="audit-events" class="list"></div><div class="pagination"><span class="muted" id="audit-page-label">Page 1 of 1</span><div class="row"><label class="switch-label">Items <select id="audit-page-size"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></label><button class="secondary" id="audit-prev" type="button">Previous</button><button class="secondary" id="audit-next" type="button">Next</button></div></div><pre id="audit-log" class="output" hidden>No history loaded.</pre></div>
          </div>
          <div hidden><span id="metric-tools"></span><span id="metric-completed"></span><span id="metric-policy"></span><span id="runtime-chips"></span><span id="status-workspace"></span><span id="status-state"></span><span id="tool-count"></span><select id="tool"></select><div id="tool-list"></div><div id="run-history"></div><span id="plan-run-count"></span><span id="plan-last-status"></span><div id="plan-runs"></div></div><div class="panel" hidden><button id="clear-output" type="button">Clear</button><pre id="output">Ready.</pre></div>
        </div>
      </section>

      <section id="view-agents" class="view">
        <div class="page oc-page"><div class="page-head"><div><div class="section-kicker">Build reusable agents</div><h1>Agent SDK</h1><p>Create and manage specialized agents for recurring kinds of work. Making one available does not start work by itself.</p></div><div class="row"><button id="new-agent" type="button">Add agent</button><button class="secondary" id="refresh-agents" type="button">Refresh</button></div></div><div class="stat-strip"><div class="stat-card"><strong id="agent-total">0</strong><span>agent packages</span></div><div class="stat-card"><strong id="agent-enabled">0</strong><span>available</span></div><div class="stat-card"><strong id="agent-quarantined">0</strong><span>set aside</span></div><div class="stat-card"><strong>Local</strong><span>stored in this workspace</span></div></div><div class="agent-layout"><div class="panel stack"><div class="panel-head"><h2>Your agents</h2><input id="agent-query" aria-label="Filter agents" placeholder="Filter agents"></div><div id="agent-list" class="list"></div></div><div class="panel stack"><div class="panel-head"><h2>Agent details</h2><span class="chip" id="agent-detail-status">No selection</span></div><div id="agent-detail" class="empty-state"><strong>Select an agent</strong><span>Its purpose, access, and setup will appear here.</span></div><div class="row"><button id="agent-enable" type="button" disabled>Make available</button><button class="secondary" id="agent-disable" type="button" disabled>Turn off</button><button class="danger-button" id="agent-quarantine" type="button" disabled>Set aside</button></div></div></div>
          <dialog id="agent-dialog" class="editor-dialog">
            <form method="dialog" id="agent-form">
              <div class="panel-head"><div><h2>Add an Agent SDK package</h2><span class="muted">It will stay off until you choose to make it available.</span></div><button class="secondary" value="cancel" type="submit">Close</button></div>
              <div id="manifest-fields" class="manifest-fields">
                <div class="field"><label for="agent-name">Agent name</label><input id="agent-name" value="Example Agent" required></div>
                <div class="field"><label for="agent-identity">Short name</label><input id="agent-identity" value="Example"></div>
                <details class="advanced-options">
                  <summary>Advanced setup</summary>
                  <div class="grid-2"><div class="field"><label for="agent-id">Internal name</label><input id="agent-id" pattern="[a-z0-9][a-z0-9._\\-]{1,63}" value="example-agent" required></div><div class="field"><label for="agent-version">Version</label><input id="agent-version" value="1.0.0" required></div></div>
                  <div class="field"><label for="agent-instructions">Instruction files <span class="muted">separate with commas</span></label><input id="agent-instructions" value="AGENTS.md"></div>
                  <div class="field"><label for="agent-tools">Things it may use <span class="muted">separate with commas</span></label><input id="agent-tools" value="workspace.readText"></div>
                  <div class="grid-2"><div class="field"><label for="agent-plugins">Add-ons</label><input id="agent-plugins"></div><div class="field"><label for="agent-secrets">Saved accounts it may request</label><input id="agent-secrets"></div></div>
                  <div class="grid-2"><div class="field"><label for="agent-sandbox">Workspace access</label><select id="agent-sandbox"><option value="workspace-write">Read and edit</option><option value="workspace-read">Read only</option><option value="container">Separate container</option></select></div><div class="field"><label for="agent-network">Websites it may contact</label><input id="agent-network" placeholder="api.example.com"></div></div>
                </details>
              </div>
              <div class="manifest-advanced"><label class="switch-label"><input type="checkbox" id="agent-advanced-toggle"> Developer setup</label><div id="agent-manifest-error" class="inline-error" role="alert"></div><textarea id="agent-manifest" class="manifest-editor" hidden></textarea></div>
              <div class="row"><button id="validate-agent" value="default" type="submit">Save agent</button></div>
            </form>
          </dialog>
        </div>
      </section>

      <section id="view-skills" class="view">
        <div class="page oc-page"><div class="page-head"><div><div class="section-kicker">Build reusable workflows</div><h1>Skills SDK</h1><p>Build, review, and manage reusable instructions that teach Ódinn how to handle repeatable work.</p></div><div class="row"><button id="new-skill" type="button">Create skill</button><button class="secondary" id="refresh-skills" type="button">Refresh</button></div></div><div class="stat-strip"><div class="stat-card"><strong id="skill-total">0</strong><span>skill packages</span></div><div class="stat-card"><strong id="skill-enabled">0</strong><span>available</span></div><div class="stat-card"><strong id="skill-unmanaged">0</strong><span>found locally</span></div><div class="stat-card"><strong id="skill-quarantined">0</strong><span>set aside</span></div></div><div class="agent-layout"><div class="panel stack"><div class="toolbar"><input id="skill-query" aria-label="Filter skills" placeholder="Filter skills"><select id="skill-status-filter" aria-label="Filter skills by status"><option value="all">All statuses</option><option value="enabled">Available</option><option value="disabled">Off</option><option value="unmanaged">Found locally</option><option value="quarantined">Set aside</option></select></div><div id="skills-list" class="list"></div></div><div class="panel stack"><div class="panel-head"><h2>Skills SDK details</h2><span class="chip" id="skill-detail-status">No selection</span></div><div id="skill-detail" class="empty-state"><strong>Select a skill</strong><span>Its purpose and requested access will appear here.</span></div><div class="row"><button id="skill-enable" type="button" disabled>Make available</button><button class="secondary" id="skill-disable" type="button" disabled>Turn off</button><button class="secondary" id="skill-verify" type="button" disabled>Check package</button><button class="danger-button" id="skill-quarantine" type="button" disabled>Set aside</button></div></div></div>
          <dialog id="skill-dialog" class="editor-dialog">
            <form method="dialog" id="skill-form">
              <div class="panel-head"><div><h2>Create a Skills SDK package</h2><span class="muted">It will stay off until you choose to make it available.</span></div><button class="secondary" value="cancel" type="submit">Close</button></div>
              <div class="field"><label for="skill-name">Skill name</label><input id="skill-name" placeholder="Project check" required></div>
              <div class="field"><label for="skill-description">When should Ódinn use it?</label><textarea id="skill-description" placeholder="Use when a project needs a repeatable check." required></textarea></div>
              <div class="field"><label for="skill-instructions">What should Ódinn do?</label><textarea id="skill-instructions" class="workshop-editor" placeholder="## Steps&#10;&#10;1. Inspect the project..." required></textarea></div>
              <details class="advanced-options">
                <summary>Advanced setup</summary>
                <div class="grid-2"><div class="field"><label for="skill-id">Internal name</label><input id="skill-id" pattern="[a-z0-9][a-z0-9\\-]{1,63}" placeholder="created from the skill name"></div><div class="field"><label for="skill-version">Version</label><input id="skill-version" value="1.0.0" required></div></div>
                <div class="grid-2"><div class="field"><label for="skill-tools">Things it may use</label><input id="skill-tools" placeholder="workspace.readText"></div><div class="field"><label for="skill-capabilities">Extra permissions</label><input id="skill-capabilities" placeholder="workspace.read"></div></div>
                <div class="grid-2"><div class="field"><label for="skill-secrets">Saved accounts it may request</label><input id="skill-secrets"></div><div class="field"><label for="skill-network">Websites it may contact</label><input id="skill-network" placeholder="github.com"></div></div>
              </details>
              <div class="row"><button value="default" type="submit">Save skill</button></div>
            </form>
          </dialog>
        </div>
      </section>
    </main>
  </div>
  <div class="toast-region" id="toast-region" role="status" aria-live="polite" aria-atomic="true"></div>
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
      sessions: [],
      modelOverride: "",
      audit: [],
      auditPage: 1,
      auditPagination: { page: 1, pages: 1 },
      browserTabId: "",
      selectedTaskId: "",
      taskPage: 1,
      taskPagination: { page: 1, pages: 1, total: 0, from: 0, to: 0 },
      taskSelection: new Map(),
      selectedAgentId: "",
      agents: [],
      skills: [],
      selectedSkillId: "",
      projects: [],
      selectedProjectId: "",
      memories: [],
      memoryCandidates: [],
      selectedMemoryId: "",
      memoryTab: "suggestions",
      memoryTabInitialized: false,
      memoryHealth: null,
      agentManifestDraft: null,
      experimentalRuns: [],
      experimentalActions: {},
      improvements: [],
      lastCapabilityToken: "",
      hosted: false,
      hostUser: "",
      activityTab: "overview",
      configFingerprint: "",
      configRestartRequired: false,
      activeView: "overview"
    };
    const experimentalFeatures = {
      proof: {
        title: "Run Checks",
        technicalName: "Proof",
        view: "lab-run-checks",
        summary: "Confirm that a completed run produced the result you expected.",
        endpoint: "/proof",
        actions: [
          { id: "verify", label: "Run a check", method: "POST", path: "/proof", description: "Check whether a recent piece of work produced the result you expected.", sample: () => ({ schemaVersion: 1, id: "ui-proof-" + Date.now(), runId: defaultExperimentalRunId(), assertions: [{ id: "readme-exists", type: "file", path: "README.md", expect: { exists: true } }] }) },
          { id: "inspect", label: "View check results", method: "GET", path: "/proof/{target}", target: "Run ID", description: "Review the checks already recorded for a piece of work.", availableWhenDisabled: true, sample: () => ({}) }
        ]
      },
      sentinel: {
        title: "Safety Preview",
        technicalName: "Sentinel",
        view: "lab-safety-preview",
        summary: "Preview whether a planned action fits your safety rules.",
        endpoint: "/policy/evaluate",
        actions: [
          { id: "evaluate", label: "Preview a decision", method: "POST", path: "/policy/evaluate", description: "See whether a planned action would be allowed without actually running it.", sample: () => ({ runId: "ui-sentinel-" + Date.now(), toolName: "text.echo", input: { text: "safe input" }, policy: { version: 1, invariants: [{ id: "deny-example", type: "command.deny-pattern", values: ["never-match"], enforcement: "block" }] } }) }
        ]
      },
      capabilities: {
        title: "Temporary Access",
        technicalName: "Capability Tokens",
        view: "lab-temporary-access",
        summary: "Grant narrow, short-lived permission for one action.",
        endpoint: "/capabilities",
        actions: [
          { id: "issue", label: "Create an access pass", method: "POST", path: "/capabilities/issue", description: "Create short-lived permission for one specific action.", sample: () => ({ runId: "ui-capability-" + Date.now(), stepId: "operator-step", toolName: "text.echo", scopes: ["text:echo"], expiresInMs: 60000, maxUses: 1 }) },
          { id: "consume", label: "Use an access pass", method: "POST", path: "/capabilities/use", description: "Use a pass once for the action it was created for.", sample: () => ({ token: "paste-issued-token", runId: "replace-with-token-run-id", toolName: "text.echo", resource: {} }) },
          { id: "list", label: "View active passes", method: "GET", path: "/capabilities/{target}", target: "Run ID", description: "See the access passes associated with a piece of work.", availableWhenDisabled: true, sample: () => ({}) },
          { id: "revoke", label: "Cancel an access pass", method: "POST", path: "/capabilities/{target}/revoke", target: "Capability ID", description: "Make an access pass unusable immediately.", dangerous: true, availableWhenDisabled: true, sample: () => ({}) }
        ]
      },
      rewind: {
        title: "Restore Points",
        technicalName: "Rewind",
        view: "lab-restore-points",
        summary: "Save selected files and preview a restore before changing anything.",
        endpoint: "/checkpoints · /rewind",
        actions: [
          { id: "checkpoint", label: "Create a restore point", method: "POST", path: "/checkpoints", description: "Save the selected workspace files so you can return to them later.", sample: () => ({ runId: "ui-rewind-" + Date.now(), stepId: "operator-checkpoint", paths: ["README.md"], label: "operator checkpoint" }) },
          { id: "preview", label: "Preview a restore", method: "POST", path: "/rewind/{target}", target: "Snapshot ID", description: "See which files would change without changing them.", sample: () => ({ apply: false }) },
          { id: "apply", label: "Restore files", method: "POST", path: "/rewind/{target}", target: "Snapshot ID", description: "Return the saved files to their earlier state.", dangerous: true, sample: () => ({ apply: true }) }
        ]
      },
      capsules: {
        title: "Portable Runs",
        technicalName: "Capsules",
        view: "lab-portable-runs",
        summary: "Package a completed run so it can be checked or replayed later.",
        endpoint: "/capsules",
        actions: [
          { id: "export", label: "Create a portable copy", method: "POST", path: "/capsules/export", description: "Package a completed piece of work for later use.", sample: () => ({ runId: defaultExperimentalRunId() }) },
          { id: "verify", label: "Check a portable copy", method: "POST", path: "/capsules/verify", description: "Confirm that a saved copy is complete and unchanged.", sample: () => ({ path: "paste-exported-capsule-path" }) },
          { id: "replay", label: "Replay safely", method: "POST", path: "/capsules/replay", description: "Replay the saved steps without running external actions.", sample: () => ({ path: "paste-exported-capsule-path", mode: "tool-mocked" }) }
        ]
      },
      counterfactual: {
        title: "Compare Approaches",
        technicalName: "Counterfactuals",
        view: "lab-scenario-compare",
        summary: "Try multiple approaches in separate workspace copies and compare the outcomes.",
        endpoint: "/counterfactual",
        actions: [
          { id: "create", label: "Create alternatives", method: "POST", path: "/counterfactual", description: "Make separate workspace copies for two different approaches.", sample: () => ({ sourceRunId: defaultExperimentalRunId(), sourceStepId: "operator-branch", plans: [{ id: "read", title: "Inspect README", summary: "Read the project README", tasks: [{ tool: "workspace.readText", input: { path: "README.md", maxBytes: 2048 }, readOnly: true }] }, { id: "echo", title: "Echo probe", summary: "Run a bounded echo probe", tasks: [{ tool: "text.echo", input: { text: "counterfactual probe" }, readOnly: true }] }] }) },
          { id: "inspect", label: "Compare results", method: "GET", path: "/counterfactual/{target}", target: "Group ID", description: "See the approaches and outcomes side by side.", sample: () => ({}) },
          { id: "execute", label: "Try every approach", method: "POST", path: "/counterfactual/{target}/execute", target: "Group ID", description: "Run each approach in its own workspace copy.", dangerous: true, sample: () => ({}) },
          { id: "select", label: "Preview your choice", method: "POST", path: "/counterfactual/{target}/select", target: "Group ID", description: "See what choosing one result would change.", sample: () => ({ runId: "paste-candidate-run-id", apply: false }) },
          { id: "apply", label: "Keep this result", method: "POST", path: "/counterfactual/{target}/select", target: "Group ID", description: "Replace the original workspace with the result you chose.", dangerous: true, sample: () => ({ runId: "paste-candidate-run-id", apply: true }) }
        ]
      },
      darwin: {
        title: "Smart Routing",
        technicalName: "Darwin Router",
        view: "lab-model-routing",
        summary: "Learn which configured model works best for different kinds of work.",
        endpoint: "/routing",
        actions: [
          { id: "observe", label: "Record an outcome", method: "POST", path: "/routing/observe", description: "Tell Ódinn how a model performed on one kind of work.", sample: () => ({ runId: defaultExperimentalRunId(), providerId: "operator", modelId: "candidate", taskClass: "general", verified: true, durationMs: 1000, toolCalls: 1, toolErrors: 0 }) },
          { id: "stats", label: "See what was learned", method: "GET", path: "/routing/stats?taskClass={target}", target: "Task class", defaultTarget: "general", description: "Compare model results for this kind of work.", sample: () => ({}) },
          { id: "choose", label: "Recommend a model", method: "POST", path: "/routing/choose", description: "Ask Ódinn which configured model has performed best here.", sample: () => ({ taskClass: "general" }) }
        ]
      }
    };
    async function api(path, options) {
      const response = await fetch(path, options);
      if (response.headers.get("x-odinn-hosted") === "true") {
        state.hosted = true;
        state.hostUser = response.headers.get("x-odinn-host-user") || "";
        $("remote-signout").hidden = false;
        $("gateway-context").textContent = state.hostUser ? "Remote tenant · " + state.hostUser : "Remote tenant gateway";
      }
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

    let toastTimer;
    function showToast(message, tone = "status") {
      const toast = $("toast-region");
      const text = String(message || "").trim();
      if (!toast || !text) return;
      toast.textContent = text.length > 260 ? text.slice(0, 257) + "..." : text;
      toast.className = "toast-region visible" + (tone === "error" ? " error" : "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.className = "toast-region"; }, tone === "error" ? 7000 : 4200);
    }

    function showOutput(value) {
      $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const message = typeof value === "string"
        ? value
        : value?.error || value?.message || (value?.ok === false ? "Action failed." : "Action completed.");
      showToast(message, /error|fail|denied|unavailable|offline|invalid/i.test(String(message)) ? "error" : "status");
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

    function viewFromHash() {
      const params = new URLSearchParams(location.hash.replace(/^#/, ""));
      const candidate = params.get("view") || "overview";
      if (candidate === "audit" || candidate === "experiments") return candidate;
      return document.getElementById("view-" + candidate) ? candidate : "overview";
    }

    function closeMobileNavigation() {
      $("shell").classList.remove("nav-open");
      const mobile = matchMedia("(max-width: 980px)").matches;
      const collapsed = $("shell").classList.contains("sidebar-collapsed");
      const label = mobile ? "Open navigation" : collapsed ? "Expand navigation" : "Collapse navigation";
      $("sidebar-toggle").title = label;
      $("sidebar-toggle").setAttribute("aria-label", label);
      $("sidebar-toggle").setAttribute("aria-expanded", String(!mobile && !collapsed));
    }

    function switchView(name, options = {}) {
      if (name === "audit") {
        name = "usage";
        options = { ...options, activityTab: "history" };
      }
      if (name === "experiments") name = "lab-run-checks";
      if (!document.getElementById("view-" + name)) name = "overview";
      state.activeView = name;
      document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === "view-" + name));
      document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
      if (name.startsWith("lab-")) document.querySelector(".nav-labs").open = true;
      const button = document.querySelector('[data-view="' + name + '"]');
      const title = button?.dataset.title || button?.textContent?.trim() || "Chat";
      $("view-title").textContent = title;
      document.title = title + " · Ódinn Forge";
      $("chat-context-sep").style.display = name === "overview" ? "" : "none";
      $("chat-title").style.display = name === "overview" ? "" : "none";
      if (options.updateHash !== false) {
        const nextHash = "#view=" + encodeURIComponent(name);
        if (location.hash !== nextHash) {
          if (options.replace === true) history.replaceState(null, "", nextHash);
          else history.pushState(null, "", nextHash);
        }
      }
      if (matchMedia("(max-width: 980px)").matches) closeMobileNavigation();
      if (name === "capabilities") {
        refreshApprovals().catch((error) => showOutput(error.message));
        refreshBrowser().catch((error) => showOutput(error.message));
      }
      if (name === "sessions") {
        if (state.status?.allowedCapabilities?.includes("session.read")) refreshSessions().catch((error) => showOutput(error.message));
        else $("session-list").innerHTML = '<div class="empty-state"><strong>Sessions are disabled by policy</strong><span>Add session.read/session.write to this gateway policy to manage conversations.</span></div>';
      }
      if (name === "tasks") refreshTasks().catch((error) => showOutput(error.message));
      if (name === "usage") {
        setActivityTab(options.activityTab || "overview");
        refreshUsage().catch((error) => showOutput(error.message));
      }
      if (name === "cron") refreshCron().catch((error) => showOutput(error.message));
      if (name === "agents") refreshAgents().catch((error) => showOutput(error.message));
      if (name === "skills") refreshSkills().catch((error) => showOutput(error.message));
      if (name === "automatic-improvements" || name.startsWith("lab-")) refreshExperiments().catch((error) => showOutput(error.message));
      if (name === "projects") refreshProjects().catch((error) => showOutput(error.message));
      if (name === "memory") refreshMemory().catch((error) => showOutput(error.message));
      if (name === "goals") refreshGoals().catch((error) => showOutput(error.message));
      if (name === "config") refreshConfig().catch((error) => {
        $("config-error").textContent = error.message;
        showOutput(error.message);
      });
    }

    function setActivityTab(tab) {
      const next = tab === "history" ? "history" : "overview";
      state.activityTab = next;
      const history = next === "history";
      $("activity-tab-overview").classList.toggle("active", !history);
      $("activity-tab-overview").setAttribute("aria-selected", String(!history));
      $("activity-tab-history").classList.toggle("active", history);
      $("activity-tab-history").setAttribute("aria-selected", String(history));
      $("activity-overview").classList.toggle("active", !history);
      $("activity-overview").hidden = history;
      $("activity-history").classList.toggle("active", history);
      $("activity-history").hidden = !history;
      if (history) refreshAudit().catch((error) => showOutput(error.message));
    }

    function defaultExperimentalRunId() {
      return state.experimentalRuns[0]?.id || "";
    }

    function experimentalPage(featureKey) {
      return document.querySelector('[data-experimental-page="' + featureKey + '"]');
    }

    function selectedExperimentalAction(featureKey) {
      const feature = experimentalFeatures[featureKey];
      const selected = state.experimentalActions?.[featureKey];
      return feature?.actions.find((action) => action.id === selected) || feature?.actions[0];
    }

    function experimentalPath(action, target = "", requireTarget = false) {
      const effectiveTarget = target || (action.target === "Run ID" ? defaultExperimentalRunId() : "");
      if (action.target && requireTarget && !effectiveTarget) throw new Error("Choose the item you want to use first.");
      return action.path.replace("{target}", encodeURIComponent(effectiveTarget || "target"));
    }

    function renderSelfImprovementStatus(status) {
      const settings = status?.selfImprovement || { enabled: true, mode: "auto", intervalMs: 300000, maxChangesPerCycle: 1, rollbackOnFailure: true };
      const automatic = settings.enabled === true && settings.mode === "auto";
      $("improvement-controller-state").textContent = automatic ? "Running" : "Paused";
      const model = settings.advisor?.model || "";
      $("improvement-mode").textContent = model ? modelDisplayName(model) : "Waiting for model";
      $("improvement-mode-chip").textContent = automatic ? "Working automatically" : "Paused";
      $("improvement-mode-chip").className = "chip " + (automatic ? "ok" : "warn");
      $("self-improvement-model").textContent = model ? modelDisplayName(model) + " · configured provider" : "Connect a provider";
      $("self-improvement-limit").textContent = String(settings.maxChangesPerCycle || 1) + " maximum per check";
      $("self-improvement-config").querySelector(".detail-card strong").textContent = describeInterval(settings.intervalMs);
      const canWrite = status?.allowedCapabilities?.includes("improve.write") === true;
      $("learn-improvements").disabled = !canWrite || !automatic;
    }

    function selectedImprovement() {
      return state.improvements.find((item) => item.id === state.selectedImprovementId);
    }

    function renderImprovementDetail() {
      const improvement = selectedImprovement();
      if (!improvement) {
        $("improvement-detail-status").textContent = "No selection";
        $("improvement-detail-status").className = "chip";
        $("improvement-detail").className = "empty-state";
        $("improvement-detail").innerHTML = '<strong>Select an observation</strong><span>The reason, result, and recovery option will appear here.</span>';
        $("improvement-rollback").disabled = true;
        return;
      }
      const status = improvement.status || "proposed";
      const tone = ["approved", "applied"].includes(status) ? "ok" : ["rejected", "failed"].includes(status) ? "danger" : "warn";
      $("improvement-detail-status").textContent = friendlyImprovementStatus(status);
      $("improvement-detail-status").className = "chip " + tone;
      $("improvement-detail").className = "agent-inspector";
      $("improvement-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(friendlyImprovementTitle(improvement)) + '</strong><p>' + escapeHtml(improvement.rationale) + '</p></div>' +
        '<div class="detail-grid">' +
          '<div class="detail-card"><span>Area</span><strong>' + escapeHtml(friendlyArea(improvement.target)) + '</strong></div>' +
          '<div class="detail-card"><span>Importance</span><strong>' + escapeHtml(friendlyStatus(improvement.priority || "normal")) + '</strong></div>' +
          '<div class="detail-card"><span>Similar occurrences</span><strong>' + escapeHtml(String((improvement.evidence || []).length)) + '</strong></div>' +
          '<div class="detail-card"><span>Last updated</span><strong>' + escapeHtml(relativeTime(improvement.updatedAt)) + '</strong></div></div>' +
        renderImprovementHistory(improvement);
      const canWrite = state.status?.allowedCapabilities?.includes("improve.write") === true;
      $("improvement-rollback").disabled = !canWrite || status !== "applied";
    }

    function renderImprovements() {
      $("improvement-count").textContent = String(state.improvements.length);
      $("improvement-review-count").textContent = String(state.improvements.filter((item) => item.status === "applied").length);
      $("improvement-list").innerHTML = state.improvements.map((improvement) => {
        const selected = improvement.id === state.selectedImprovementId;
        const tone = ["approved", "applied"].includes(improvement.status) ? "ok" : ["rejected", "failed"].includes(improvement.status) ? "danger" : "warn";
        return '<div class="item clickable ' + (selected ? "selected" : "") + '" role="button" tabindex="0" data-improvement-id="' + escapeHtml(improvement.id) + '"><div class="item-line"><strong>' + escapeHtml(friendlyImprovementTitle(improvement)) + '</strong><span class="chip ' + tone + '">' + escapeHtml(friendlyImprovementStatus(improvement.status || "proposed")) + '</span></div><div class="muted">' + escapeHtml(friendlyArea(improvement.target)) + ' · ' + escapeHtml(relativeTime(improvement.updatedAt)) + '</div><div>' + renderItemText(improvement.rationale, "Ódinn is monitoring this pattern.") + '</div></div>';
      }).join("") || '<div class="empty-state"><strong>Nothing needs attention</strong><span>Ódinn will keep watching in the background.</span></div>';
      renderImprovementDetail();
    }

    async function refreshImprovements() {
      if (state.status?.allowedCapabilities?.includes("improve.read") !== true) {
        state.improvements = [];
        $("improvement-list").innerHTML = '<div class="empty-state"><strong>Improvement history is unavailable</strong><span>This workspace does not allow improvement history to be read.</span></div>';
        renderImprovementDetail();
        return;
      }
      const result = await api("/improvements?limit=100");
      state.improvements = result.improvements || [];
      if (state.selectedImprovementId && !selectedImprovement()) state.selectedImprovementId = "";
      renderImprovements();
    }

    async function rollbackImprovement() {
      const improvement = selectedImprovement();
      if (!improvement) throw new Error("select an applied improvement first");
      if (!window.confirm("Undo the automatic change for “" + improvement.title + "” and restore the previous setting?")) return;
      const result = await api("/improvements/" + encodeURIComponent(improvement.id) + "/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      showOutput("The previous setting was restored.");
      await refreshImprovements();
    }

    async function learnImprovements() {
      const button = $("learn-improvements");
      setBusy(button, true);
      try {
        const result = await api("/improvements/learn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 1000 }) });
        const applied = result.applied?.length || 0;
        showOutput(applied ? "Ódinn found and applied " + applied + " reversible improvement." : "Automatic check complete. No change was needed.");
        await refreshImprovements();
      } finally { setBusy(button, false); }
    }

    function renderExperimentalFeaturePage(featureKey) {
      const page = experimentalPage(featureKey);
      const feature = experimentalFeatures[featureKey];
      if (!page || !feature) return;
      state.experimentalActions ||= {};
      if (!state.experimentalActions[featureKey]) state.experimentalActions[featureKey] = feature.actions[0]?.id;
      const action = selectedExperimentalAction(featureKey);
      const enabled = state.status?.experimental?.[featureKey] === true;
      const available = enabled || action.availableWhenDisabled === true;
      const status = page.querySelector('[data-role="feature-status"]');
      status.textContent = enabled ? "Available" : "Currently off";
      status.className = "chip " + (enabled ? "ok" : "warn");
      const list = page.querySelector('[data-role="action-list"]');
      list.innerHTML = feature.actions.map((item) =>
        '<button class="feature-action ' + (item.id === action.id ? "selected" : "") + '" data-feature-action="' + escapeHtml(item.id) + '" type="button"><strong>' + escapeHtml(item.label) + '</strong><span>' + escapeHtml(item.description) + '</span></button>'
      ).join("");
      page.querySelector('[data-role="action-title"]').textContent = action.label;
      page.querySelector('[data-role="action-description"]').textContent = action.description;
      const risk = page.querySelector('[data-role="action-risk"]');
      risk.textContent = action.dangerous ? "Changes local state" : action.method === "GET" ? "View only" : "Reversible or recorded";
      risk.className = "chip " + (action.dangerous ? "danger" : action.method === "GET" ? "ok" : "warn");
      const targetField = page.querySelector('[data-role="target-field"]');
      targetField.hidden = !action.target;
      page.querySelector('[data-role="target-label"]').textContent = friendlyTargetLabel(action.target);
      const target = page.querySelector('[data-role="target"]');
      if (target.dataset.action !== action.id) {
        target.dataset.action = action.id;
        target.value = action.defaultTarget || "";
      }
      const advanced = page.querySelector(".advanced-options");
      advanced.hidden = action.method === "GET";
      const payload = page.querySelector('[data-role="payload"]');
      if (payload.dataset.action !== action.id) {
        payload.dataset.action = action.id;
        payload.value = JSON.stringify(action.sample(), null, 2);
      }
      const run = page.querySelector('[data-role="run"]');
      run.disabled = !available;
      run.className = action.dangerous ? "danger" : "";
      run.textContent = available ? action.label : "Turn on this Lab to continue";
    }

    function renderExperimentalHome(status) {
      const entries = Object.entries(experimentalFeatures);
      const flags = status?.experimental || {};
      const enabledCount = entries.filter(([key]) => flags[key] === true).length;
      $("nav-experimental-count").textContent = enabledCount + "/" + entries.length;
      $("nav-experimental-count").className = "badge " + (enabledCount ? "ok" : "warn");
      renderSelfImprovementStatus(status);
      entries.forEach(([key]) => renderExperimentalFeaturePage(key));
    }

    async function refreshExperiments() {
      state.status = await api("/status");
      renderExperimentalHome(state.status);
      await refreshImprovements();
    }

    async function runExperimentalAction(featureKey) {
      const page = experimentalPage(featureKey);
      const action = selectedExperimentalAction(featureKey);
      if (!page || !action) return;
      if (state.status?.experimental?.[featureKey] !== true && action.availableWhenDisabled !== true) throw new Error("This Lab is currently off. Turn it on in Odinn settings and restart before using this action.");
      const target = page.querySelector('[data-role="target"]').value.trim();
      const path = experimentalPath(action, target, true);
      if (action.dangerous && !window.confirm('Continue with “' + action.label + '”? ' + action.description + " A preview is recommended whenever one is available.")) return;
      const options = { method: action.method };
      if (action.method !== "GET") {
        let payload;
        try { payload = JSON.parse(page.querySelector('[data-role="payload"]').value || "{}"); }
        catch { throw new Error("The advanced options are not valid. Reset them or correct the formatting."); }
        options.headers = { "content-type": "application/json" };
        options.body = JSON.stringify(payload);
      }
      const button = page.querySelector('[data-role="run"]');
      const resultArea = page.querySelector('[data-role="result"]');
      setBusy(button, true);
      resultArea.innerHTML = '<div class="empty-state"><strong>Working…</strong><span>Ódinn is completing ' + escapeHtml(action.label.toLowerCase()) + '.</span></div>';
      try {
        const result = await api(path, options);
        renderFriendlyResult(resultArea, result, featureKey, action);
        showOutput(action.label + " completed.");
      } catch (error) {
        resultArea.innerHTML = '<div class="result-summary error"><strong>That did not work</strong><p>' + escapeHtml(error.message) + '</p></div>';
        throw error;
      } finally {
        setBusy(button, false);
        renderExperimentalFeaturePage(featureKey);
      }
    }

    function friendlyStatus(value) {
      const text = String(value || "unknown");
      const labels = {
        "completed-unverified": "Completed",
        verified: "Verified",
        completed: "Completed",
        passed: "Passed",
        failed: "Needs attention",
        denied: "Stopped safely",
        running: "In progress",
        proposed: "Observed",
        applied: "Applied",
        rejected: "Dismissed",
        "rolled-back": "Undone",
        high: "High",
        normal: "Normal",
        low: "Low"
      };
      return labels[text] || text.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function friendlyImprovementStatus(value) {
      const labels = {
        proposed: "Watching",
        approved: "Ready",
        applied: "Improved automatically",
        failed: "Change not applied",
        rejected: "Dismissed",
        "rolled-back": "Undone"
      };
      return labels[value] || friendlyStatus(value);
    }

    function friendlyImprovementTitle(improvement) {
      if (/^Improve reliability for /i.test(improvement?.title || "")) {
        return "Make " + friendlyArea(improvement.target).toLowerCase() + " more reliable";
      }
      return improvement?.title || "Reliability observation";
    }

    function friendlyEventTitle(event) {
      const labels = {
        "task.policy": "Safety check",
        "task.started": "Started",
        "task.completed": "Completed",
        "task.failed": "Needs attention",
        "task.blocked": "Stopped safely",
        "task.approval_required": "Waiting for approval",
        "task.cancelled": "Cancelled",
        "provider.attempt": "Connected to model",
        "memory.curate": "Memory updated"
      };
      return labels[event?.type] || (event?.tool ? friendlyArea(event.tool) : friendlyStatus(event?.type || "Update"));
    }

    function friendlyActor(value) {
      const text = String(value || "Odinn");
      if (/autonomous|automation|cron|scheduler/i.test(text)) return "Automatic workflow";
      if (/gateway|console|user/i.test(text)) return "You";
      if (/agent/i.test(text)) return "Agent SDK";
      return friendlyStatus(text);
    }

    function friendlyErrorMessage(value) {
      const text = String(value || "");
      if (!text) return "";
      if (/429|rate.?limit/i.test(text)) return "The model service was busy. Ódinn will retry automatically.";
      if (/timed? ?out|timeout/i.test(text)) return "The operation took too long and stopped safely.";
      if (/policy|capability|approval|denied|blocked/i.test(text)) return "A safety rule stopped this action.";
      if (/provider|model/i.test(text) && /failed|error|unavailable|returned|empty|assistant content/i.test(text)) return "The connected model did not return a usable response.";
      if (/policy allowed task/i.test(text)) return "The action passed its safety checks.";
      return "This action did not complete as expected.";
    }

    function friendlyArea(value) {
      const key = String(value || "").replace(/^runtime\\//, "");
      const labels = {
        "model.chat": "Model conversations",
        "agent.run": "Agent work",
        "web.fetch": "Web reading",
        "web.search": "Web search",
        "session.create": "Conversation setup",
        "session.list": "Conversations",
        "session.read": "Conversation history",
        "session.delete": "Conversation cleanup",
        "project.list": "Projects",
        "project.create": "Projects",
        "project.update": "Projects",
        "goal.list": "Goals",
        "goal.create": "Goals",
        "goal.update": "Goals",
        "memory.search": "Memory search",
        "memory.recall": "Memory recall",
        "memory.remember": "Memory",
        "memory.forget": "Memory",
        "memory.browse": "Memory library",
        "memory.curate": "Memory organization",
        "improve.learn": "Automatic improvements",
        "improve.list": "Automatic improvements",
        "improve.rollback": "Automatic improvements",
        runtime: "General reliability"
      };
      return labels[key] || key.replace(/[._/-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "General reliability";
    }

    function friendlyTaskTitle(task) {
      const labels = {
        "improve.learn": "Automatic improvement check",
        "improve.rollback": "Undo an automatic improvement",
        "model.chat": "Model conversation",
        "agent.run": "Agent SDK work",
        "memory.search": "Search memory",
        "memory.recall": "Find useful memories",
        "memory.remember": "Save a memory",
        "memory.forget": "Forget a memory",
        "memory.curate": "Organize memory",
        "memory.browse": "Browse memory",
        "session.create": "Start a conversation",
        "session.list": "Review conversations",
        "session.read": "Open a conversation",
        "session.delete": "Delete a conversation"
      };
      return labels[task?.tool] || task?.title || friendlyArea(task?.tool);
    }

    function friendlyTaskOrigin(value) {
      const labels = { user: "You", agent: "Agent SDK", automation: "Automatic", system: "System" };
      return labels[value] || friendlyStatus(value);
    }

    function describeInterval(value) {
      const minutes = Math.max(1, Math.round(Number(value || 300000) / 60000));
      return minutes === 1 ? "Every minute" : "Every " + minutes + " minutes";
    }

    function modelDisplayName(value) {
      const text = String(value || "");
      return text.includes(":") ? text.slice(text.indexOf(":") + 1) : text || "Connected model";
    }

    function friendlyTargetLabel(value) {
      const labels = {
        "Run ID": "Run to use (leave blank for the most recent)",
        "Snapshot ID": "Restore point reference",
        "Group ID": "Comparison reference",
        "Capability ID": "Access pass reference",
        "Task class": "Kind of work"
      };
      return labels[value] || "Item to use";
    }

    function renderImprovementHistory(improvement) {
      const decisions = improvement.decisions || [];
      if (!decisions.length) return '<div class="agent-section"><strong>Current result</strong><p>Ódinn is watching this pattern. No runtime setting has been changed.</p></div>';
      return '<div class="agent-section"><strong>What happened</strong><ul class="human-list">' + decisions.map((decision) => {
        let description = decision.note || friendlyImprovementStatus(decision.decision);
        if (decision.action?.path === "runtime.modelRetries") {
          description = decision.decision === "applied"
            ? "Ódinn increased the retry buffer from " + decision.action.previousValue + " to " + decision.action.value + "."
            : description;
        }
        return '<li><strong>' + escapeHtml(friendlyImprovementStatus(decision.decision)) + '</strong><div class="muted">' + escapeHtml(description) + ' · ' + escapeHtml(relativeTime(decision.at)) + '</div></li>';
      }).join("") + '</ul></div>';
    }

    function renderFriendlyResult(target, result, featureKey, action) {
      if (featureKey === "capabilities" && typeof result?.token === "string") state.lastCapabilityToken = result.token;
      const facts = [];
      const labels = {
        status: "Status",
        decision: "Decision",
        verified: "Verified",
        provider: "Provider",
        model: "Model",
        taskClass: "Kind of work",
        maxUses: "Maximum uses",
        remainingUses: "Uses remaining",
        durationMs: "Duration",
        selected: "Selected option",
        assertions: "Checks",
        candidates: "Approaches",
        records: "Records"
      };
      for (const [key, value] of Object.entries(result || {})) {
        if (!labels[key] || value === undefined || value === null) continue;
        const display = typeof value === "boolean"
          ? value ? "Yes" : "No"
          : Array.isArray(value) ? value.length + " total"
            : key === "durationMs" ? formatDuration(value)
              : key === "model" ? modelDisplayName(value)
                : typeof value === "object" ? Object.keys(value).length + " items" : friendlyStatus(value);
        facts.push('<div class="result-fact"><small>' + escapeHtml(labels[key]) + '</small><strong>' + escapeHtml(display) + '</strong></div>');
      }
      const message = result?.message || result?.summary || action.label + " completed successfully.";
      const tokenNotice = state.lastCapabilityToken && featureKey === "capabilities" && action.id === "issue"
        ? '<div class="agent-section"><strong>Your access pass is ready</strong><p>For safety, it is not displayed on this page. Copy it now and store it only where it is needed.</p><button class="secondary" data-copy-access-pass type="button">Copy access pass</button></div>'
        : "";
      const list = Array.isArray(result?.assertions)
        ? '<ul class="human-list">' + result.assertions.map((item) => '<li><strong>' + escapeHtml(item.passed === false ? "Needs attention" : "Passed") + '</strong><div class="muted">' + escapeHtml(item.message || item.id || "Check completed") + '</div></li>').join("") + '</ul>'
        : "";
      const safeDetails = redactTechnicalResult(result);
      target.innerHTML = '<div class="result-summary success"><div><strong>' + escapeHtml(action.label + " complete") + '</strong><p>' + escapeHtml(message) + '</p></div>' +
        (facts.length ? '<div class="result-grid">' + facts.join("") + '</div>' : "") + tokenNotice + list +
        '<details class="activity-details technical-details"><summary>Developer details</summary><pre>' + escapeHtml(JSON.stringify(safeDetails, null, 2)) + '</pre></details></div>';
    }

    function redactTechnicalResult(value, key = "") {
      if (/token|secret|password|authorization|cookie/i.test(key)) return "[hidden]";
      if (Array.isArray(value)) return value.map((item) => redactTechnicalResult(item));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactTechnicalResult(item, name)]));
      return value;
    }

    function renderItemText(text, fallback) {
      const value = String(text || fallback || "");
      return escapeHtml(value.length > 180 ? value.slice(0, 177) + "..." : value);
    }

    function renderRun(run) {
      const tone = run.status === "completed" ? "ok" : run.status === "running" ? "warn" : "danger";
      return '<div class="item clickable" role="button" tabindex="0" data-run-id="' + escapeHtml(run.id) + '">' +
        '<div class="item-line"><span class="item-title">' + escapeHtml(friendlyArea(run.tool) || "Odinn activity") + '</span>' +
        '<span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(run.status)) + '</span></div>' +
        '<div class="muted">' + escapeHtml(friendlyErrorMessage(run.message) || "Completed work") + '</div>' +
      '</div>';
    }

    function renderAuditEvent(event) {
      const outcome = ["task.failed", "plan.failed"].includes(event.type) ? "failed" : (event.type === "task.blocked" || event.decision === "deny") ? "denied" : event.type === "task.completed" ? "completed" : event.type === "task.started" ? "running" : "recorded";
      const isError = ["failed", "denied"].includes(outcome);
      const isModel = ["model.chat", "agent.run"].includes(event.tool);
      const tone = isError ? "danger" : isModel ? "ok" : "";
      const title = friendlyEventTitle(event);
      const summary = event.type === "task.policy" && event.decision !== "deny"
        ? "The action passed its safety checks."
        : event.type === "task.started"
          ? "Work began."
          : event.type === "task.completed"
            ? "Work finished successfully."
            : friendlyErrorMessage(event.message) || friendlyArea(event.tool);
      const metadata = [event.actor && "Started by " + friendlyActor(event.actor), event.tool && friendlyArea(event.tool)].filter(Boolean);
      return '<div class="item activity-event ' + (isError ? "error" : "") + '"><div class="item-line"><strong>' + escapeHtml(title) + '</strong><span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(outcome)) + '</span></div><div class="muted">' + escapeHtml(relativeTime(event.at || event.timestamp)) + '</div><p class="activity-summary">' + escapeHtml(summary) + '</p><div class="activity-meta">' + metadata.map((value) => '<span>' + escapeHtml(value) + '</span>').join("") + '</div><details class="activity-details"><summary>More context</summary><div class="detail-grid"><div class="detail-card"><span>When</span><strong>' + escapeHtml(new Date(event.at || event.timestamp || Date.now()).toLocaleString()) + '</strong></div><div class="detail-card"><span>Started by</span><strong>' + escapeHtml(friendlyActor(event.actor)) + '</strong></div><div class="detail-card"><span>Area</span><strong>' + escapeHtml(friendlyArea(event.tool)) + '</strong></div><div class="detail-card"><span>Result</span><strong>' + escapeHtml(friendlyStatus(event.decision || outcome)) + '</strong></div></div></details></div>';
    }

    function renderProvider(provider) {
      const configured = provider.configured && (provider.models || []).length > 0;
      const status = configured ? "Ready" : provider.configured ? "Choose a model" : "Connect account";
      const connection = provider.name === "ollama" || provider.name === "lmstudio" ? "On this computer" : "Connected service";
      return '<div class="provider-card"><div class="provider-head"><strong>' + escapeHtml(friendlyStatus(provider.name)) + '</strong><span class="chip ' + (configured ? "ok" : "warn") + '">' + status + '</span></div><div class="chip-row"><span class="chip">' + escapeHtml(connection) + '</span><span class="chip">' + escapeHtml((provider.models || []).length + " model" + ((provider.models || []).length === 1 ? "" : "s")) + '</span></div><div class="muted">' + escapeHtml(configured ? "Available for chat and automatic improvements." : "Finish setup to use this provider.") + '</div></div>';
    }

    function providerReady(status = state.status) {
      const readyProviders = new Set((status?.providers || [])
        .filter((provider) => provider.configured && (provider.models || []).length > 0)
        .map((provider) => provider.name));
      return (status?.models || []).some((model) => readyProviders.has(model.provider));
    }

    function renderSessionTranscript(detail) {
      const messages = detail?.messages || [];
      $("selected-session-route").textContent = detail?.session?.title || "Selected session";
      $("session-transcript").innerHTML = messages.length
        ? messages.map((message) => '<div class="timeline-row"><span class="timeline-dot"></span><div class="item"><div class="item-line"><strong>' + escapeHtml(message.role === "user" ? "You" : message.role === "assistant" ? "Ódinn" : friendlyStatus(message.role || "message")) + '</strong><span class="chip">' + escapeHtml(message.model ? modelDisplayName(message.model) : "Default model") + '</span></div><div class="markdown-body">' + renderMarkdown(message.content) + '</div></div></div>').join("")
        : '<div class="empty-state"><strong>No messages yet</strong><span>Send the first message from Chat.</span></div>';
    }

    function renderChatSession(session) {
      const attrs = 'data-chat-session-id="' + escapeHtml(session.id) + '"';
      const active = session.id === state.activeChatId ? " active" : "";
      return '<div class="menu-chat' + active + '" ' + attrs + '>' +
        '<div class="menu-chat-main"><strong>' + renderItemText(session.title, "Untitled chat") + '</strong>' +
        '<span>' + escapeHtml(session.lastMessageRole === "assistant" ? "Ódinn replied" : session.lastMessageRole === "user" ? "Waiting for Ódinn" : "Ready") + ' · ' + escapeHtml((session.messageCount || 0) + ((session.messageCount || 0) === 1 ? " message" : " messages")) + '</span></div>' +
        '<div class="menu-chat-actions"><button class="chat-action" data-session-action="rename" data-session-id="' + escapeHtml(session.id) + '" title="Rename chat" aria-label="Rename chat" type="button"><svg class="icon-svg"><use href="#icon-edit"></use></svg></button><button class="chat-action delete" data-session-action="delete" data-session-id="' + escapeHtml(session.id) + '" title="Delete chat" aria-label="Delete chat" type="button"><svg class="icon-svg"><use href="#icon-trash"></use></svg></button></div>' +
      '</div>';
    }

    function renderSessionRecord(session) {
      const updated = session.updatedAt || session.createdAt || "";
      const project = state.projects.find((entry) => entry.id === session.projectId);
      const knownProjectOptions = state.projects.filter((entry) => entry.status === "active" || entry.id === session.projectId).map((entry) => '<option value="' + escapeHtml(entry.id) + '"' + (entry.id === session.projectId ? " selected" : "") + '>' + escapeHtml(entry.name + (entry.status === "archived" ? " (archived)" : "")) + '</option>').join("");
      const projectOptions = project ? knownProjectOptions : '<option value="' + escapeHtml(session.projectId) + '" selected>Unavailable project</option>' + knownProjectOptions;
      return '<div class="data-row clickable session-record" data-session-id="' + escapeHtml(session.id) + '">' +
        '<span class="data-primary"><strong>' + renderItemText(session.title, "Untitled session") + '</strong><small>' + escapeHtml(modelDisplayName(session.model || session.route || "") || "Default model") + '</small></span>' +
        '<span>' + escapeHtml(project?.name || "Workspace") + (project?.status === "archived" ? ' <span class="chip">archived</span>' : '') + '</span>' +
        '<span class="chip">' + escapeHtml(friendlySessionSource(session.source)) + '</span>' +
        '<span class="chip ' + (session.status === "archived" ? "" : "ok") + '">' + escapeHtml(friendlyStatus(session.status || "open")) + '</span>' +
        '<span class="muted">' + escapeHtml(relativeTime(updated)) + '</span>' +
        '<span>' + escapeHtml(session.messageCount || 0) + '</span>' +
        '<span class="row"><select class="session-project-select" data-session-project="' + escapeHtml(session.id) + '" aria-label="Move session to project">' + projectOptions + '</select><button class="session-action" data-session-action="rename" data-session-id="' + escapeHtml(session.id) + '" title="Rename session" aria-label="Rename session" type="button">Rename</button><button class="session-action delete" data-session-action="delete" data-session-id="' + escapeHtml(session.id) + '" title="Delete session" aria-label="Delete session" type="button">Delete</button></span>' +
      '</div>';
    }

    function friendlySessionSource(value) {
      const text = String(value || "direct");
      if (/chat|console/i.test(text)) return "Chat";
      if (/agent/i.test(text)) return "Agent";
      if (/cron|schedule|automation/i.test(text)) return "Automatic";
      return friendlyStatus(text);
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

    function sessionDisplayTitle(sessionId) {
      return state.sessions.find((session) => session.id === sessionId)?.title || "Untitled chat";
    }

    async function renameChat(sessionId) {
      const title = window.prompt("Rename chat", sessionDisplayTitle(sessionId));
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
      const title = sessionDisplayTitle(sessionId);
      if (!window.confirm('Remove session "' + title + '" from active lists? Its append-only history remains stored, but this console does not currently provide a restore action.')) return;
      await api("/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
      if (state.activeChatId === sessionId) {
        state.activeChatId = "";
        state.messages = [];
        $("chat-title").textContent = "New chat";
        $("chat-subtitle").textContent = "Your local assistant";
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
        const configured = providerReady(state.status);
        $("chat-thread").innerHTML = '<div class="chat-empty">' +
          '<div class="chat-avatar"><img src="/odinn-logo.png" alt=""></div>' +
          '<h1>Ódinn Forge</h1>' +
          '<span class="pill ' + (configured ? "" : "warn") + '">' + (configured ? "Provider connected" : "Connect a model provider") + '</span>' +
          '<p>' + (configured
            ? 'Choose a model and send a message. Use Web tools when you need current information or work on a website.'
            : 'Run odinn onboard in a terminal, then refresh this page.') + '</p>' +
          (configured
            ? '<div class="chat-prompts">' +
              '<button class="chat-prompt" data-chat-prompt="What can you do?">What can you do?</button>' +
              '<button class="chat-prompt" data-chat-prompt="Search the web for current information about Ódinn Forge.">Search the web</button>' +
              '<button class="chat-prompt" data-chat-prompt="Open the browser workspace and show me the current page.">Open browser workspace</button>' +
              '<button class="chat-prompt" data-chat-prompt="Summarize my recent activity and tasks.">Review recent activity</button>' +
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

    async function createChat(title = "New chat") {
      const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId && project.status === "active");
      const session = await api("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, source: "console-chat", tags: ["chat"], projectId: selectedProject?.id || "project_default" })
      });
      state.activeChatId = session.id;
      state.selectedSessionId = session.id;
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
      $("chat-subtitle").textContent = detail.session?.projectId && detail.session.projectId !== "project_default"
        ? "Saved with a project"
        : "Saved in this workspace";
      renderChatMessages(state.messages);
    }

    async function ensureChat() {
      if (state.activeChatId) return state.activeChatId;
      const session = await createChat("New chat");
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
      if (options.tool !== "job.healthcheck" && !providerReady(state.status)) {
        showOutput("Connect a model provider with odinn onboard, then refresh before sending a message.");
        return;
      }
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
            tool: state.status?.allowedCapabilities?.includes("agent.run") ? "agent.run" : "model.chat",
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
        ? "System check passed. Ódinn is working normally."
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
      return '<div class="item clickable" role="button" tabindex="0" ' + (attrs || "") + '>' +
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
      return '<div class="item browser-tab" role="button" tabindex="0" data-browser-tab-id="' + escapeHtml(tab.id) + '"><div class="item-line"><strong>' + escapeHtml(tab.title || "Untitled page") + '</strong><span class="chip">open</span></div><div class="muted">' + escapeHtml(tab.url || "about:blank") + '</div></div>';
    }

    function renderApproval(approval) {
      return '<div class="item approval-card"><div class="item-line"><strong>' + escapeHtml(friendlyArea(approval.tool || "browser action")) + '</strong><span class="chip warn">waiting for you</span></div><div class="approval-summary">' + escapeHtml(approval.summary || "Ódinn wants to take an action on an external account.") + '</div><div class="row"><span class="muted">This permission will be used once.</span><button data-approve-id="' + escapeHtml(approval.id) + '" type="button">Allow once</button></div></div>';
    }

    async function refreshApprovals() {
      const approvals = await api("/approvals");
      $("cap-approval-count").textContent = approvals.length;
      $("approval-list").innerHTML = approvals.map(renderApproval).join("") || '<div class="empty-state"><strong>Nothing is waiting</strong><span>Ódinn will pause before changing an external account.</span></div>';
    }

    async function refreshBrowser() {
      try {
        const result = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "browser.tabs", input: {} }) });
        const tabs = result.output?.tabs || [];
        $("browser-tabs").innerHTML = tabs.map(renderBrowserTab).join("") || '<div class="empty-state"><strong>Browser is waiting</strong><span>Open a site to begin.</span></div>';
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

    function readConfigEditor() {
      let value;
      try {
        value = JSON.parse($("config-editor").value);
      } catch (error) {
        throw new Error("Configuration JSON is invalid: " + error.message);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Configuration JSON must contain an object at the top level.");
      }
      return value;
    }

    function renderConfigState(message = "") {
      const restartRequired = state.configRestartRequired === true;
      $("config-state").textContent = restartRequired ? "Restart required" : "Loaded";
      $("config-state").className = "chip " + (restartRequired ? "warn" : "ok");
      $("config-restart").hidden = !restartRequired;
      $("config-restart-title").textContent = message || "Restart required";
      $("config-restart-copy").textContent = "Restart the Ódinn gateway when you are ready to apply these settings.";
    }

    async function refreshConfig() {
      $("config-error").textContent = "";
      const result = await api("/config");
      state.configFingerprint = result.fingerprint;
      state.configRestartRequired = result.restartRequired === true;
      $("config-editor").value = JSON.stringify(result.config, null, 2);
      renderConfigState();
    }

    function formatConfig() {
      try {
        $("config-editor").value = JSON.stringify(readConfigEditor(), null, 2);
        $("config-error").textContent = "";
        showToast("Configuration JSON formatted.");
      } catch (error) {
        $("config-error").textContent = error.message;
      }
    }

    async function saveConfig() {
      const button = $("save-config");
      $("config-error").textContent = "";
      try {
        const config = readConfigEditor();
        setBusy(button, true);
        const result = await api("/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config, fingerprint: state.configFingerprint })
        });
        state.configFingerprint = result.fingerprint;
        state.configRestartRequired = result.restartRequired === true;
        $("config-editor").value = JSON.stringify(result.config, null, 2);
        renderConfigState("Configuration saved");
        showToast(state.configRestartRequired
          ? "Configuration saved. Restart the gateway to apply it."
          : "Configuration saved. No restart is needed.");
      } catch (error) {
        $("config-error").textContent = error.message;
        showToast(error.message, "error");
      } finally {
        setBusy(button, false);
      }
    }

    async function refresh() {
      try {
        const status = await api("/status");
        state.status = status;
        renderExperimentalHome(status);
        $("nav-health").textContent = "online";
        $("status-pill").textContent = "Online";
        $("workspace").textContent = compactPath(status.workspaceRoot) + " | " + compactPath(status.state);
        $("status-workspace").textContent = status.workspaceRoot;
        $("status-state").textContent = status.state;
        $("tool-count").textContent = status.tools.length + " capabilities";
        $("product-version").textContent = "v" + (status.version || "development");
        $("provider-list").innerHTML = status.providers?.length
          ? status.providers.map(renderProvider).join("")
          : '<div class="empty-state"><strong>No providers connected</strong><span>Run <code>odinn onboard</code> in a terminal, then refresh this page.</span></div>';
        const modelSelect = $("model-select");
        const selectedModel = state.modelOverride || status.defaultModel;
        const readyProviderNames = new Set((status.providers || []).filter((provider) => provider.configured && (provider.models || []).length > 0).map((provider) => provider.name));
        const readyModels = (status.models || []).filter((model) => readyProviderNames.has(model.provider));
        modelSelect.innerHTML = readyModels.length
          ? readyModels.map((model) => '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(model.id) + '</option>').join("")
          : '<option value="">Configure a provider first</option>';
        const resolvedModel = readyModels.some((model) => model.id === selectedModel)
          ? selectedModel
          : (readyModels[0]?.id || "");
        modelSelect.value = resolvedModel;
        if (state.modelOverride && resolvedModel !== state.modelOverride) state.modelOverride = "";
        if (resolvedModel && resolvedModel !== status.defaultModel) state.modelOverride = resolvedModel;
        const ready = readyModels.length > 0;
        $("model-chip").textContent = ready ? "provider ready" : "provider required";
        $("model-chip").className = "chip " + (ready ? "ok" : "warn");
        $("model-select").disabled = !ready;
        $("chat-input").disabled = !ready;
        $("send-chat").disabled = !ready;
        $("provider-cta").hidden = ready;
        $("chat-input").placeholder = ready ? "Message Ódinn Forge..." : "Connect a provider to start chatting";
        $("chat-status").textContent = ready ? "Ready" : "Provider required";
        $("metric-tools").textContent = status.tools.length;
        $("metric-policy").textContent = status.allowedCapabilities.length;
        $("runtime-chips").innerHTML = [
          '<span class="chip ok">online</span>',
          '<span class="chip">loopback</span>',
          '<span class="chip">' + escapeHtml(status.tools.length) + ' tools</span>',
          '<span class="chip">' + escapeHtml(status.allowedCapabilities.length) + ' caps</span>'
        ].join("");
        const webReady = status.security?.web?.enabled !== false && status.tools.includes("web.search");
        const browserReady = status.security?.browser?.enabled !== false && status.tools.includes("browser.tabs");
        const approvalRequired = status.security?.browser?.requireApproval !== false;
        $("cap-web-status").textContent = webReady ? "READY" : "OFF";
        $("cap-browser-status").textContent = browserReady ? "READY" : "OFF";
        $("cap-security-mode").textContent = approvalRequired ? "REVIEW" : "DIRECT";
        $("browser-approval-mode").textContent = approvalRequired ? "Approval required" : "Approval disabled";
        $("browser-approval-mode").className = "chip " + (approvalRequired ? "ok" : "warn");
        $("browser-approval-copy").textContent = approvalRequired
          ? "Clicks, typing, and key presses pause here for explicit approval."
          : "Browser actions can proceed without console approval under the current policy.";
        $("tool").innerHTML = status.tools.map((tool) => '<option value="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</option>').join("");
        $("cron-tool").innerHTML = status.tools.map((tool) => '<option value="' + escapeHtml(tool) + '">' + escapeHtml(tool) + '</option>').join("");
        $("tool-list").innerHTML = status.toolDetails.map((tool) => renderRecord(tool, tool.name, tool.capability + " | " + tool.description)).join("");
        const background = [refreshRuns()];
        background.push((async () => {
          const canReadSessions = status.allowedCapabilities.includes("session.read");
          const canReadGoals = status.allowedCapabilities.includes("goal.read");
          if (canReadSessions && canReadGoals) await refreshProjects();
          if (canReadSessions) await refreshSessions();
          if (canReadGoals) await refreshGoals();
          if (status.allowedCapabilities.includes("memory.read")) await refreshMemory();
        })());
        await Promise.allSettled(background);
        await refreshApprovals();
      } catch (error) {
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
      $("runs").innerHTML = runs.slice(0, 4).map(renderRun).join("") || '<div class="muted">No runs yet.</div>';
      const planRuns = runs.filter((run) => run.tool === "plan" || String(run.id).startsWith("plan_"));
      $("run-history").innerHTML = runs.slice(0, 8).map(renderRun).join("") || '<div class="empty-state"><strong>No executions yet</strong><span>Run a capability to see its evidence here.</span></div>';
      $("plan-runs").innerHTML = planRuns.slice(0, 12).map(renderRun).join("") || '<div class="empty-state"><strong>No plan runs yet</strong><span>Choose a starter template and run it.</span></div>';
      $("plan-run-count").textContent = planRuns.length;
      $("plan-last-status").textContent = planRuns[0]?.status || "—";
    }

    async function refreshTasks() {
      const params = new URLSearchParams({
        includeSystem: String($("task-system-toggle")?.checked === true),
        page: String(state.taskPage || 1),
        pageSize: $("task-page-size")?.value || "25",
        status: $("task-status-filter")?.value || "all",
        category: $("task-category-filter")?.value || "all"
      });
      const query = $("task-query")?.value.trim();
      if (query) params.set("q", query);
      const data = await api("/tasks?" + params);
      state.tasks = data.tasks || [];
      state.taskPagination = data.pagination || { page: 1, pages: 1, total: state.tasks.length, from: 0, to: state.tasks.length };
      state.taskPage = state.taskPagination.page;
      for (const task of state.tasks) if (state.taskSelection.has(task.id)) state.taskSelection.set(task.id, task);
      renderTasks();
      $("task-total").textContent = data.summary.total;
      $("task-running").textContent = data.summary.running;
      $("task-passed").textContent = data.summary.completed;
      $("task-failed").textContent = data.summary.needsReview;
    }

    function renderTasks() {
      const tasks = state.tasks || [];
      $("task-table").innerHTML = tasks.map((task) => {
        const tone = task.status === "completed" ? "ok" : ["queued", "running", "cancelling", "awaiting_approval"].includes(task.status) ? "warn" : "danger";
        const record = task.evidenceCount ? task.evidenceCount + " checks" : task.eventCount + " updates";
        const checked = state.taskSelection.has(task.id) ? " checked" : "";
        const rowActions = '<button class="secondary" data-task-inspect="' + escapeHtml(task.id) + '" type="button">Inspect</button>' +
          (task.replayable ? '<button class="secondary" data-task-replay="' + escapeHtml(task.id) + '" type="button">Run again</button>' : "") +
          (task.cancellable ? '<button class="secondary" data-task-cancel="' + escapeHtml(task.id) + '" type="button">Stop</button>' : "");
        return '<div class="data-row task-row" data-task-id="' + escapeHtml(task.id) + '"><label class="task-select-label"><input data-task-select="' + escapeHtml(task.id) + '" type="checkbox"' + checked + '><span class="task-select-copy"><strong>' + escapeHtml(friendlyTaskTitle(task)) + '</strong><small>' + escapeHtml(friendlyArea(task.tool)) + '</small></span></label><span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(task.status)) + '</span><span>' + escapeHtml(friendlyTaskOrigin(task.category)) + '</span><span class="muted">' + escapeHtml(relativeTime(task.updatedAt)) + (task.durationMs !== null ? '<small> · ' + escapeHtml(formatDuration(task.durationMs)) + '</small>' : '') + '</span><span>' + escapeHtml(record) + '</span><span class="row">' + rowActions + '</span></div>';
      }).join("") || '<div class="empty-state"><strong>No matching tasks</strong><span>There is no matching activity right now.</span></div>';
      const pagination = state.taskPagination || { page: 1, pages: 1, total: 0, from: 0, to: 0 };
      $("task-page-label").textContent = pagination.total ? "Page " + pagination.page + " of " + pagination.pages + " · " + pagination.from + "–" + pagination.to + " of " + pagination.total : "Page 1 of 1 · 0 tasks";
      $("task-prev").disabled = pagination.page <= 1;
      $("task-next").disabled = pagination.page >= pagination.pages;
      updateTaskManagement();
    }

    function updateTaskManagement() {
      const tasks = state.tasks || [];
      const selected = state.taskSelection.size;
      const selectedOnPage = tasks.filter((task) => state.taskSelection.has(task.id)).length;
      $("task-select-page").checked = tasks.length > 0 && selectedOnPage === tasks.length;
      $("task-select-page").indeterminate = selectedOnPage > 0 && selectedOnPage < tasks.length;
      $("task-selection-count").textContent = selected ? selected + " selected" : "No tasks selected";
      $("task-rerun-selected").disabled = !Array.from(state.taskSelection.values()).some((task) => task.replayable);
      $("task-cancel-selected").disabled = !Array.from(state.taskSelection.values()).some((task) => task.cancellable);
      $("task-clear-selection").disabled = selected === 0;
    }

    async function replayTask(id, { confirm = true } = {}) {
      const task = state.taskSelection.get(id) || (state.tasks || []).find((entry) => entry.id === id);
      if (!task?.replayable) return;
      if (confirm && !window.confirm('Run “' + friendlyTaskTitle(task) + '” again with the same saved input?')) return;
      return api("/runs/" + encodeURIComponent(id) + "/replay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    }

    async function cancelTask(id, { confirm = true } = {}) {
      const task = state.taskSelection.get(id) || (state.tasks || []).find((entry) => entry.id === id);
      if (!task?.cancellable) return;
      if (confirm && !window.confirm('Stop “' + friendlyTaskTitle(task) + '”?')) return;
      return api("/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
    }

    async function runSelectedTaskAction(action) {
      const eligible = Array.from(state.taskSelection.values()).filter((task) => action === "replay" ? task.replayable : task.cancellable);
      if (!eligible.length) return;
      const verb = action === "replay" ? "run again" : "stop";
      if (!window.confirm(verb.charAt(0).toUpperCase() + verb.slice(1) + " " + eligible.length + " selected " + (eligible.length === 1 ? "task" : "tasks") + "?")) return;
      const results = await Promise.allSettled(eligible.map((task) => action === "replay" ? replayTask(task.id, { confirm: false }) : cancelTask(task.id, { confirm: false })));
      const failures = results.filter((result) => result.status === "rejected");
      showOutput(failures.length ? (eligible.length - failures.length) + " completed; " + failures.length + " could not be changed." : eligible.length + (action === "replay" ? " tasks started again." : " tasks stopped."));
      state.taskSelection.clear();
      await refreshTasks();
    }

    function formatDuration(value) {
      if (!Number.isFinite(value)) return "—";
      if (value < 1000) return value + "ms";
      if (value < 60000) return (value / 1000).toFixed(1) + "s";
      return Math.floor(value / 60000) + "m " + Math.round(value % 60000 / 1000) + "s";
    }

    async function inspectTask(id) {
      const detail = await api("/tasks/" + encodeURIComponent(id));
      state.selectedTaskId = id;
      const task = detail.task || {};
      $("task-detail-label").textContent = friendlyTaskTitle(task);
      $("task-summary").innerHTML = [
        ["Outcome", friendlyStatus(task.status || "unknown")], ["Started by", friendlyTaskOrigin(task.category || task.actor || "unknown")],
        ["Duration", formatDuration(task.durationMs)], ["Run again", task.replayable ? "Available" : "Not available"]
      ].map(([label, value]) => '<div class="item"><div class="muted">' + escapeHtml(label) + '</div><strong>' + escapeHtml(value) + '</strong></div>').join("");
      $("task-evidence").innerHTML = (detail.run?.events || []).map((event) => '<div class="timeline-row"><span class="timeline-dot"></span><div class="item"><div class="item-line"><strong>' + escapeHtml(friendlyEventTitle(event)) + '</strong><span class="chip">' + escapeHtml(friendlyStatus(event.decision || "recorded")) + '</span></div><div class="muted">' + escapeHtml(relativeTime(event.at)) + '</div><div>' + escapeHtml(event.message || friendlyArea(event.tool) || "") + '</div></div></div>').join("") || '<div class="empty-state"><strong>No timeline yet</strong><span>This task has no recorded updates.</span></div>';
      $("task-verify").disabled = !detail.ledger;
      $("task-replay").disabled = !task.replayable;
      $("task-cancel").disabled = !task.cancellable;
    }

    async function refreshUsage() {
      const data = await api("/usage");
      const summary = data.summary || {};
      $("usage-total-tokens").textContent = Number(summary.totalTokens || 0).toLocaleString();
      $("usage-model-calls").textContent = summary.modelRuns || 0;
      $("metric-runs").textContent = summary.runs || 0;
      $("usage-errors").textContent = summary.errors || 0;
      const max = Math.max(1, ...(data.days || []).map((day) => day.events));
      $("usage-chart").innerHTML = (data.days || []).map((day) => '<span class="bar-column" title="' + escapeHtml(day.day + ': ' + day.events + ' events · ' + day.tokens + ' tokens') + '"><i style="height:' + Math.max(3, Math.round(day.events / max * 165)) + 'px"></i><small>' + escapeHtml(day.day.slice(5)) + '</small></span>').join("");
      $("runs").innerHTML = (data.runs || []).slice(0, 4).map(renderRun).join("") || '<div class="empty-state"><strong>No model usage yet</strong><span>Completed model and agent runs will appear here.</span></div>';
    }

    async function refreshCron() {
      const data = await api("/cron");
      state.cronJobs = data.jobs || [];
      const query = $("cron-query")?.value.trim().toLowerCase() || "";
      const jobs = state.cronJobs.filter((job) => !query || JSON.stringify(job).toLowerCase().includes(query));
      $("cron-enabled").textContent = data.enabled ? "On" : "Off";
      $("cron-count").textContent = data.jobs.length;
      $("cron-next").textContent = data.nextWake ? new Date(data.nextWake).toLocaleString() : "—";
      $("cron-shown").textContent = jobs.length + " shown of " + data.jobs.length;
      $("cron-list").innerHTML = jobs.map((job) => '<div class="cron-card"><div class="item-line"><strong>' + escapeHtml(job.name) + '</strong><span class="chip ' + (job.lastStatus === "error" ? "danger" : job.enabled ? "ok" : "") + '">' + escapeHtml(job.enabled ? friendlyStatus(job.lastStatus || "active") : "Paused") + '</span></div><div class="cron-meta"><span>' + escapeHtml(describeSchedule(job.schedule, job.timezone)) + '</span><span>' + escapeHtml(friendlyArea(job.tool)) + '</span><span>Last run ' + escapeHtml(relativeTime(job.lastRunAt)) + '</span></div><div class="row"><button class="secondary" data-cron-run="' + escapeHtml(job.id) + '" type="button">Run now</button><button class="secondary" data-cron-toggle="' + escapeHtml(job.id) + '" data-enabled="' + escapeHtml(job.enabled) + '" type="button">' + (job.enabled ? "Pause" : "Resume") + '</button><button class="secondary" data-cron-delete="' + escapeHtml(job.id) + '" type="button">Delete</button></div></div>').join("") || '<div class="empty-state"><strong>No schedules yet</strong><span>Create one when you want Ódinn to repeat an action.</span></div>';
    }

    function describeSchedule(value, timezone) {
      const parts = String(value || "").trim().split(/\s+/);
      if (parts.length !== 5) return "Custom schedule";
      const [minute, hour, day, month, weekday] = parts;
      const time = hour !== "*" && minute !== "*" ? new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      const zone = timezone ? " · " + timezone.replace(/_/g, " ") : "";
      if (minute === "0" && hour === "*" && day === "*" && month === "*" && weekday === "*") return "Every hour" + zone;
      if (day === "*" && month === "*" && weekday === "1-5") return "Weekdays at " + time + zone;
      if (day === "*" && month === "*" && weekday === "*") return "Every day at " + time + zone;
      if (day === "*" && month === "*" && /^[0-6]$/.test(weekday)) {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        return "Every " + days[Number(weekday)] + " at " + time + zone;
      }
      return "Custom schedule" + zone;
    }

    function updateSchedulePattern() {
      const frequency = $("cron-frequency").value;
      const [hour, minute] = ($("cron-time").value || "09:00").split(":");
      $("cron-weekday-field").hidden = frequency !== "weekly";
      $("cron-time-field").hidden = frequency === "hourly" || frequency === "custom";
      $("cron-custom-options").open = frequency === "custom";
      if (frequency === "custom") return;
      $("cron-schedule").value = frequency === "hourly"
        ? "0 * * * *"
        : frequency === "weekdays"
          ? minute + " " + hour + " * * 1-5"
          : frequency === "weekly"
            ? minute + " " + hour + " * * " + $("cron-weekday").value
            : minute + " " + hour + " * * *";
    }

    async function refreshAgents() {
      const data = await api("/agents");
      state.agents = data.agents || [];
      const query = $("agent-query")?.value.trim().toLowerCase() || "";
      const agents = state.agents.filter((agent) => !query || JSON.stringify(agent).toLowerCase().includes(query));
      $("agent-total").textContent = state.agents.length;
      $("agent-enabled").textContent = state.agents.filter((agent) => agent.status === "enabled").length;
      $("agent-quarantined").textContent = state.agents.filter((agent) => agent.status === "quarantined").length;
      $("agent-list").innerHTML = agents.map((agent) => '<div class="item agent-package ' + (agent.id === state.selectedAgentId ? "selected" : "") + '" role="button" tabindex="0" data-agent-id="' + escapeHtml(agent.id) + '"><div class="item-line"><strong>' + escapeHtml(agent.name) + '</strong><span class="chip ' + (agent.status === "enabled" ? "ok" : agent.status === "quarantined" ? "danger" : "") + '">' + escapeHtml(friendlyAgentStatus(agent.status)) + '</span></div><div class="muted">' + escapeHtml(agent.description || agent.identity?.description || "Specialized agent") + '</div><div class="chip-row"><span class="chip">' + escapeHtml((agent.tools || []).length + " action" + ((agent.tools || []).length === 1 ? "" : "s")) + '</span><span class="chip">' + escapeHtml((agent.plugins || []).length + " add-on" + ((agent.plugins || []).length === 1 ? "" : "s")) + '</span><span class="chip">Version ' + escapeHtml(agent.version || "1") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No agents yet</strong><span>Add one when you have a recurring kind of work to delegate.</span></div>';
      if (state.selectedAgentId) renderAgentDetail(state.agents.find((agent) => agent.id === state.selectedAgentId));
    }

    function renderAgentDetail(agent) {
      if (!agent) return;
      state.selectedAgentId = agent.id;
      $("agent-detail-status").textContent = friendlyAgentStatus(agent.status);
      $("agent-detail-status").className = "chip " + (agent.status === "enabled" ? "ok" : agent.status === "quarantined" ? "danger" : "");
      const sections = [
        ["Identity", agent.identity],
        ["Instructions", agent.instructions],
        ["Available actions", agent.tools],
        ["Add-ons", agent.plugins],
        ["Connected services", agent.network?.allow || agent.network],
        ["Scheduled work", agent.schedules],
        ["Memory", agent.memory],
        ["Checks", agent.tests],
        ["Package health", agent.integrity ? "Recorded and ready to verify" : "No package health information"]
      ];
      $("agent-detail").className = "agent-inspector";
      $("agent-detail").innerHTML = sections.filter(([, value]) => hasHumanValue(value)).map(([label, value]) => renderHumanSection(label, value)).join("") || '<div class="empty-state"><strong>No additional setup</strong><span>This agent has no extra requirements.</span></div>';
      ["agent-enable", "agent-disable", "agent-quarantine"].forEach((id) => $(id).disabled = false);
      document.querySelectorAll("[data-agent-id]").forEach((item) => item.classList.toggle("selected", item.dataset.agentId === agent.id));
    }

    function friendlyAgentStatus(value) {
      return value === "enabled" ? "Available" : value === "quarantined" ? "Set aside" : "Off";
    }

    function hasHumanValue(value) {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") return Object.keys(value).length > 0;
      return value !== undefined && value !== null && value !== "";
    }

    function renderHumanSection(label, value) {
      let content;
      if (Array.isArray(value)) {
        content = '<div class="chip-row">' + (value.length ? value.map((item) => '<span class="chip">' + escapeHtml(friendlyArea(typeof item === "string" ? item : item?.name || "Configured")) + '</span>').join("") : '<span class="muted">None</span>') + '</div>';
      } else if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([key]) => !/id|hash|digest|path|token|secret/i.test(key));
        content = '<div class="detail-grid">' + entries.map(([key, item]) => '<div class="detail-card"><span>' + escapeHtml(friendlyStatus(key)) + '</span><strong>' + escapeHtml(Array.isArray(item) ? item.map((entry) => typeof entry === "string" ? friendlyArea(entry) : "Configured").join(", ") || "None" : typeof item === "boolean" ? item ? "Yes" : "No" : typeof item === "object" ? "Configured" : friendlyStatus(item)) + '</strong></div>').join("") + '</div>';
      } else {
        content = '<p>' + escapeHtml(String(value)) + '</p>';
      }
      return '<div class="agent-section"><strong>' + escapeHtml(label) + '</strong>' + content + '</div>';
    }

    async function refreshSkills() {
      const data = await api("/skills");
      state.skills = data.skills || [];
      const query = $("skill-query")?.value.trim().toLowerCase() || "";
      const status = $("skill-status-filter")?.value || "all";
      const skills = state.skills.filter((skill) => (status === "all" || skill.status === status) && (!query || JSON.stringify(skill).toLowerCase().includes(query)));
      $("skill-total").textContent = state.skills.length;
      $("skill-enabled").textContent = state.skills.filter((skill) => skill.status === "enabled").length;
      $("skill-unmanaged").textContent = state.skills.filter((skill) => skill.status === "unmanaged" || skill.status === "draft").length;
      $("skill-quarantined").textContent = state.skills.filter((skill) => skill.status === "quarantined").length;
      $("skills-list").innerHTML = skills.map((skill) => '<div class="item skill-card ' + (skill.id === state.selectedSkillId ? "selected" : "") + '" role="button" tabindex="0" data-skill-id="' + escapeHtml(skill.id) + '"><div class="item-line"><strong>' + escapeHtml(skill.name) + '</strong><span class="chip ' + (skill.status === "enabled" ? "ok" : skill.status === "quarantined" ? "danger" : "warn") + '">' + escapeHtml(friendlySkillStatus(skill.status)) + '</span></div><p>' + escapeHtml(skill.description || "No description yet") + '</p><div class="chip-row"><span class="chip">' + escapeHtml(friendlySkillSource(skill.source)) + '</span><span class="chip">' + escapeHtml(skill.version ? "Version " + skill.version : "Local skill") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No matching skills</strong><span>Create a skill or change the filter.</span></div>';
      if (state.selectedSkillId) renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
    }

    function renderSkillDetail(skill) {
      if (!skill) return;
      state.selectedSkillId = skill.id;
      $("skill-detail-status").textContent = friendlySkillStatus(skill.status);
      $("skill-detail-status").className = "chip " + (skill.status === "enabled" ? "ok" : skill.status === "quarantined" ? "danger" : "warn");
      const requirements = [
        ["Actions it can use", skill.requestedTools || []], ["Access it requests", skill.requestedCapabilities || []], ["Connected accounts", skill.requestedSecrets || []],
        ["Websites it can contact", skill.network?.allow || []], ["Package check", skill.verification?.valid === true ? "Passed" : skill.verification?.valid === false ? "Needs attention" : skill.integrity ? "Ready to check" : "Local skill"], ["Where it came from", friendlySkillSource(skill.source)]
      ];
      $("skill-detail").className = "agent-inspector";
      $("skill-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(skill.name) + '</strong><p>' + escapeHtml(skill.description || "No description") + '</p></div>' + requirements.map(([label, value]) => renderHumanSection(label, value)).join("");
      const managed = skill.source === "managed";
      $("skill-enable").disabled = !managed || skill.status === "enabled";
      $("skill-disable").disabled = !managed || skill.status === "disabled";
      $("skill-verify").disabled = !managed;
      $("skill-quarantine").disabled = !managed || skill.status === "quarantined";
      document.querySelectorAll("[data-skill-id]").forEach((item) => item.classList.toggle("selected", item.dataset.skillId === skill.id));
    }

    function friendlySkillStatus(value) {
      if (value === "enabled") return "Available";
      if (value === "quarantined") return "Set aside";
      if (value === "unmanaged" || value === "draft") return "Found locally";
      return "Off";
    }

    function friendlySkillSource(value) {
      if (value === "managed") return "Created in Ódinn";
      if (value === "legacy-extension") return "Imported extension";
      return "Found in this workspace";
    }

    async function refreshProjects() {
      const projectData = await api("/projects?includeArchived=true");
      const sessionData = await api("/sessions?limit=100");
      const goalData = await api("/goals?limit=100");
      state.projects = projectData.projects || [];
      state.sessions = sessionData.sessions || [];
      state.goals = goalData.goals || [];
      if (!state.selectedProjectId || !state.projects.some((project) => project.id === state.selectedProjectId)) state.selectedProjectId = projectData.defaultProjectId || state.projects[0]?.id || "";
      const query = $("project-query")?.value.trim().toLowerCase() || "";
      const projects = state.projects.filter((project) => !query || JSON.stringify(project).toLowerCase().includes(query));
      $("project-total").textContent = state.projects.filter((project) => project.status === "active").length;
      $("project-session-count").textContent = state.projects.reduce((sum, project) => sum + Number(project.sessionCount || 0), 0);
      $("project-goal-count").textContent = state.projects.reduce((sum, project) => sum + Number(project.goalCount || 0), 0);
      $("project-active-goal-count").textContent = state.projects.reduce((sum, project) => sum + Number(project.activeGoalCount || 0), 0);
      $("project-list").innerHTML = projects.map((project) => '<div class="item project-card ' + (project.id === state.selectedProjectId ? "selected" : "") + '" role="button" tabindex="0" data-project-id="' + escapeHtml(project.id) + '"><div class="item-line"><strong>' + escapeHtml(project.name) + '</strong><span class="chip ' + (project.status === "active" ? "ok" : "") + '">' + escapeHtml(project.status) + '</span></div><p>' + escapeHtml(project.description || "No description") + '</p><div class="chip-row"><span class="chip">' + escapeHtml(project.sessionCount + " sessions") + '</span><span class="chip">' + escapeHtml(project.goalCount + " goals") + '</span></div></div>').join("") || '<div class="empty-state"><strong>No matching projects</strong><span>Create one or clear the filter.</span></div>';
      populateScopeSelectors();
      renderProjectDetail(state.projects.find((project) => project.id === state.selectedProjectId));
    }

    function renderProjectDetail(project) {
      if (!project) return;
      state.selectedProjectId = project.id;
      const sessions = (state.sessions || []).filter((session) => session.projectId === project.id);
      const goals = (state.goals || []).filter((goal) => goal.projectId === project.id);
      $("project-detail-status").textContent = project.status;
      $("project-detail").className = "agent-inspector";
      $("project-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(project.name) + '</strong><p>' + escapeHtml(project.description || "No description") + '</p></div>' +
        '<div class="agent-section"><strong>Sessions</strong>' + renderNamedList(sessions.map((session) => session.title), "No sessions yet") + '</div>' +
        '<div class="agent-section"><strong>Goals</strong>' + renderNamedList(goals.map((goal) => friendlyStatus(goal.status) + " · " + goal.title), "No goals yet") + '</div>';
      $("project-open-sessions").disabled = false;
      $("project-open-goals").disabled = false;
      $("project-archive").disabled = project.id === "project_default" || project.status === "archived";
      document.querySelectorAll("[data-project-id]").forEach((item) => item.classList.toggle("selected", item.dataset.projectId === project.id));
    }

    function renderNamedList(values, emptyText) {
      return values.length ? '<ul class="human-list">' + values.map((value) => '<li>' + escapeHtml(value) + '</li>').join("") + '</ul>' : '<p class="muted">' + escapeHtml(emptyText) + '</p>';
    }

    function populateScopeSelectors() {
      const projectOptions = (state.projects || []).map((project) => '<option value="' + escapeHtml(project.id) + '">' + escapeHtml(project.name + (project.status === "archived" ? " (archived)" : "")) + '</option>').join("");
      const allProjectOptions = '<option value="all">All projects</option>' + projectOptions;
      if ($("session-project-filter")) { const selected = $("session-project-filter").value; $("session-project-filter").innerHTML = allProjectOptions; $("session-project-filter").value = selected && [...$("session-project-filter").options].some((option) => option.value === selected) ? selected : "all"; }
      if ($("goal-project-filter")) { const selected = $("goal-project-filter").value; $("goal-project-filter").innerHTML = allProjectOptions; $("goal-project-filter").value = selected && [...$("goal-project-filter").options].some((option) => option.value === selected) ? selected : "all"; }
      updateGoalScopeOptions();
      updateMemoryScopeOptions();
      if (state.memoryCandidates?.length) renderMemoryCandidates();
      if (state.memories?.length) renderMemoryLibrary();
    }

    function updateGoalScopeOptions() {
      const type = $("goal-scope-type")?.value || "project";
      const values = type === "session" ? (state.sessions || []).map((session) => [session.id, session.title]) : (state.projects || []).filter((project) => project.status === "active").map((project) => [project.id, project.name]);
      $("goal-scope-id").innerHTML = values.map(([id, name]) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(name) + '</option>').join("");
    }

    function updateMemoryScopeOptions() {
      const type = $("memory-scope-type")?.value || "global";
      $("memory-scope-target-field").hidden = type === "global";
      $("memory-scope-id").disabled = type === "global";
      const values = type === "session" ? (state.sessions || []).map((session) => [session.id, session.title]) : type === "project" ? (state.projects || []).map((project) => [project.id, project.name]) : [["", "Available everywhere"]];
      $("memory-scope-id").innerHTML = values.map(([id, name]) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(name) + '</option>').join("");
    }

    function setMemoryTab(tab, userInitiated = false) {
      const next = tab === "saved" ? "saved" : "suggestions";
      state.memoryTab = next;
      if (userInitiated) state.memoryTabInitialized = true;
      const suggestions = next === "suggestions";
      $("memory-tab-suggestions").classList.toggle("active", suggestions);
      $("memory-tab-suggestions").setAttribute("aria-selected", String(suggestions));
      $("memory-tab-suggestions").tabIndex = suggestions ? 0 : -1;
      $("memory-tab-saved").classList.toggle("active", !suggestions);
      $("memory-tab-saved").setAttribute("aria-selected", String(!suggestions));
      $("memory-tab-saved").tabIndex = suggestions ? -1 : 0;
      $("memory-suggestions-panel").hidden = !suggestions;
      $("memory-saved-panel").hidden = suggestions;
    }

    async function refreshMemory() {
      const health = await api("/memory/status");
      state.memoryHealth = health;
      $("memory-new-toggle").disabled = !health.integration?.writeAllowed;
      if (!health.integration?.readAllowed) {
        $("memory-record-count").textContent = "—";
        $("memory-candidate-count").textContent = "—";
        $("memory-recall-status").textContent = "Recall off";
        $("memory-last-update").textContent = "Unavailable";
        $("memory-health").textContent = "Memory permission required";
        $("memory-health").className = "chip danger";
        $("memory-status-copy").textContent = "Ódinn cannot read or manage memory under the current policy.";
        $("memory-result-count").textContent = "Unavailable";
        $("memory-candidate-badge").textContent = "Unavailable";
        $("memory-tab-suggestions-count").textContent = "—";
        $("memory-tab-saved-count").textContent = "—";
        $("memory-candidate-list").innerHTML = '<div class="empty-state memory-empty"><strong>Suggestions are unavailable</strong><span>Memory access is turned off for this workspace.</span></div>';
        $("memory-list").innerHTML = '<div class="empty-state memory-empty"><strong>Saved memories are unavailable</strong><span>Memory access is turned off for this workspace.</span></div>';
        $("memory-tree").innerHTML = '<div class="empty-state"><strong>Organization unavailable</strong><span>No saved context was read.</span></div>';
        return;
      }
      const [data, tree, candidateData] = await Promise.all([
        api("/memory?limit=100"),
        api("/memory/browse?limit=100"),
        api("/memory/candidates?status=pending&limit=100")
      ]);
      state.memories = data.memories || [];
      state.memoryCandidates = candidateData.candidates || [];
      $("memory-record-count").textContent = health.records || 0;
      $("memory-candidate-count").textContent = state.memoryCandidates.length;
      $("memory-tab-suggestions-count").textContent = state.memoryCandidates.length;
      $("memory-tab-saved-count").textContent = health.records || 0;
      $("memory-recall-status").textContent = health.integration?.autoRecall ? "Recall on" : "Recall off";
      $("memory-last-update").textContent = health.latestAt ? "Updated " + relativeTime(health.latestAt) : "No saved memories yet";
      const healthy = health.integration?.readAllowed && health.integration?.writeAllowed;
      $("memory-health").textContent = healthy ? "On" : "Read only";
      $("memory-health").className = "chip " + (healthy ? "ok" : "danger");
      $("memory-status-copy").textContent = health.integration?.autoLearn
        ? (health.integration?.autoRecall ? "Ódinn suggests useful details and recalls only the memories you keep." : "Ódinn can suggest useful details, but automatic recall is turned off.")
        : "Automatic suggestions are off. You can still add and manage saved memories here.";
      $("memory-tree").innerHTML = (tree.namespaces || []).map((entry) => '<div class="item"><div class="item-line"><strong>' + escapeHtml(friendlyMemoryNamespace(entry.namespace)) + '</strong><span class="chip">' + escapeHtml(entry.count + " memories") + '</span></div><div class="muted">' + escapeHtml(Object.entries(entry.tiers || {}).map(([tier, count]) => memoryTierLabel(tier) + ": " + count).join(" · ")) + '</div></div>').join("") || '<div class="empty-state"><strong>No memory groups yet</strong><span>New durable context will appear here.</span></div>';
      renderMemoryLibrary();
      renderMemoryCandidates();
      if (!state.memoryTabInitialized) {
        setMemoryTab(state.memoryCandidates.length ? "suggestions" : "saved");
        state.memoryTabInitialized = true;
      } else {
        setMemoryTab(state.memoryTab);
      }
    }

    function renderMemoryLibrary() {
      const query = $("memory-query").value.trim().toLowerCase();
      const kind = $("memory-kind-filter").value;
      const scopeType = $("memory-scope-filter").value;
      const memories = (state.memories || []).filter((memory) => {
        if (kind && memory.kind !== kind) return false;
        if (scopeType && (memory.scopeType || "global") !== scopeType) return false;
        if (!query) return true;
        const searchable = [memory.subject, memory.summary, memory.text, ...(memory.tags || [])].filter(Boolean).join(" ").toLowerCase();
        return query.split(/\s+/).filter(Boolean).every((term) => searchable.includes(term));
      });
      $("memory-result-count").textContent = memories.length + (memories.length === 1 ? " saved memory" : " saved memories");
      $("memory-list").innerHTML = memories.map((memory) => '<button class="item memory-card ' + (memory.id === state.selectedMemoryId ? "selected" : "") + '" type="button" data-memory-id="' + escapeHtml(memory.id) + '"><div class="item-line"><strong>' + escapeHtml(memory.subject || friendlyStatus(memory.kind)) + '</strong><span class="chip">' + escapeHtml(friendlyStatus(memory.kind)) + '</span></div><p>' + escapeHtml(memory.summary || memory.text) + '</p><div class="scope-label">' + escapeHtml(memoryScopeLabel(memory)) + '</div><div class="muted">' + escapeHtml(memorySourceLabel(memory)) + ' · ' + escapeHtml(relativeTime(memory.at)) + '</div></button>').join("") || '<div class="empty-state memory-empty"><strong>No saved memories found</strong><span>' + (query || kind || scopeType ? "Try clearing a filter." : "Add a lasting preference, fact, or decision when you want Ódinn to remember it.") + '</span></div>';
      const selectedMemory = memories.find((memory) => memory.id === state.selectedMemoryId)
        || (matchMedia("(max-width: 600px)").matches ? undefined : memories[0]);
      if (selectedMemory) renderMemoryDetail(selectedMemory);
      else clearMemoryDetail();
    }

    function renderMemoryCandidates() {
      const candidates = state.memoryCandidates || [];
      const canDecide = state.memoryHealth?.integration?.writeAllowed === true;
      $("memory-candidate-badge").textContent = candidates.length + (candidates.length === 1 ? " to review" : " to review");
      $("memory-candidate-badge").className = "chip " + (candidates.length ? "warn" : "ok");
      $("memory-candidate-list").innerHTML = candidates.map((candidate) => {
        const destinationOptions = [
          ["original", "Suggested · " + memoryScopeLabel(candidate)],
          ["global", "Everywhere"],
          ...(state.projects || []).filter((project) => project.status === "active").map((project) => ["project:" + project.id, "Project · " + project.name])
        ];
        return '<article class="memory-suggestion-card"><div class="memory-suggestion-meta"><span class="chip">' + escapeHtml(friendlyStatus(candidate.kind)) + '</span><span class="muted">' + escapeHtml(memoryCandidateOriginLabel(candidate)) + ' · ' + escapeHtml(relativeTime(candidate.at)) + '</span></div><h3>' + escapeHtml(candidate.subject || "Suggested memory") + '</h3><p>' + escapeHtml(candidate.summary || candidate.text) + '</p><label class="memory-destination"><span>Use this memory in</span><select data-memory-candidate-destination="' + escapeHtml(candidate.id) + '" aria-label="Where to use ' + escapeHtml(candidate.subject || "this memory") + '">' + destinationOptions.map(([value, label]) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(label) + '</option>').join("") + '</select></label><div class="memory-suggestion-actions"><button type="button" data-memory-candidate-keep="' + escapeHtml(candidate.id) + '"' + (canDecide ? "" : " disabled") + '>Keep memory</button><button class="secondary" type="button" data-memory-candidate-dismiss="' + escapeHtml(candidate.id) + '"' + (canDecide ? "" : " disabled") + '>Dismiss</button></div></article>';
      }).join("") || '<div class="empty-state memory-empty"><strong>You are all caught up</strong><span>New suggestions will appear here after Ódinn notices something useful in a conversation.</span><div class="row"><button class="secondary" type="button" data-memory-tab-target="saved">View saved memories</button></div></div>';
    }

    async function decideMemoryCandidate(candidateId, decision, button) {
      const candidate = state.memoryCandidates.find((entry) => entry.id === candidateId);
      if (!candidate) return;
      if (decision === "rejected" && !window.confirm('Dismiss "' + (candidate.subject || "this suggestion") + '"?')) return;
      const destination = document.querySelector('[data-memory-candidate-destination="' + CSS.escape(candidateId) + '"]')?.value || "original";
      const body = { decision };
      if (decision === "accepted" && destination === "global") body.scopeType = "global";
      if (decision === "accepted" && destination.startsWith("project:")) {
        body.scopeType = "project";
        body.scopeId = destination.slice("project:".length);
      }
      setBusy(button, true);
      const result = await api("/memory/candidates/" + encodeURIComponent(candidateId) + "/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (result.memory?.id) state.selectedMemoryId = result.memory.id;
      const wasLast = state.memoryCandidates.length === 1;
      if (decision === "accepted" && wasLast) setMemoryTab("saved");
      showOutput(decision === "accepted" ? "Memory saved." : "Suggestion dismissed.");
      await refreshMemory();
    }

    function clearMemoryDetail() {
      state.selectedMemoryId = "";
      $("memory-detail-panel").hidden = true;
      $("memory-detail-kind").textContent = "No selection";
      $("memory-detail").className = "empty-state";
      $("memory-detail").innerHTML = '<strong>Choose a saved memory</strong><span>You will see what Ódinn remembers and where it can use it.</span>';
      $("memory-correct").disabled = true;
      $("memory-forget").disabled = true;
      $("memory-recall-result").hidden = true;
    }

    function renderMemoryDetail(memory) {
      if (!memory) return;
      state.selectedMemoryId = memory.id;
      $("memory-detail-panel").hidden = false;
      $("memory-detail-kind").textContent = friendlyStatus(memory.kind);
      $("memory-detail").className = "agent-inspector";
      $("memory-detail").innerHTML = '<div class="agent-section"><strong>' + escapeHtml(memory.subject || friendlyStatus(memory.kind)) + '</strong><p>' + escapeHtml(memory.text) + '</p></div><div class="detail-grid">' +
        [["Applies to", memoryScopeLabel(memory)], ["Added", memorySourceLabel(memory)], ["Saved", relativeTime(memory.at)]].map(([label, value]) => '<div class="detail-card"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>').join("") + '</div><details class="advanced-options"><summary>Technical details</summary><p>Confidence: ' + escapeHtml(memoryConfidenceLabel(memory.confidence)) + ' · Type: ' + escapeHtml(friendlyStatus(memory.kind)) + '</p></details>';
      $("memory-correct").disabled = !state.memoryHealth?.integration?.writeAllowed;
      $("memory-forget").disabled = !state.memoryHealth?.integration?.writeAllowed;
      $("memory-recall-result").hidden = true;
      document.querySelectorAll("[data-memory-id]").forEach((item) => item.classList.toggle("selected", item.dataset.memoryId === memory.id));
    }

    function memoryScopeLabel(memory) {
      if (memory.scopeType === "project") return "Project · " + ((state.projects || []).find((project) => project.id === memory.scopeId)?.name || "One project");
      if (memory.scopeType === "session") return "Conversation · " + ((state.sessions || []).find((session) => session.id === memory.scopeId)?.title || "One conversation");
      return "Everywhere";
    }

    function memorySourceLabel(memory) {
      const value = String((memory.authority || "") + " " + (memory.source || ""));
      if (/user/i.test(value)) return "Added manually";
      if (/agent|auto/i.test(value)) return "Suggested by Ódinn";
      if (/import/i.test(value)) return "Imported";
      return "Saved locally";
    }

    function memoryCandidateOriginLabel(candidate) {
      const sessionId = candidate.sessionId || (candidate.scopeType === "session" ? candidate.scopeId : "");
      const session = (state.sessions || []).find((entry) => entry.id === sessionId);
      if (session) return "From " + session.title;
      const projectId = candidate.projectId || (candidate.scopeType === "project" ? candidate.scopeId : "");
      const project = (state.projects || []).find((entry) => entry.id === projectId);
      if (project) return "From " + project.name;
      return "From a recent conversation";
    }

    function memoryConfidenceLabel(value) {
      const score = Number(value);
      if (!Number.isFinite(score)) return "Not rated";
      if (score >= .9) return "High";
      if (score >= .65) return "Medium";
      return "Low";
    }

    function memoryTierLabel(value) {
      return value === "l0" ? "Summaries" : value === "l2" ? "Supporting details" : "Facts";
    }

    function friendlyMemoryNamespace(value) {
      return String(value || "General").split("/").map((part) => friendlyStatus(part)).join(" · ");
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
      const projectId = $("session-project-filter")?.value || "all";
      const groupBy = $("session-group")?.value || "none";
      const sessions = (state.sessions || []).filter((session) => (!query || JSON.stringify(session).toLowerCase().includes(query)) && (status === "all" || (session.status || "open") === status) && (projectId === "all" || session.projectId === projectId));
      if (groupBy === "none") {
        $("session-list").innerHTML = sessions.map(renderSessionRecord).join("") || '<div class="empty-state"><strong>No matching sessions</strong><span>Change the filters or create a new session.</span></div>';
        return;
      }
      const groups = new Map();
      for (const session of sessions) {
        const key = groupBy === "project" ? (state.projects.find((project) => project.id === session.projectId)?.name || "Workspace") : groupBy === "source" ? friendlySessionSource(session.source) : friendlyStatus(session.status || "open");
        groups.set(key, [...(groups.get(key) || []), session]);
      }
      $("session-list").innerHTML = Array.from(groups.entries()).map(([label, entries]) => '<div class="data-row data-group"><span style="grid-column:1/-1"><strong>' + escapeHtml(label) + '</strong> <span class="muted">' + escapeHtml(entries.length + " sessions") + '</span></span></div>' + entries.map(renderSessionRecord).join("")).join("") || '<div class="empty-state"><strong>No matching sessions</strong><span>Change the filters or create a new session.</span></div>';
    }

    async function refreshGoals() {
      const data = await api("/goals?limit=100");
      state.goals = data.goals || [];
      const projectId = $("goal-project-filter")?.value || "all";
      const status = $("goal-status-filter")?.value || "all";
      const query = $("goal-query")?.value.trim().toLowerCase() || "";
      const goals = state.goals.filter((goal) =>
        (projectId === "all" || goal.projectId === projectId)
        && (status === "all" || goal.status === status)
        && (!query || [goal.title, goal.description, goal.notes?.at(-1)?.note].some((value) => String(value || "").toLowerCase().includes(query))));
      $("goal-active-count").textContent = state.goals.filter((goal) => goal.status === "active").length;
      $("goal-paused-count").textContent = state.goals.filter((goal) => goal.status === "paused").length;
      $("goal-blocked-count").textContent = state.goals.filter((goal) => goal.status === "blocked").length;
      $("goal-completed-count").textContent = state.goals.filter((goal) => goal.status === "completed").length;
      $("goal-list").innerHTML = goals.map((goal) => {
        const project = state.projects.find((entry) => entry.id === goal.projectId);
        const session = state.sessions.find((entry) => entry.id === goal.sessionId);
        const tone = goal.status === "completed" ? "ok" : goal.status === "blocked" || goal.status === "cancelled" ? "danger" : "warn";
        const resumeLabel = goal.status === "completed" ? "Reopen" : "Resume";
        const quickActions = goal.status === "active"
          ? '<button class="secondary" data-goal-action="paused" type="button">Pause</button><button data-goal-action="completed" type="button">Complete</button>'
          : goal.status === "paused" || goal.status === "blocked" || goal.status === "completed" || goal.status === "cancelled"
            ? '<button class="secondary" data-goal-action="active" type="button">' + resumeLabel + '</button>' + (goal.status === "completed" ? "" : '<button data-goal-action="completed" type="button">Complete</button>')
            : "";
        return '<article class="item goal-card ' + (goal.id === state.selectedGoalId ? "selected" : "") + '" data-goal-id="' + escapeHtml(goal.id) + '"><div class="item-line"><strong>' + escapeHtml(goal.title) + '</strong><span class="chip ' + tone + '">' + escapeHtml(friendlyStatus(goal.status)) + '</span></div><p>' + escapeHtml(goal.description || "No success criteria recorded") + '</p><div class="scope-label">' + escapeHtml(goal.scopeType === "session" ? "Conversation · " + (session?.title || "Unavailable conversation") : "Project · " + (project?.name || "Unavailable project")) + '</div><div class="muted">' + (goal.notes?.length ? escapeHtml(goal.notes.at(-1).note) + " · " : "") + 'Updated ' + escapeHtml(relativeTime(goal.updatedAt)) + '</div><div class="row goal-actions"><button class="secondary" data-goal-edit type="button">Edit</button>' + quickActions + '</div></article>';
      }).join("") || '<div class="empty-state"><strong>No matching goals</strong><span>Create a goal or choose another project.</span></div>';
    }

    function openGoalEditor(goal) {
      state.selectedGoalId = goal?.id || "";
      $("goal-form").reset();
      $("goal-title").value = goal?.title || "";
      $("goal-description").value = goal?.description || "";
      $("goal-status").value = goal?.status || "active";
      $("goal-scope-type").value = goal?.scopeType || "project";
      updateGoalScopeOptions();
      if (goal) $("goal-scope-id").value = goal.scopeId || goal.projectId || goal.sessionId || "";
      $("goal-scope-type").disabled = Boolean(goal);
      $("goal-scope-id").disabled = Boolean(goal);
      $("goal-editor-title").textContent = goal ? "Edit goal" : "Create goal";
      $("goal-status-field").hidden = !goal;
      $("create-goal").hidden = Boolean(goal);
      $("update-goal").hidden = !goal;
      $("goal-dialog").showModal();
    }

    async function quickUpdateGoal(goal, status) {
      const verb = status === "completed" ? "Mark this goal complete?" : status === "paused" ? "Pause this goal?" : "Make this goal active again?";
      if (!window.confirm(verb)) return;
      await api("/goals/" + encodeURIComponent(goal.id) + "/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note: status === "completed" ? "Marked complete from the goal board." : status === "paused" ? "Paused from the goal board." : "Resumed from the goal board.", source: "console" })
      });
      await refreshGoals();
    }

    async function refreshAudit() {
      const params = new URLSearchParams({ page: String(state.auditPage || 1), pageSize: $("audit-page-size").value });
      const filters = { q: "audit-query", type: "audit-type-filter", tool: "audit-tool-filter", actor: "audit-actor-filter", outcome: "audit-outcome-filter", from: "audit-from", to: "audit-to" };
      for (const [key, id] of Object.entries(filters)) if ($(id).value) params.set(key, $(id).value);
      const result = await api("/audit/query?" + params);
      state.audit = result.events || [];
      state.auditPagination = result.pagination || { page: 1, pages: 1, total: 0, from: 0, to: 0 };
      state.auditPage = state.auditPagination.page;
      const summary = result.summary || {};
      $("audit-count").textContent = summary.events || 0;
      $("audit-run-count").textContent = summary.runs || 0;
      $("audit-model-count").textContent = summary.modelRuns || 0;
      $("audit-error-count").textContent = summary.errors || 0;
      $("audit-events").innerHTML = state.audit.map(renderAuditEvent).join("") || '<div class="empty-state"><strong>No matching activity</strong><span>Try another filter or start some work.</span></div>';
      $("audit-log").textContent = JSON.stringify(state.audit, null, 2);
      $("audit-showing").textContent = state.auditPagination.total ? state.auditPagination.from + "–" + state.auditPagination.to + " of " + state.auditPagination.total + " matching" : "0 matching events";
      $("audit-page-label").textContent = "Page " + state.auditPagination.page + " of " + state.auditPagination.pages;
      $("audit-prev").disabled = state.auditPagination.page <= 1;
      $("audit-next").disabled = state.auditPagination.page >= state.auditPagination.pages;
      const facetTargets = { types: "audit-type-filter", tools: "audit-tool-filter", actors: "audit-actor-filter", outcomes: "audit-outcome-filter" };
      for (const [facet, id] of Object.entries(facetTargets)) {
        const select = $(id);
        const selected = select.value;
        const label = select.options[0]?.textContent || "All";
        select.innerHTML = '<option value="">' + escapeHtml(label) + '</option>' + (result.facets?.[facet] || []).map((entry) => '<option value="' + escapeHtml(entry.value) + '">' + escapeHtml(auditFacetLabel(facet, entry.value) + " (" + entry.count + ")") + '</option>').join("");
        if ([...select.options].some((option) => option.value === selected)) select.value = selected;
      }
    }

    function auditFacetLabel(facet, value) {
      if (facet === "types") return friendlyEventTitle({ type: value });
      if (facet === "tools") return friendlyArea(value);
      if (facet === "actors") return friendlyActor(value);
      return friendlyStatus(value);
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

    $("activity-tab-overview").addEventListener("click", () => setActivityTab("overview"));
    $("activity-tab-history").addEventListener("click", () => setActivityTab("history"));
    document.querySelectorAll("[data-experimental-page]").forEach((page) => {
      page.addEventListener("click", async (event) => {
        const featureKey = page.dataset.experimentalPage;
        const action = event.target.closest("[data-feature-action]");
        if (action) {
          state.experimentalActions ||= {};
          state.experimentalActions[featureKey] = action.dataset.featureAction;
          renderExperimentalFeaturePage(featureKey);
          return;
        }
        if (event.target.closest("[data-role=run]")) {
          runExperimentalAction(featureKey).catch((error) => showOutput(error.message));
          return;
        }
        if (event.target.closest("[data-refresh-experimental]")) {
          refreshExperiments().catch((error) => showOutput(error.message));
          return;
        }
        if (event.target.closest("[data-copy-access-pass]") && state.lastCapabilityToken) {
          await navigator.clipboard?.writeText(state.lastCapabilityToken);
          showOutput("Access pass copied. It remains hidden on screen.");
        }
      });
    });
    $("refresh-improvements").addEventListener("click", () => refreshImprovements().catch((error) => showOutput(error.message)));
    $("learn-improvements").addEventListener("click", () => learnImprovements().catch((error) => showOutput(error.message)));
    $("improvement-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-improvement-id]");
      if (!item) return;
      state.selectedImprovementId = item.dataset.improvementId;
      renderImprovements();
    });
    $("improvement-rollback").addEventListener("click", () => rollbackImprovement().catch((error) => showOutput(error.message)));

    $("sidebar-toggle").addEventListener("click", () => {
      if (matchMedia("(max-width: 980px)").matches) {
        const open = $("shell").classList.toggle("nav-open");
        $("sidebar-toggle").title = open ? "Close navigation" : "Open navigation";
        $("sidebar-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
        $("sidebar-toggle").setAttribute("aria-expanded", String(open));
        return;
      }
      const collapsed = $("shell").classList.toggle("sidebar-collapsed");
      $("sidebar-toggle").title = collapsed ? "Expand navigation" : "Collapse navigation";
      $("sidebar-toggle").setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
      $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
    });
    $("mobile-scrim").addEventListener("click", closeMobileNavigation);
    window.addEventListener("hashchange", () => switchView(viewFromHash(), { updateHash: false }));
    window.addEventListener("resize", () => {
      if (!matchMedia("(max-width: 980px)").matches) closeMobileNavigation();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMobileNavigation();
      const target = event.target.closest?.('[role="button"][tabindex="0"]');
      if (target && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        target.click();
      }
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
    $("format-config").addEventListener("click", formatConfig);
    $("reload-config").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        setBusy(button, true);
        await refreshConfig();
        showToast("Configuration reloaded from disk.");
      } catch (error) {
        $("config-error").textContent = error.message;
        showToast(error.message, "error");
      } finally {
        setBusy(button, false);
      }
    });
    $("save-config").addEventListener("click", saveConfig);
    $("sidebar-search").addEventListener("click", () => {
      const query = window.prompt("Search sessions", "");
      if (query === null) return;
      const normalized = query.trim().toLowerCase();
      document.querySelectorAll(".menu-chat").forEach((item) => {
        item.hidden = Boolean(normalized) && !item.textContent.toLowerCase().includes(normalized);
      });
    });
    $("sidebar-settings").addEventListener("click", () => switchView("config"));
    $("sidebar-console").addEventListener("click", () => switchView("capabilities"));
    $("sidebar-theme").addEventListener("click", () => {
      document.body.classList.toggle("soft-contrast");
      showOutput(document.body.classList.contains("soft-contrast") ? "Soft contrast enabled." : "Soft contrast disabled.");
    });
    $("model-select").addEventListener("change", (event) => {
      state.modelOverride = event.currentTarget.value;
    });
    $("copy-onboard-command").addEventListener("click", async () => {
      await navigator.clipboard?.writeText("odinn onboard");
      showOutput("Copied odinn onboard.");
    });
    $("remote-signout").addEventListener("click", async (event) => {
      if (!state.hosted) return;
      const button = event.currentTarget;
      setBusy(button, true);
      try {
        await api("/auth/logout", { method: "POST" });
        location.assign("/auth/login");
      } catch (error) {
        setBusy(button, false);
        showOutput("Sign out failed: " + error.message);
      }
    });
    $("new-chat").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        setBusy(button, true);
        await createChat("New chat");
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(button, false);
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
      const button = event.currentTarget;
      try {
        setBusy(button, true);
        await sendChatMessage($("chat-input").value);
      } catch (error) {
        $("chat-status").textContent = "Error";
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    });
    $("chat-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        $("send-chat").click();
      }
    });
    $("clear-output").addEventListener("click", () => showOutput("Ready."));
    $("copy-audit").addEventListener("click", async () => {
      await navigator.clipboard?.writeText($("audit-log").textContent);
      showOutput("Current audit page copied.");
    });
    $("refresh-audit").addEventListener("click", () => refreshAudit().catch((error) => showOutput(error.message)));
    let auditDebounce;
    const changeAuditFilters = () => {
      state.auditPage = 1;
      clearTimeout(auditDebounce);
      auditDebounce = setTimeout(() => refreshAudit().catch((error) => showOutput(error.message)), 180);
    };
    ["audit-query", "audit-type-filter", "audit-tool-filter", "audit-actor-filter", "audit-outcome-filter", "audit-from", "audit-to"].forEach((id) => {
      $(id).addEventListener(id === "audit-query" ? "input" : "change", changeAuditFilters);
    });
    $("audit-page-size").addEventListener("change", changeAuditFilters);
    $("audit-prev").addEventListener("click", () => { state.auditPage = Math.max(1, state.auditPage - 1); refreshAudit().catch((error) => showOutput(error.message)); });
    $("audit-next").addEventListener("click", () => { state.auditPage = Math.min(state.auditPagination.pages || 1, state.auditPage + 1); refreshAudit().catch((error) => showOutput(error.message)); });
    $("audit-reset").addEventListener("click", () => {
      ["audit-query", "audit-type-filter", "audit-tool-filter", "audit-actor-filter", "audit-outcome-filter", "audit-from", "audit-to"].forEach((id) => { $(id).value = ""; });
      changeAuditFilters();
    });
    $("audit-verify").addEventListener("click", async () => {
      try {
        const result = await api("/audit/verify");
        const valid = result.valid !== false;
        $("audit-integrity").textContent = valid ? "Journal chain valid" : "Integrity failure";
        $("audit-integrity").className = "chip " + (valid ? "ok" : "danger");
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("export-audit").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state.audit, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "odinn-audit-page-" + String(state.auditPage) + ".json";
      link.click();
      URL.revokeObjectURL(link.href);
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
      const card = event.target.closest("[data-goal-id]");
      if (!card) return;
      const goal = state.goals.find((entry) => entry.id === card.dataset.goalId);
      if (!goal) return;
      const action = event.target.closest("[data-goal-action]");
      if (action) {
        quickUpdateGoal(goal, action.dataset.goalAction).catch((error) => showOutput(error.message));
        return;
      }
      if (event.target.closest("[data-goal-edit]")) openGoalEditor(goal);
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
    $("session-list").addEventListener("change", async (event) => {
      const select = event.target.closest("[data-session-project]");
      if (!select) return;
      try {
        const detail = await api("/sessions/" + encodeURIComponent(select.dataset.sessionProject), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: select.value }) });
        state.selectedProjectId = select.value;
        showOutput(detail);
        await refreshProjects();
        await refreshSessions();
      } catch (error) { showOutput(error.message); }
    });

    $("create-session").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        const title = window.prompt("Session title", "New session");
        if (!title?.trim()) return;
        setBusy(button, true);
        const session = await api("/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: title.trim(), source: "console", projectId: state.projects.find((project) => project.id === $("session-project-filter").value && project.status === "active")?.id || state.projects.find((project) => project.id === state.selectedProjectId && project.status === "active")?.id || "project_default" })
        });
        state.selectedSessionId = session.id;
        showOutput(session);
        await refreshSessions();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    });
    $("new-goal").addEventListener("click", () => openGoalEditor());
    $("goal-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const button = event.submitter;
      try {
        setBusy(button, true);
        const scopeType = $("goal-scope-type").value;
        const scopeId = $("goal-scope-id").value;
        if (!scopeId) throw new Error("Choose where this goal belongs.");
        let result;
        if (state.selectedGoalId) {
          result = await api("/goals/" + encodeURIComponent(state.selectedGoalId) + "/updates", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: $("goal-title").value.trim(), description: $("goal-description").value.trim(), status: $("goal-status").value, note: $("goal-note").value.trim(), source: "console" })
          });
        } else {
          result = await api("/goals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: $("goal-title").value.trim(), description: $("goal-description").value.trim(), source: "console", ...(scopeType === "session" ? { sessionId: scopeId } : { projectId: scopeId }) })
          });
          state.selectedGoalId = result.id;
        }
        $("goal-dialog").close();
        showOutput(result);
        await refreshGoals();
        await refreshRuns();
      } catch (error) {
        showOutput(error.message);
      } finally {
        setBusy(button, false);
      }
    });
    $("refresh-sessions").addEventListener("click", () => refreshSessions().catch((error) => showOutput(error.message)));
    $("session-query").addEventListener("input", renderSessionTable);
    $("session-status-filter").addEventListener("change", renderSessionTable);
    $("session-project-filter").addEventListener("change", renderSessionTable);
    $("session-group").addEventListener("change", renderSessionTable);
    $("refresh-goals").addEventListener("click", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-query").addEventListener("input", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-status-filter").addEventListener("change", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-project-filter").addEventListener("change", () => refreshGoals().catch((error) => showOutput(error.message)));
    $("goal-scope-type").addEventListener("change", updateGoalScopeOptions);

    $("refresh-tasks").addEventListener("click", () => refreshTasks().catch((error) => showOutput(error.message)));
    let taskDebounce;
    const changeTaskFilters = () => {
      state.taskPage = 1;
      clearTimeout(taskDebounce);
      taskDebounce = setTimeout(() => refreshTasks().catch((error) => showOutput(error.message)), 180);
    };
    $("task-query").addEventListener("input", changeTaskFilters);
    ["task-status-filter", "task-category-filter", "task-system-toggle", "task-page-size"].forEach((id) => $(id).addEventListener("change", changeTaskFilters));
    $("task-prev").addEventListener("click", () => { state.taskPage = Math.max(1, state.taskPage - 1); refreshTasks().catch((error) => showOutput(error.message)); });
    $("task-next").addEventListener("click", () => { state.taskPage = Math.min(state.taskPagination.pages || 1, state.taskPage + 1); refreshTasks().catch((error) => showOutput(error.message)); });
    $("task-select-page").addEventListener("change", (event) => {
      for (const task of state.tasks || []) {
        if (event.target.checked) state.taskSelection.set(task.id, task);
        else state.taskSelection.delete(task.id);
      }
      renderTasks();
    });
    $("task-clear-selection").addEventListener("click", () => { state.taskSelection.clear(); renderTasks(); });
    $("task-rerun-selected").addEventListener("click", () => runSelectedTaskAction("replay").catch((error) => showOutput(error.message)));
    $("task-cancel-selected").addEventListener("click", () => runSelectedTaskAction("cancel").catch((error) => showOutput(error.message)));
    $("task-table").addEventListener("change", (event) => {
      const input = event.target.closest("[data-task-select]");
      if (!input) return;
      const task = (state.tasks || []).find((entry) => entry.id === input.dataset.taskSelect);
      if (input.checked && task) state.taskSelection.set(task.id, task);
      else state.taskSelection.delete(input.dataset.taskSelect);
      updateTaskManagement();
    });
    $("task-table").addEventListener("click", async (event) => {
      const inspect = event.target.closest("[data-task-inspect]");
      const replay = event.target.closest("[data-task-replay]");
      const cancel = event.target.closest("[data-task-cancel]");
      try {
        if (inspect) await inspectTask(inspect.dataset.taskInspect);
        if (replay) { const result = await replayTask(replay.dataset.taskReplay); if (result) showOutput(result); await refreshTasks(); }
        if (cancel) { const result = await cancelTask(cancel.dataset.taskCancel); if (result) showOutput(result); await refreshTasks(); }
      } catch (error) {
        showOutput(error.message);
      }
    });
    $("task-verify").addEventListener("click", async () => {
      if (!state.selectedTaskId) return;
      try {
        const result = await api("/runtime/runs/" + encodeURIComponent(state.selectedTaskId) + "/verify");
        $("task-summary").insertAdjacentHTML("beforeend", '<div class="item"><div class="muted">History check</div><strong>' + escapeHtml(result.valid === false ? "Needs attention" : "Passed") + '</strong></div>');
        showOutput(result.valid === false ? "The task history may have changed." : "The task history is intact.");
      } catch (error) { showOutput("Verification unavailable: " + error.message); }
    });
    $("task-replay").addEventListener("click", async () => {
      const result = await replayTask(state.selectedTaskId);
      if (result) showOutput(result);
      await refreshTasks();
    });
    $("task-cancel").addEventListener("click", async () => {
      const result = await cancelTask(state.selectedTaskId);
      if (result) showOutput(result);
      await refreshTasks();
    });

    $("new-cron").addEventListener("click", () => { updateSchedulePattern(); $("cron-dialog").showModal(); });
    $("refresh-cron").addEventListener("click", () => refreshCron().catch((error) => showOutput(error.message)));
    $("cron-query").addEventListener("input", () => refreshCron().catch((error) => showOutput(error.message)));
    ["cron-frequency", "cron-time", "cron-weekday"].forEach((id) => $(id).addEventListener("change", updateSchedulePattern));
    $("cron-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        updateSchedulePattern();
        await api("/cron", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("cron-name").value, schedule: $("cron-schedule").value, timezone: $("cron-timezone").value, tool: $("cron-tool").value, input: JSON.parse($("cron-input").value || "{}") }) });
        $("cron-dialog").close();
        await refreshCron();
      } catch (error) { showOutput(/JSON/i.test(error.message) ? "The advanced action input needs valid structured data." : error.message); }
    });
    $("cron-list").addEventListener("click", async (event) => {
      const run = event.target.closest("[data-cron-run]");
      const toggle = event.target.closest("[data-cron-toggle]");
      const remove = event.target.closest("[data-cron-delete]");
      try {
        if (run) {
          const job = (state.cronJobs || []).find((entry) => entry.id === run.dataset.cronRun);
          if (job && window.confirm('Run “' + job.name + '” now with its saved settings?')) {
            showOutput(await api("/cron/" + encodeURIComponent(run.dataset.cronRun) + "/run", { method: "POST" }));
          }
        }
        if (toggle) await api("/cron/" + encodeURIComponent(toggle.dataset.cronToggle), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: toggle.dataset.enabled !== "true" }) });
        if (remove) {
          const job = (state.cronJobs || []).find((entry) => entry.id === remove.dataset.cronDelete);
          if (job && window.confirm('Delete "' + job.name + '"? Its schedule and saved input will be removed. This cannot be undone from the console.')) {
            await api("/cron/" + encodeURIComponent(remove.dataset.cronDelete), { method: "DELETE" });
          }
        }
        await refreshCron();
      } catch (error) { showOutput(error.message); }
    });

    function manifestList(id) {
      return $(id).value.split(",").map((value) => value.trim()).filter(Boolean);
    }

    function readAgentManifestFields() {
      return {
        ...(state.agentManifestDraft || {}),
        sdkVersion: "0.3",
        id: $("agent-id").value.trim(),
        version: $("agent-version").value.trim(),
        name: $("agent-name").value.trim(),
        identity: { ...(state.agentManifestDraft?.identity || {}), name: $("agent-identity").value.trim() },
        instructions: manifestList("agent-instructions"),
        tools: manifestList("agent-tools"),
        plugins: manifestList("agent-plugins"),
        secrets: manifestList("agent-secrets"),
        sandbox: { ...(state.agentManifestDraft?.sandbox || {}), mode: $("agent-sandbox").value },
        network: { ...(state.agentManifestDraft?.network || {}), default: "deny", allow: manifestList("agent-network") },
        schedules: state.agentManifestDraft?.schedules || [],
        channels: state.agentManifestDraft?.channels || [],
        memory: state.agentManifestDraft?.memory || {},
        tests: state.agentManifestDraft?.tests || []
      };
    }

    function writeAgentManifestFields(manifest) {
      $("agent-id").value = manifest.id || "";
      $("agent-version").value = manifest.version || "1.0.0";
      $("agent-name").value = manifest.name || "";
      $("agent-identity").value = manifest.identity?.name || "";
      $("agent-instructions").value = (manifest.instructions || []).join(", ");
      $("agent-tools").value = (manifest.tools || []).join(", ");
      $("agent-plugins").value = (manifest.plugins || []).join(", ");
      $("agent-secrets").value = (manifest.secrets || []).join(", ");
      $("agent-sandbox").value = manifest.sandbox?.mode || "workspace-write";
      $("agent-network").value = (manifest.network?.allow || []).join(", ");
    }

    function setAgentAdvanced(enabled) {
      $("agent-manifest-error").textContent = "";
      if (enabled) {
        $("agent-manifest").value = JSON.stringify(readAgentManifestFields(), null, 2);
      } else if (!$("agent-manifest").hidden && $("agent-manifest").value.trim()) {
        state.agentManifestDraft = JSON.parse($("agent-manifest").value);
        writeAgentManifestFields(state.agentManifestDraft);
      }
      $("agent-advanced-toggle").checked = enabled;
      $("agent-manifest").hidden = !enabled;
      $("manifest-fields").hidden = enabled;
    }

    $("new-agent").addEventListener("click", () => {
      $("agent-form").reset();
      state.agentManifestDraft = null;
      $("agent-manifest").hidden = true;
      $("manifest-fields").hidden = false;
      $("agent-manifest-error").textContent = "";
      $("agent-manifest").value = JSON.stringify(readAgentManifestFields(), null, 2);
      $("agent-dialog").showModal();
    });
    $("agent-advanced-toggle").addEventListener("change", (event) => {
      try { setAgentAdvanced(event.target.checked); }
      catch (error) {
        event.target.checked = true;
        $("agent-manifest").hidden = false;
        $("manifest-fields").hidden = true;
        $("agent-manifest-error").textContent = "Fix the JSON before returning to the guided fields: " + error.message;
      }
    });
    $("refresh-agents").addEventListener("click", () => refreshAgents().catch((error) => showOutput(error.message)));
    $("agent-query").addEventListener("input", () => refreshAgents().catch((error) => showOutput(error.message)));
    $("agent-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        const manifest = $("agent-advanced-toggle").checked ? JSON.parse($("agent-manifest").value) : readAgentManifestFields();
        await api("/agents/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        const result = await api("/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        state.selectedAgentId = result.agent.id;
        $("agent-dialog").close();
        await refreshAgents();
        renderAgentDetail(result.agent);
      } catch (error) {
        $("agent-manifest-error").textContent = error.message;
        showOutput(error.message);
      }
    });
    $("agent-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-agent-id]");
      if (item) renderAgentDetail(state.agents.find((agent) => agent.id === item.dataset.agentId));
    });
    for (const [buttonId, action] of [["agent-enable", "enable"], ["agent-disable", "disable"], ["agent-quarantine", "quarantine"]]) {
      $(buttonId).addEventListener("click", async () => {
        if (!state.selectedAgentId) return;
        const agent = state.agents.find((entry) => entry.id === state.selectedAgentId);
        const effect = action === "enable"
          ? "This makes the agent available, but does not start any work."
          : action === "quarantine"
            ? "Its setup will be kept, but it cannot be used until you restore it."
            : "Its setup will be kept, but it cannot be selected.";
        if (!agent || !window.confirm(action[0].toUpperCase() + action.slice(1) + ' "' + agent.name + '"? ' + effect)) return;
        await api("/agents/" + encodeURIComponent(state.selectedAgentId) + "/lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
        await refreshAgents();
      });
    }

    $("refresh-skills").addEventListener("click", () => refreshSkills().catch((error) => showOutput(error.message)));
    $("skill-query").addEventListener("input", () => refreshSkills().catch((error) => showOutput(error.message)));
    $("skill-status-filter").addEventListener("change", () => refreshSkills().catch((error) => showOutput(error.message)));
    $("skills-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-skill-id]");
      if (item) renderSkillDetail(state.skills.find((skill) => skill.id === item.dataset.skillId));
    });
    $("new-skill").addEventListener("click", () => {
      $("skill-form").reset();
      $("skill-dialog").showModal();
    });
    $("skill-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const list = (id) => $(id).value.split(",").map((value) => value.trim()).filter(Boolean);
      const manifest = {
        sdkVersion: "0.1", id: $("skill-id").value.trim() || $("skill-name").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63), version: $("skill-version").value.trim(), name: $("skill-name").value.trim(),
        description: $("skill-description").value.trim(), instructions: $("skill-instructions").value.trim(),
        requestedTools: list("skill-tools"), requestedCapabilities: list("skill-capabilities"), requestedSecrets: list("skill-secrets"),
        network: { default: "deny", allow: list("skill-network") }, tests: []
      };
      try {
        await api("/skills/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        const result = await api("/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) });
        state.selectedSkillId = result.skill.id;
        $("skill-dialog").close();
        await refreshSkills();
        renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    for (const [buttonId, action] of [["skill-enable", "enable"], ["skill-disable", "disable"], ["skill-quarantine", "quarantine"]]) {
      $(buttonId).addEventListener("click", async () => {
        if (!state.selectedSkillId) return;
        const skill = state.skills.find((entry) => entry.id === state.selectedSkillId);
        const effect = action === "enable"
          ? "This makes the skill available to Ódinn."
          : action === "quarantine"
            ? "Its setup will be kept, but it cannot be turned on until you restore it."
            : "Its setup will be kept, but Ódinn cannot use it.";
        if (!skill || !window.confirm(action[0].toUpperCase() + action.slice(1) + ' "' + skill.name + '"? ' + effect)) return;
        await api("/skills/" + encodeURIComponent(state.selectedSkillId) + "/lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
        await refreshSkills();
        renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
      });
    }
    $("skill-verify").addEventListener("click", async () => {
      if (!state.selectedSkillId) return;
      const result = await api("/skills/" + encodeURIComponent(state.selectedSkillId) + "/verify");
      showOutput(result);
      await refreshSkills();
      renderSkillDetail(state.skills.find((skill) => skill.id === state.selectedSkillId));
    });

    $("new-project").addEventListener("click", () => {
      $("project-form").reset();
      $("project-dialog").showModal();
    });
    $("refresh-projects").addEventListener("click", () => refreshProjects().catch((error) => showOutput(error.message)));
    $("project-query").addEventListener("input", () => refreshProjects().catch((error) => showOutput(error.message)));
    $("project-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-project-id]");
      if (item) renderProjectDetail(state.projects.find((project) => project.id === item.dataset.projectId));
    });
    $("project-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        const result = await api("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("project-name").value.trim(), description: $("project-description").value.trim(), source: "console" }) });
        state.selectedProjectId = result.id;
        $("project-dialog").close();
        await refreshProjects();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("project-archive").addEventListener("click", async () => {
      const project = state.projects.find((entry) => entry.id === state.selectedProjectId);
      if (!project || state.selectedProjectId === "project_default" || !window.confirm('Archive "' + project.name + '"? Its sessions and goals will remain stored and viewable.')) return;
      const result = await api("/projects/" + encodeURIComponent(state.selectedProjectId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "archived", source: "console" }) });
      state.selectedProjectId = "project_default";
      await refreshProjects();
      showOutput(result);
    });
    $("project-open-sessions").addEventListener("click", () => {
      $("session-project-filter").value = state.selectedProjectId;
      renderSessionTable();
      switchView("sessions");
    });
    $("project-open-goals").addEventListener("click", () => {
      $("goal-project-filter").value = state.selectedProjectId;
      refreshGoals().catch((error) => showOutput(error.message));
      switchView("goals");
    });

    $("memory-query").addEventListener("input", renderMemoryLibrary);
    $("memory-kind-filter").addEventListener("change", renderMemoryLibrary);
    $("memory-scope-filter").addEventListener("change", renderMemoryLibrary);
    $("refresh-memory-tree").addEventListener("click", () => refreshMemory().catch((error) => showOutput(error.message)));
    document.querySelectorAll("[data-memory-tab]").forEach((button) => {
      button.addEventListener("click", () => setMemoryTab(button.dataset.memoryTab, true));
      button.addEventListener("keydown", (event) => {
        const tabs = [$("memory-tab-suggestions"), $("memory-tab-saved")];
        const current = tabs.indexOf(event.currentTarget);
        const next = event.key === "ArrowRight" ? (current + 1) % tabs.length
          : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
          : event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
          : -1;
        if (next < 0) return;
        event.preventDefault();
        const target = tabs[next];
        setMemoryTab(target.dataset.memoryTab, true);
        target.focus();
      });
    });
    $("memory-candidate-list").addEventListener("click", (event) => {
      const tabTarget = event.target.closest("[data-memory-tab-target]");
      if (tabTarget) {
        setMemoryTab(tabTarget.dataset.memoryTabTarget, true);
        return;
      }
      const keep = event.target.closest("[data-memory-candidate-keep]");
      if (keep) {
        decideMemoryCandidate(keep.dataset.memoryCandidateKeep, "accepted", keep).catch((error) => {
          setBusy(keep, false);
          showOutput(error.message);
        });
        return;
      }
      const dismiss = event.target.closest("[data-memory-candidate-dismiss]");
      if (dismiss) {
        decideMemoryCandidate(dismiss.dataset.memoryCandidateDismiss, "rejected", dismiss).catch((error) => {
          setBusy(dismiss, false);
          showOutput(error.message);
        });
      }
    });
    $("memory-new-toggle").addEventListener("click", () => {
      $("memory-form").reset();
      updateMemoryScopeOptions();
      $("memory-dialog").showModal();
    });
    $("memory-dialog-close").addEventListener("click", () => $("memory-dialog").close());
    $("memory-correction-dialog-close").addEventListener("click", () => $("memory-correction-dialog").close());
    $("memory-scope-type").addEventListener("change", updateMemoryScopeOptions);
    $("memory-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-memory-id]");
      if (item) {
        renderMemoryDetail(state.memories.find((memory) => memory.id === item.dataset.memoryId));
        if (matchMedia("(max-width: 600px)").matches) $("memory-detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    $("memory-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      const scopeType = $("memory-scope-type").value;
      const scopeId = $("memory-scope-id").value;
      try {
        const result = await api("/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          kind: $("memory-kind").value, subject: $("memory-subject").value.trim(), namespace: $("memory-namespace").value.trim(), tier: $("memory-tier").value,
          text: $("memory-text").value.trim(), tags: $("memory-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean), source: "console", authority: "user",
          scopeType, ...(scopeType === "global" ? {} : { scopeId }), ...(scopeType === "project" ? { projectId: scopeId } : {}), ...(scopeType === "session" ? { sessionId: scopeId } : {})
        }) });
        state.selectedMemoryId = result.id;
        setMemoryTab("saved", true);
        $("memory-dialog").close();
        await refreshMemory();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("memory-correct").addEventListener("click", () => {
      const memory = state.memories.find((entry) => entry.id === state.selectedMemoryId);
      if (!memory) return;
      $("memory-correction-form").reset();
      $("memory-correction-text").value = memory.text || "";
      $("memory-correction-dialog").showModal();
    });
    $("memory-correction-form").addEventListener("submit", async (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      try {
        const result = await api("/memory/corrections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: state.selectedMemoryId, text: $("memory-correction-text").value.trim(), reason: $("memory-correction-reason").value.trim(), source: "console", authority: "user-correction" }) });
        state.selectedMemoryId = result.id;
        setMemoryTab("saved");
        $("memory-correction-dialog").close();
        await refreshMemory();
        showOutput(result);
      } catch (error) { showOutput(error.message); }
    });
    $("memory-forget").addEventListener("click", async () => {
      const memory = state.memories.find((entry) => entry.id === state.selectedMemoryId);
      if (!memory || !window.confirm('Forget "' + (memory.subject || "this memory") + '"? Ódinn will stop using it.')) return;
      const result = await api("/memory/" + encodeURIComponent(memory.id) + "/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "console", authority: "user" }) });
      state.selectedMemoryId = "";
      await refreshMemory();
      showOutput(result.forgotten ? "Memory forgotten." : "Memory could not be forgotten.");
    });
    $("memory-recall-test").addEventListener("click", async () => {
      const query = window.prompt("What are you working on?", $("memory-query").value || "project decisions");
      if (!query?.trim()) return;
      const params = new URLSearchParams({ query: query.trim(), limit: "8" });
      if (state.selectedProjectId) params.set("projectId", state.selectedProjectId);
      if (state.activeChatId) params.set("sessionId", state.activeChatId);
      const result = await api("/memory/recall?" + params);
      const recalled = result.memories || [];
      $("memory-recall-result").hidden = false;
      $("memory-recall-result").innerHTML = recalled.length
        ? '<strong>Ódinn would use ' + recalled.length + (recalled.length === 1 ? " saved memory" : " saved memories") + ' for this topic.</strong><ul class="human-list">' + recalled.map((memory) => '<li><strong>' + escapeHtml(memory.subject || friendlyStatus(memory.kind)) + '</strong><span class="muted"> ' + escapeHtml(memory.summary || memory.text) + '</span></li>').join("") + '</ul>'
        : '<strong>No saved memories match this topic.</strong><p class="muted">Ódinn would continue without adding memory context.</p>';
      showOutput(recalled.length ? "Recall preview ready." : "No matching memories found.");
      const recalledIds = new Set(recalled.map((memory) => memory.id));
      document.querySelectorAll("[data-memory-id]").forEach((item) => item.classList.toggle("selected", recalledIds.has(item.dataset.memoryId)));
    });
    switchView(viewFromHash(), { updateHash: false });
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
