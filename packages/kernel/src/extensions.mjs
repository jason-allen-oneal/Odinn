import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXTENSION_SCHEMA_VERSION = 1;
const EXTENSION_TYPES = new Set(["tool", "skill", "mcp"]);
const SANDBOXES = new Set(["process", "container", "none"]);

export class ExtensionRegistry {
  constructor(path) {
    if (!path) throw new Error("ExtensionRegistry requires a path");
    this.path = path;
    this.writeChain = Promise.resolve();
  }

  async list() {
    const state = await this.readState();
    return Object.values(state.extensions).sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id) {
    const state = await this.readState();
    return state.extensions[id];
  }

  async install(input, { source = "local", provenance = "user-reviewed" } = {}) {
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

  async enable(id, { grants = [], trust = false, allowUnsafeSandbox = false } = {}) {
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

  async disable(id, reason = "operator disabled") {
    return this.mutate((state) => {
      const extension = state.extensions[id];
      if (!extension) throw new Error(`extension not found: ${id}`);
      state.extensions[id] = { ...extension, enabled: false, disabledAt: new Date().toISOString(), disabledReason: reason };
      return state.extensions[id];
    });
  }

  async rollback(id) {
    return this.mutate((state) => {
      const history = state.history[id] ?? [];
      const previous = history.pop();
      if (!previous) throw new Error(`no rollback version available: ${id}`);
      state.history[id] = history;
      state.extensions[id] = { ...previous, enabled: false, trusted: false, grants: [], rolledBackAt: new Date().toISOString() };
      return state.extensions[id];
    });
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      if (state.schemaVersion !== EXTENSION_SCHEMA_VERSION || !state.extensions || !state.history) throw new Error("unsupported extension registry schema");
      return state;
    } catch (error) {
      if (error?.code === "ENOENT") return { schemaVersion: EXTENSION_SCHEMA_VERSION, extensions: {}, history: {} };
      throw error;
    }
  }

  async mutate(fn) {
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

function normalizeManifest(input, { source, provenance }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("extension manifest must be an object");
  const id = String(input.id ?? "").trim();
  const version = String(input.version ?? "").trim();
  const type = String(input.type ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error("extension id must be lowercase and 2-64 characters");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid extension version: ${version}`);
  if (!EXTENSION_TYPES.has(type)) throw new Error(`extension type must be one of: ${Array.from(EXTENSION_TYPES).join(", ")}`);
  const capabilities = Array.isArray(input.capabilities) ? [...new Set(input.capabilities.map(String).filter(Boolean))] : [];
  const sandbox = String(input.sandbox ?? (type === "mcp" ? "process" : "process"));
  if (!SANDBOXES.has(sandbox)) throw new Error(`extension sandbox must be one of: ${Array.from(SANDBOXES).join(", ")}`);
  const normalized = {
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    installId: `install_${randomUUID()}`,
    id,
    version,
    name: String(input.name ?? id).trim().slice(0, 120),
    type,
    entrypoint: String(input.entrypoint ?? "").trim(),
    capabilities,
    sandbox,
    source: String(input.source ?? source).trim().slice(0, 500),
    provenance: String(input.provenance ?? provenance).trim().slice(0, 120),
    digest: String(input.digest ?? createHash("sha256").update(JSON.stringify({ id, version, type, capabilities, sandbox, entrypoint: input.entrypoint ?? "" })).digest("hex")).trim(),
    permissions: input.permissions && typeof input.permissions === "object" ? input.permissions : {}
  };
  return normalized;
}
