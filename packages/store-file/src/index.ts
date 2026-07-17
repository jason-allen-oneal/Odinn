import { createHmac, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile, copyFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeAuditEvent, type AuditEvent, type JsonObject } from "@odinn/protocol";

export const STORE_SCHEMA_VERSION = 1;

type Integrity = { keyId: string; previous: string | null; signature: string };
type Keyring = { schemaVersion: number; current: string; keys: Record<string, string> };
type StoredRecord = JsonObject & { schemaVersion: number; at?: string; type?: string };
type Job = JsonObject & { id: string; status: string; payload: JsonObject; createdAt: string; updatedAt: string; attempts: number; timeoutMs: number; retrySafe: boolean };
type JobState = { schemaVersion: number; jobs: Record<string, Job> };
type MutableResult<T> = T | Promise<T>;
type NodeError = Error & { code?: string };
const errorCode = (error: unknown) => (error as NodeError | undefined)?.code;

async function withInterprocessLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await ensureSecureStateDirectory(dirname(lockPath));
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 120_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (errorCode(statError) !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring store lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await operation(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}

export async function ensureSecureStateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function secureStoreFile(path: string) {
  await ensureSecureStateDirectory(dirname(path));
  try { await chmod(path, 0o600); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
}

export class StoreCorruptionError extends Error {
  readonly path: string;
  readonly line: number;
  override readonly cause: Error;

  constructor(path: string, line: number, cause: Error) {
    super(`store is corrupted at ${path}:${line}: ${cause.message}`);
    this.name = "StoreCorruptionError";
    this.path = path;
    this.line = line;
    this.cause = cause;
  }
}

export class FileAuditStore {
  readonly path: string;
  readonly keyringPath: string;
  readonly lockPath: string;
  private writeChain: Promise<unknown>;

  constructor(path: string) {
    if (!path) throw new Error("FileAuditStore requires a path");
    this.path = path;
    this.keyringPath = `${path}.keys.json`;
    this.lockPath = `${path}.lock`;
    this.writeChain = Promise.resolve();
  }

  async append(event: unknown): Promise<AuditEvent> {
    const operation = this.writeChain.then(() => withInterprocessLock(this.lockPath, async () => {
      const normalized = normalizeAuditEvent(event);
      const keyring = await this.readKeyringUnlocked();
      const previous = await this.lastIntegrity();
      const unsigned = { ...normalized, data: { ...(normalized.data ?? {}) } };
      delete unsigned.data.__odinnIntegrity;
      const signature = createHmac("sha256", Buffer.from(keyring.keys[keyring.current]!, "base64")).update(JSON.stringify({ event: unsigned, previous })).digest("base64url");
      const signed = { ...normalized, data: { ...(normalized.data ?? {}), __odinnIntegrity: { keyId: keyring.current, previous, signature } } };
      await ensureSecureStateDirectory(dirname(this.path));
      await writeFile(this.path, `${JSON.stringify(signed)}\n`, { flag: "a" });
      await secureStoreFile(this.path);
      return signed;
    }));
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async readAll(): Promise<AuditEvent[]> {
    let content = "";
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return parseJsonLines(this.path, content).map(normalizeAuditEvent);
  }

  async backup(destination = `${this.path}.bak`): Promise<string> {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(this.path, destination);
    await chmod(destination, 0o600);
    return destination;
  }

  async recover() {
    return recoverJsonLines(this.path, normalizeAuditEvent);
  }

  async rotateKey() {
    const operation = this.writeChain.then(() => withInterprocessLock(this.lockPath, async () => {
      const keyring = await this.readKeyringUnlocked();
      const keyId = `key_${randomUUID()}`;
      keyring.keys[keyId] = Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64");
      keyring.current = keyId;
      await ensureSecureStateDirectory(dirname(this.keyringPath));
      await writeFile(this.keyringPath, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600 });
      await chmod(this.keyringPath, 0o600);
      return { keyId, retiredKeyIds: Object.keys(keyring.keys).filter((id) => id !== keyId) };
    }));
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async verifyIntegrity({ allowUnsigned = true } = {}) {
    const events = await this.readAll();
    const keyring = await this.readKeyring();
    let previous = null;
    const failures = [];
    let unsigned = 0;
    for (const event of events) {
      const integrity = event.data?.__odinnIntegrity as Integrity | undefined;
      if (!integrity) { unsigned += 1; if (!allowUnsigned) failures.push({ runId: event.runId, reason: "unsigned event" }); previous = null; continue; }
      const secret = keyring.keys[integrity.keyId];
      const unsignedEvent = { ...event, data: { ...(event.data ?? {}) } };
      delete unsignedEvent.data.__odinnIntegrity;
      const expected = secret && createHmac("sha256", Buffer.from(secret, "base64")).update(JSON.stringify({ event: unsignedEvent, previous: integrity.previous })).digest("base64url");
      if (!secret || integrity.previous !== previous || expected !== integrity.signature) failures.push({ runId: event.runId, reason: "audit integrity mismatch" });
      previous = integrity.signature;
    }
    return { valid: failures.length === 0, events: events.length, unsigned, failures, currentKeyId: keyring.current, retiredKeyIds: Object.keys(keyring.keys).filter((id) => id !== keyring.current) };
  }

  async readKeyring(): Promise<Keyring> {
    return withInterprocessLock(this.lockPath, () => this.readKeyringUnlocked());
  }

  private async readKeyringUnlocked(): Promise<Keyring> {
    try {
      const parsed = JSON.parse(await readFile(this.keyringPath, "utf8"));
      if (!parsed.current || !parsed.keys?.[parsed.current]) throw new Error("invalid audit keyring");
      return parsed;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const keyId = `key_${randomUUID()}`;
      const keyring = { schemaVersion: 1, current: keyId, keys: { [keyId]: Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64") } };
      await ensureSecureStateDirectory(dirname(this.keyringPath));
      await writeFile(this.keyringPath, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600 });
      await chmod(this.keyringPath, 0o600);
      return keyring;
    }
  }

  async lastIntegrity(): Promise<string | null> {
    const events = await this.readAll();
    return (events.reverse().find((event) => event.data?.__odinnIntegrity)?.data?.__odinnIntegrity as Integrity | undefined)?.signature ?? null;
  }

  async readRuns() {
    const runs = new Map<string, JsonObject & { id: string; lastEventAt: string; eventCount: number; status: string }>();
    for (const event of await this.readAll()) {
      const current = runs.get(event.runId) ?? {
        id: event.runId,
        actor: event.actor,
        tool: event.tool,
        capability: event.capability,
        status: "unknown",
        startedAt: undefined,
        completedAt: undefined,
        lastEventAt: event.at,
        message: undefined,
        eventCount: 0
      };
      current.actor = event.actor ?? current.actor;
      current.tool = event.tool ?? current.tool;
      current.capability = event.capability ?? current.capability;
      current.lastEventAt = event.at;
      current.eventCount += 1;

      if (event.type === "task.policy" && event.decision === "deny") {
        current.status = "denied";
        current.message = event.message;
      } else if (event.type === "plan.started") {
        current.status = "running";
        current.startedAt = event.at;
        current.message = event.data?.name;
      } else if (event.type === "plan.completed") {
        current.status = "completed";
        current.completedAt = event.at;
      } else if (event.type === "plan.failed") {
        current.status = "failed";
        current.completedAt = event.at;
        current.message = event.message;
      } else if (event.type === "task.started") {
        current.status = "running";
        current.startedAt = event.at;
      } else if (event.type === "task.completed") {
        current.status = "completed";
        current.completedAt = event.at;
      } else if (event.type === "task.approval_required") {
        current.status = "awaiting_approval";
        current.message = event.message;
      } else if (event.type === "task.blocked") {
        current.status = "blocked";
        current.completedAt = event.at;
        current.message = event.message;
      } else if (event.type === "task.cancelled") {
        current.status = "cancelled";
        current.completedAt = event.at;
        current.message = event.message;
      } else if (event.type === "task.failed") {
        current.status = "failed";
        current.completedAt = event.at;
        current.message = event.message;
      }
      runs.set(event.runId, current);
    }
    return Array.from(runs.values()).sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
  }

  async readRun(id: string) {
    if (!id) throw new Error("readRun requires id");
    const events = (await this.readAll()).filter((event) => event.runId === id);
    const summary = (await this.readRuns()).find((run) => run.id === id);
    return summary ? { ...summary, events } : undefined;
  }
}

export class FileRecordStore {
  readonly path: string;
  readonly lockPath: string;
  private writeChain: Promise<unknown>;

  constructor(path: string) {
    if (!path) throw new Error("FileRecordStore requires a path");
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.writeChain = Promise.resolve();
  }

  async append(record: JsonObject): Promise<StoredRecord> {
    const normalized = {
      schemaVersion: 1,
      at: typeof record.at === "string" ? record.at : new Date().toISOString(),
      ...record
    };
    const operation = this.writeChain.then(() => withInterprocessLock(this.lockPath, async () => {
      await ensureSecureStateDirectory(dirname(this.path));
      await writeFile(this.path, `${JSON.stringify(normalized)}\n`, { flag: "a" });
      await secureStoreFile(this.path);
      return normalized;
    }));
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async readAll(): Promise<StoredRecord[]> {
    let content = "";
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return parseJsonLines(this.path, content).map(migrateRecord);
  }

  async backup(destination = `${this.path}.bak`) {
    await ensureSecureStateDirectory(dirname(destination));
    await copyFile(this.path, destination);
    await chmod(destination, 0o600);
    return destination;
  }

  async recover() {
    return recoverJsonLines(this.path, migrateRecord);
  }

  async list({ type, limit = 50 }: { type?: string; limit?: number } = {}) {
    const records = await this.readAll();
    const filtered = type ? records.filter((record) => record.type === type) : records;
    const count = Number.isFinite(limit) && limit > 0 ? limit : 50;
    return filtered.slice(-count).reverse();
  }

  async search({ type, query = "", limit = 20 }: { type?: string; query?: string; limit?: number } = {}) {
    const needle = String(query).trim().toLowerCase();
    const records = type ? (await this.readAll()).filter((record) => record.type === type) : await this.readAll();
    const filtered = needle
      ? records.filter((record) => JSON.stringify(record).toLowerCase().includes(needle))
      : records;
    const count = Number.isFinite(limit) && limit > 0 ? limit : 20;
    return filtered.slice(-count).reverse();
  }
}

export class FileJobStore {
  readonly path: string;
  private writeChain: Promise<unknown>;

  constructor(path: string) {
    if (!path) throw new Error("FileJobStore requires a path");
    this.path = path;
    this.writeChain = Promise.resolve();
  }

  async list() {
    const state = await this.readState();
    return Object.values(state.jobs).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string) {
    const state = await this.readState();
    return state.jobs[id];
  }

  async create(job: JsonObject & { id: string }) {
    return this.mutate((state) => {
      if (state.jobs[job.id]) throw new Error(`job already exists: ${job.id}`);
      state.jobs[job.id] = normalizeJob(job);
      return state.jobs[job.id];
    });
  }

  async update(id: string, patch: JsonObject) {
    return this.mutate((state) => {
      const current = state.jobs[id];
      if (!current) throw new Error(`job not found: ${id}`);
      state.jobs[id] = normalizeJob({ ...current, ...patch, id, updatedAt: new Date().toISOString() });
      return state.jobs[id];
    });
  }

  async recover({ maxAttempts = 3 } = {}) {
    return this.mutate((state) => {
      for (const job of Object.values(state.jobs)) {
        if (job.status !== "running") continue;
        const attempts = Number(job.attempts ?? 0) + 1;
        const canRetry = job.retrySafe === true && attempts < maxAttempts;
        state.jobs[job.id] = normalizeJob({
          ...job,
          attempts,
          status: canRetry ? "queued" : job.retrySafe === true ? "failed" : "needs-review",
          error: canRetry ? undefined : "worker crashed or gateway stopped during execution; outcome requires operator review",
          recoveredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      return Object.values(state.jobs);
    });
  }

  async backup(destination = `${this.path}.bak`) {
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(this.path, destination);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await writeFile(destination, `${JSON.stringify(emptyJobState(), null, 2)}\n`, { mode: 0o600 });
    }
    return destination;
  }

  async recoverCorruption() {
    const backup = `${this.path}.corrupt-${Date.now()}`;
    try {
      await rename(this.path, backup);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { recovered: false, reason: "missing" };
      throw error;
    }
    await ensureSecureStateDirectory(dirname(this.path));
    await writeFile(this.path, `${JSON.stringify(emptyJobState(), null, 2)}\n`, { mode: 0o600 });
    return { recovered: true, backup, jobs: [] };
  }

  async readState(): Promise<JobState> {
    let content;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return emptyJobState();
      throw error;
    }
    try {
      const state = JSON.parse(content);
      if (state.schemaVersion !== STORE_SCHEMA_VERSION || !state.jobs || typeof state.jobs !== "object") {
        throw new Error(`unsupported job store schema version: ${String(state.schemaVersion)}`);
      }
      await secureStoreFile(this.path);
      return state as JobState;
    } catch (error) {
      throw new StoreCorruptionError(this.path, 1, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async mutate<T>(fn: (state: JobState) => MutableResult<T>): Promise<T> {
    const operation = this.writeChain.then(async () => {
      const state = await this.readState();
      const result = await fn(state);
      await ensureSecureStateDirectory(dirname(this.path));
      const temporary = join(dirname(this.path), `.${this.path.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      await secureStoreFile(this.path);
      return result;
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }
}

function emptyJobState(): JobState {
  return { schemaVersion: STORE_SCHEMA_VERSION, jobs: {} };
}

function normalizeJob(job: JsonObject): Job {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    id: String(job.id),
    status: String(job.status ?? "queued"),
    payload: job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload as JsonObject : {},
    requestHash: job.requestHash,
    retrySafe: job.retrySafe === true,
    createdAt: typeof job.createdAt === "string" ? job.createdAt : new Date().toISOString(),
    updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : new Date().toISOString(),
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attempts: Number(job.attempts ?? 0),
    timeoutMs: Number(job.timeoutMs ?? 120_000),
    result: job.result,
    error: job.error,
    recoveredAt: job.recoveredAt
  };
}

function migrateRecord(record: unknown): StoredRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("record must be an object");
  }
  const value = record as JsonObject;
  const schemaVersion = Number(value.schemaVersion ?? 1);
  if (schemaVersion > STORE_SCHEMA_VERSION) throw new Error(`unsupported record schema version: ${schemaVersion}`);
  return { schemaVersion: STORE_SCHEMA_VERSION, ...value };
}

function parseJsonLines(path: string, content: string): unknown[] {
  const records: unknown[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new StoreCorruptionError(path, index + 1, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return records;
}

async function recoverJsonLines(path: string, normalize: (value: unknown) => unknown) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { recovered: false, reason: "missing" };
    throw error;
  }
  const valid = [];
  let discarded = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      valid.push(JSON.stringify(normalize(JSON.parse(line))));
    } catch {
      discarded += 1;
    }
  }
  const backup = `${path}.corrupt-${Date.now()}`;
  await rename(path, backup);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, valid.length ? `${valid.join("\n")}\n` : "", { mode: 0o600 });
  return { recovered: true, backup, retained: valid.length, discarded };
}
