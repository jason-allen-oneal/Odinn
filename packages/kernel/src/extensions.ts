import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CapabilityBroker, Sentinel } from "./differentiated-runtime.mjs";
import { redact } from "./run-ledger.ts";
import type { JsonObject } from "@odinn/protocol";

const EXTENSION_SCHEMA_VERSION = 1;
const EXTENSION_TYPES = new Set(["tool", "skill", "mcp"]);
const SANDBOXES = new Set(["process", "container", "none"]);

type ExtensionType = "tool" | "skill" | "mcp";
type ExtensionSandbox = "process" | "container" | "none";
interface ExtensionManifest extends JsonObject {
  schemaVersion: number; installId: string; id: string; version: string; name: string;
  type: ExtensionType; entrypoint: string; capabilities: string[]; sandbox: ExtensionSandbox;
  source: string; provenance: string; digest: string; contentDigest: string;
  integrity: string; permissions: JsonObject; installedAt?: string; enabled?: boolean;
  trusted?: boolean; grants?: string[]; rollbackId?: string; enabledAt?: string;
  disabledAt?: string; disabledReason?: string; rolledBackAt?: string;
}
interface ExtensionState { schemaVersion: number; extensions: Record<string, ExtensionManifest>; history: Record<string, ExtensionManifest[]> }
interface InstallOptions { source?: string; provenance?: string }
interface EnableOptions { grants?: string[]; trust?: boolean; allowUnsafeSandbox?: boolean }
type StateMutation<T> = (state: ExtensionState) => T | Promise<T>;
type NodeError = Error & { code?: string };

interface ExtensionRuntime {
  runLedger: any;
  auditStore: { append(event: JsonObject): Promise<unknown> };
  runId?: string; featureFlags?: Record<string, boolean>; workspaceRoot?: string;
  actor?: string; policy?: any; capabilityToken?: string;
}
interface InvokeOptions { capability?: string; timeoutMs?: number; runtime?: ExtensionRuntime; capabilityToken?: string }
interface ExtensionRequest extends JsonObject {}
interface ProcessOptions { cwd: string; timeoutMs: number; protocol: "mcp-jsonl" | "odinn-jsonl" }
interface ProcessResponse extends JsonObject { result?: any; error?: { message?: string } }

export class ExtensionRegistry {
  readonly path: string;
  private writeChain: Promise<unknown>;

  constructor(path: string) {
    if (!path) throw new Error("ExtensionRegistry requires a path");
    this.path = path;
    this.writeChain = Promise.resolve();
  }

  async list() {
    const state = await this.readState();
    return Object.values(state.extensions).sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string) {
    const state = await this.readState();
    return state.extensions[id];
  }

  async install(input: unknown, { source = "local", provenance = "user-reviewed" }: InstallOptions = {}) {
    const manifest = normalizeManifest(input, { source, provenance });
    return this.mutate((state) => {
      const current = state.extensions[manifest.id];
      if (current) state.history[manifest.id] = [...(state.history[manifest.id] ?? []), current].slice(-10);
      state.extensions[manifest.id] = {
        ...manifest,
        installedAt: new Date().toISOString(),
        enabled: false,
        trusted: false,
        grants: [],
        rollbackId: current?.installId
      };
      return state.extensions[manifest.id];
    });
  }

  async enable(id: string, { grants = [], trust = false, allowUnsafeSandbox = false }: EnableOptions = {}) {
    return this.mutate((state) => {
      const extension = state.extensions[id];
      if (!extension) throw new Error(`extension not found: ${id}`);
      if (!extension.trusted && trust !== true) throw new Error(`extension is untrusted: ${id}; review provenance before enabling`);
      if (extension.sandbox === "none" && allowUnsafeSandbox !== true) throw new Error(`extension requests unsandboxed execution: ${id}`);
      const requested = new Set(extension.capabilities);
      const selected = [...new Set(grants)].filter((grant) => requested.has(grant));
      if (selected.length !== new Set(grants).size) throw new Error(`extension grant exceeds manifest capabilities: ${id}`);
      state.extensions[id] = { ...extension, enabled: true, trusted: true, grants: selected, enabledAt: new Date().toISOString() };
      return state.extensions[id];
    });
  }

  async disable(id: string, reason = "operator disabled") {
    return this.mutate((state) => {
      const extension = state.extensions[id];
      if (!extension) throw new Error(`extension not found: ${id}`);
      state.extensions[id] = { ...extension, enabled: false, disabledAt: new Date().toISOString(), disabledReason: reason };
      return state.extensions[id];
    });
  }

  async rollback(id: string) {
    return this.mutate((state) => {
      const history = state.history[id] ?? [];
      const previous = history.pop();
      if (!previous) throw new Error(`no rollback version available: ${id}`);
      state.history[id] = history;
      state.extensions[id] = { ...previous, enabled: false, trusted: false, grants: [], rolledBackAt: new Date().toISOString() };
      return state.extensions[id];
    });
  }

  async readState(): Promise<ExtensionState> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      if (state.schemaVersion !== EXTENSION_SCHEMA_VERSION || !state.extensions || !state.history) throw new Error("unsupported extension registry schema");
      return state;
    } catch (error) {
      if ((error as NodeError | undefined)?.code === "ENOENT") return { schemaVersion: EXTENSION_SCHEMA_VERSION, extensions: {}, history: {} };
      throw error;
    }
  }

  async mutate<T>(fn: StateMutation<T>): Promise<T> {
    const operation = this.writeChain.then(async () => {
      const state = await this.readState();
      const result = await fn(state);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = join(dirname(this.path), `.${this.path.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }
}

export class ExtensionExecutor {
  readonly registry: ExtensionRegistry;
  readonly workspaceRoot: string;
  readonly defaultTimeoutMs: number;

  constructor(registry: ExtensionRegistry, { workspaceRoot = process.cwd(), defaultTimeoutMs = 30_000 }: { workspaceRoot?: string; defaultTimeoutMs?: number } = {}) {
    if (!registry || typeof registry.get !== "function") throw new Error("ExtensionExecutor requires an ExtensionRegistry");
    this.registry = registry;
    this.workspaceRoot = resolve(workspaceRoot);
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async invoke(id: string, input: JsonObject = {}, { capability, timeoutMs = this.defaultTimeoutMs, runtime, capabilityToken }: InvokeOptions = {}) {
    const extension = await this.registry.get(id);
    if (!extension) throw new Error(`extension not found: ${id}`);
    if (!extension.enabled || !extension.trusted) throw new Error(`extension is not enabled and trusted: ${id}`);
    if (extension.sandbox !== "process") throw new Error(`extension sandbox is not executable by this adapter: ${extension.sandbox}`);
    const requested = String(capability || extension.capabilities[0] || "").trim();
    if (!requested || !(extension.grants ?? []).includes(requested)) throw new Error(`extension capability is not granted: ${requested || "unspecified"}`);
    if (!extension.entrypoint || extension.entrypoint.includes("\0")) throw new Error(`extension entrypoint is missing: ${id}`);
    const realRoot = await realpath(this.workspaceRoot);
    const lexicalEntrypoint = resolve(realRoot, extension.entrypoint);
    const entrypoint = await realpath(lexicalEntrypoint);
    const relativeEntrypoint = relative(realRoot, entrypoint);
    if (!relativeEntrypoint || relativeEntrypoint.startsWith("..") || relativeEntrypoint.includes(`..${sep}`) || !entrypoint.startsWith(`${realRoot}${sep}`)) {
      throw new Error("extension entrypoint must remain inside the configured workspace root");
    }
    const contentDigest = createHash("sha256").update(await readFile(entrypoint)).digest("hex");
    if (extension.contentDigest && extension.contentDigest !== contentDigest) throw new Error(`extension entrypoint integrity check failed: ${id}`);
    const protocol = extension.type === "mcp" ? "mcp-jsonl" : "odinn-jsonl";
    const request = protocol === "mcp-jsonl"
      ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: input.name || extension.id, arguments: input.arguments ?? input } }
      : { type: "odinn.call", id: `call_${randomUUID()}`, input, capability: requested };
    if (!runtime) throw new Error("extension execution requires the audited runtime boundary");
    return invokeThroughRuntime({ id, input, requested, extension, entrypoint, request, protocol, timeoutMs, runtime: { ...runtime, capabilityToken } });
  }
}

interface RuntimeInvocation { id: string; input: JsonObject; requested: string; extension: ExtensionManifest; entrypoint: string; request: ExtensionRequest; protocol: "mcp-jsonl" | "odinn-jsonl"; timeoutMs: number; runtime: ExtensionRuntime }
async function invokeThroughRuntime({ id, input, requested, extension, entrypoint, request, protocol, timeoutMs, runtime }: RuntimeInvocation) {
  const ledger = runtime.runLedger;
  const auditStore = runtime.auditStore;
  if (!ledger || !auditStore) throw new Error("extension runtime enforcement requires runLedger and auditStore");
  const runId = String(runtime.runId || `extension_${randomUUID()}`);
  const featureFlags = ledger.featureFlags ?? runtime.featureFlags ?? {};
  const safety = { toolName: "extension.invoke", effects: ["process", ...(extension.type === "mcp" ? ["network"] : [])], reversibility: "compensatable", requiresCapability: true, requiresApproval: false };
  ledger.ensureRun({ runId, objective: `extension:${id}`, workspaceRoot: runtime.workspaceRoot ?? ledger.workspaceRoot });
  const ledgerStep = ledger.beginTool({ runId, toolName: "extension.invoke", input: { extensionId: id, input }, safety, metadata: { extensionType: extension.type } });
  const safeInput = redact({ extensionId: id, input, capability: requested });
  const append = (event: JsonObject) => auditStore.append({ at: new Date().toISOString(), runId, actor: runtime.actor ?? "extension", tool: "extension.invoke", capability: extension.capabilities[0], ...event });
  try {
    if (featureFlags.sentinel === true) {
      if (runtime.policy?.version === 1 && Array.isArray(runtime.policy.invariants)) {
        const sentinelOptions = { ledger, featureFlags };
        new Sentinel(sentinelOptions).evaluate({ runId, stepId: ledgerStep.stepId, toolName: "extension.invoke", input: safeInput, policy: runtime.policy, workspaceRoot: runtime.workspaceRoot ?? ledger.workspaceRoot });
      } else {
        ledger.appendEvent({ runId, type: "policy-check", payload: { stepId: ledgerStep.stepId, decision: "allow", reason: "sentinel enabled with no configured invariants" } });
      }
    }
    let claims;
    if (featureFlags.capabilities === true) {
      const brokerOptions = { ledger, stateDir: ledger.stateDir, featureFlags };
      const consumeOptions = { runId, toolName: "extension.invoke", resource: { extensionId: id, capability: requested } };
      claims = new CapabilityBroker(brokerOptions).consume(runtime.capabilityToken, consumeOptions);
    }
    await append({ type: "task.started", decision: "allow", data: { input: safeInput, capabilityId: claims?.id } });
    const output = await runExtensionProcess(process.execPath, [entrypoint], request, { cwd: dirname(entrypoint), timeoutMs, protocol });
    await append({ type: "task.completed", decision: "allow", data: { output: redact(output) } });
    ledger.finishTool({ runId, stepId: ledgerStep.stepId, output, status: "succeeded" });
    return output;
  } catch (error) {
    const failure = (error instanceof Error ? error : new Error(String(error))) as NodeError;
    await append({ type: "task.failed", decision: "deny", message: failure.message, data: { code: failure.code ?? "EXTENSION_FAILED" } });
    ledger.finishTool({ runId, stepId: ledgerStep.stepId, status: "failed", error: failure.message });
    throw error;
  }
}

function runExtensionProcess(command: string, args: string[], request: ExtensionRequest, { cwd, timeoutMs, protocol }: ProcessOptions): Promise<unknown> {
  return new Promise<unknown>((resolveResult, rejectResult) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"], shell: false });
    let settled = false;
    let buffer = "";
    const finish = (error?: Error, result?: ProcessResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.removeAllListeners();
      if (!child.killed) child.kill();
      if (error) rejectResult(error);
      else resolveResult(protocol === "mcp-jsonl" && result?.result?.content ? result.result : result?.result ?? result);
    };
    const timer = setTimeout(() => finish(new Error("extension execution timed out")), timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled) finish(new Error(`extension process exited before returning a result: ${code ?? "unknown"}`));
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line) as ProcessResponse;
          if (response.error) finish(new Error(response.error.message || "extension returned an error"));
          else finish(undefined, response);
        } catch {
          finish(new Error("extension returned invalid JSON"));
        }
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function normalizeManifest(input: unknown, { source, provenance }: Required<InstallOptions>): ExtensionManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("extension manifest must be an object");
  const value = input as JsonObject;
  const id = String(value.id ?? "").trim();
  const version = String(value.version ?? "").trim();
  const type = String(value.type ?? "").trim() as ExtensionType;
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error("extension id must be lowercase and 2-64 characters");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid extension version: ${version}`);
  if (!EXTENSION_TYPES.has(type)) throw new Error(`extension type must be one of: ${Array.from(EXTENSION_TYPES).join(", ")}`);
  const capabilities = Array.isArray(value.capabilities) ? [...new Set(value.capabilities.map(String).filter(Boolean))] : [];
  const sandbox = String(value.sandbox ?? "process") as ExtensionSandbox;
  if (!SANDBOXES.has(sandbox)) throw new Error(`extension sandbox must be one of: ${Array.from(SANDBOXES).join(", ")}`);
  const normalized = {
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    installId: `install_${randomUUID()}`,
    id,
    version,
    name: String(value.name ?? id).trim().slice(0, 120),
    type,
    entrypoint: String(value.entrypoint ?? "").trim(),
    capabilities,
    sandbox,
    source: String(value.source ?? source).trim().slice(0, 500),
    provenance: String(value.provenance ?? provenance).trim().slice(0, 120),
    digest: String(value.digest ?? createHash("sha256").update(JSON.stringify({ id, version, type, capabilities, sandbox, entrypoint: value.entrypoint ?? "" })).digest("hex")).trim(),
    contentDigest: String(value.contentDigest ?? "").trim(),
    integrity: value.contentDigest ? "content-verified" : "metadata-only",
    permissions: value.permissions && typeof value.permissions === "object" && !Array.isArray(value.permissions) ? value.permissions as JsonObject : {}
  };
  return normalized;
}
