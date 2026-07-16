import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@odinn/protocol";

export interface JobRecord {
  id: string;
  status: string;
  payload: JsonObject;
  attempts: number;
  timeoutMs: number;
  requestHash?: string;
  result?: unknown;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JobStore {
  create(job: JsonObject & { id: string }): Promise<JobRecord>;
  update(id: string, patch: JsonObject): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  recover(options: { maxAttempts: number }): Promise<unknown>;
}

export interface JobExecutionContext {
  signal: AbortSignal;
  job: JobRecord;
}

export type JobExecute = (payload: JsonObject, context: JobExecutionContext) => Promise<unknown>;

export interface JobSupervisorOptions {
  store: JobStore;
  execute: JobExecute;
  concurrency?: number;
  maxAttempts?: number;
  defaultTimeoutMs?: number;
}

interface ActiveJob {
  controller: AbortController;
  promise: Promise<void>;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class JobSupervisor {
  readonly store: JobStore;
  readonly execute: JobExecute;
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly defaultTimeoutMs: number;
  private readonly active: Map<string, ActiveJob>;
  private started: boolean;
  private draining: boolean;
  private stopping: boolean;

  constructor(options: Partial<JobSupervisorOptions> = {}) {
    const { store, execute, concurrency = 1, maxAttempts = 3, defaultTimeoutMs = 120_000 } = options;
    if (!store || typeof store.create !== "function") throw new Error("JobSupervisor requires a durable store");
    if (typeof execute !== "function") throw new Error("JobSupervisor requires an execute function");
    this.store = store;
    this.execute = execute;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 1);
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.active = new Map();
    this.started = false;
    this.draining = false;
    this.stopping = false;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    await this.store.recover({ maxAttempts: this.maxAttempts });
    this.started = true;
    await this.drain();
  }

  async submit(
    payload: JsonObject,
    { id = `job_${randomUUID()}`, timeoutMs = this.defaultTimeoutMs, requestHash }: { id?: string; timeoutMs?: number; requestHash?: string } = {}
  ): Promise<JobRecord> {
    const job = await this.store.create({ id, payload, requestHash, status: "queued", timeoutMs });
    await this.drain();
    return job;
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    const running = this.active.get(id);
    if (running) {
      running.controller.abort(new Error("job cancelled by user"));
      return this.store.update(id, { status: "cancelling" });
    }
    const cancelled = await this.store.update(id, { status: "cancelled", completedAt: new Date().toISOString() });
    await this.drain();
    return cancelled;
  }

  async get(id: string): Promise<JobRecord | undefined> { return this.store.get(id); }
  async list(): Promise<JobRecord[]> { return this.store.list(); }

  async drain(): Promise<void> {
    if (!this.started || this.stopping || this.draining) return;
    this.draining = true;
    try {
      while (this.active.size < this.concurrency) {
        const queued = (await this.store.list()).find((job) => job.status === "queued");
        if (!queued) break;
        void this.run(queued).catch(() => undefined);
      }
    } finally {
      this.draining = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.started = false;
    for (const active of this.active.values()) active.controller.abort(new Error("supervisor shutting down"));
    await Promise.allSettled(Array.from(this.active.values(), (active) => active.promise));
  }

  private run(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("job timed out")), job.timeoutMs || this.defaultTimeoutMs);
    const promise = (async () => {
      await this.store.update(job.id, { status: "running", startedAt: new Date().toISOString(), attempts: job.attempts + 1 });
      try {
        const result = await this.execute(job.payload, { signal: controller.signal, job });
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("job aborted");
        await this.store.update(job.id, { status: "completed", completedAt: new Date().toISOString(), result });
      } catch (error) {
        const current = await this.store.get(job.id);
        const reason = controller.signal.reason;
        const cancelled = controller.signal.aborted && reason instanceof Error && reason.message.includes("cancel");
        const message = errorMessage(error);
        await this.store.update(job.id, {
          status: cancelled ? "cancelled" : "failed",
          completedAt: new Date().toISOString(),
          error: message
        });
        if (!this.stopping && !cancelled && current && current.attempts < this.maxAttempts) {
          await this.store.update(job.id, { status: "queued", completedAt: undefined, error: message });
        }
      } finally {
        clearTimeout(timeout);
        this.active.delete(job.id);
        if (!this.stopping) await this.drain();
      }
    })();
    this.active.set(job.id, { controller, promise });
    return promise;
  }
}

interface WorkerPayload extends JsonObject {
  workspaceRoot?: string;
  task?: JsonObject & { tool?: string };
}

interface ExecutorOptions { signal?: AbortSignal }
type TaskExecutor = ((payload: WorkerPayload, options?: ExecutorOptions) => Promise<unknown>) & { shutdown(): Promise<void> };

interface WorkerConfiguration {
  stateDir?: string;
  workspaceRoot?: string;
  config?: unknown;
  policy?: unknown;
}

interface WorkerResponse {
  id?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  finish(error?: Error, result?: unknown): void;
}

function isWorkerResponse(message: unknown): message is WorkerResponse {
  return Boolean(message && typeof message === "object" && "ok" in message && typeof (message as { ok?: unknown }).ok === "boolean");
}

export function createIsolatedTaskExecutor(options: WorkerConfiguration = {}): TaskExecutor {
  const { stateDir, workspaceRoot, config, policy } = options;
  const workerPath = fileURLToPath(new URL("./task-worker.ts", import.meta.url));
  const browserWorkerPath = fileURLToPath(new URL("./browser-worker.ts", import.meta.url));
  const browserExecutor = createPersistentWorkerExecutor({ workerPath: browserWorkerPath, stateDir, workspaceRoot, config, policy });
  const children = new Set<ChildProcess>();
  const execute = ((payload: WorkerPayload, { signal }: ExecutorOptions = {}) => {
    const taskWorkspaceRoot = payload.workspaceRoot || workspaceRoot;
    if (String(payload.task?.tool || "").startsWith("browser.")) {
      return browserExecutor({ ...payload, workspaceRoot: taskWorkspaceRoot }, { signal });
    }
    return new Promise<unknown>((resolve, reject) => {
      const child = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.add(child);
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        children.delete(child);
        signal?.removeEventListener("abort", abort);
        child.removeAllListeners();
        if (child.connected) child.disconnect();
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => {
        child.kill();
        finish(signal?.reason instanceof Error ? signal.reason : new Error("isolated task aborted"));
      };
      child.on("message", (message) => {
        if (!isWorkerResponse(message)) return finish(new Error("isolated task returned an invalid response"));
        if (message.ok) finish(undefined, message.result);
        else finish(new Error(message.error || "isolated task failed"));
      });
      child.on("error", (error) => finish(error));
      child.on("exit", (code, exitSignal) => {
        if (!settled) finish(new Error(`forked task worker exited unexpectedly: ${code ?? exitSignal}`));
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.send({ payload, stateDir, workspaceRoot: taskWorkspaceRoot, config, policy });
    });
  }) as TaskExecutor;
  execute.shutdown = async () => {
    await browserExecutor.shutdown();
    for (const child of children) child.kill();
    children.clear();
  };
  return execute;
}

function createPersistentWorkerExecutor(options: WorkerConfiguration & { workerPath: string }): TaskExecutor {
  const { workerPath, stateDir, workspaceRoot, config, policy } = options;
  let child: ChildProcess | undefined;
  let sequence = 0;
  let shuttingDown = false;
  const pending = new Map<string, PendingRequest>();

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.finish(error);
    pending.clear();
  };

  const ensureChild = (): ChildProcess => {
    if (child?.connected) return child;
    const currentChild = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child = currentChild;
    currentChild.on("message", (message) => {
      if (!isWorkerResponse(message) || typeof message.id !== "string") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.finish(undefined, message.result);
      else request.finish(new Error(message.error || "persistent worker failed"));
    });
    currentChild.on("error", (error) => rejectPending(error));
    currentChild.on("exit", (code, exitSignal) => {
      if (currentChild.connected) currentChild.disconnect();
      if (child === currentChild) child = undefined;
      if (!shuttingDown) rejectPending(new Error(`persistent worker exited unexpectedly: ${code ?? exitSignal}`));
    });
    return currentChild;
  };

  const execute = ((payload: WorkerPayload, { signal }: ExecutorOptions = {}) => new Promise<unknown>((resolve, reject) => {
    if (shuttingDown) return reject(new Error("persistent worker is shutting down"));
    const id = `request_${++sequence}`;
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error("persistent task aborted");
      rejectPending(error);
      child?.kill();
      finish(error);
    };
    pending.set(id, { finish });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      ensureChild().send({ type: "task", id, payload, stateDir, workspaceRoot, config, policy }, (error) => {
        if (error) {
          pending.delete(id);
          finish(error);
        }
      });
    } catch (error) {
      pending.delete(id);
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  })) as TaskExecutor;

  execute.shutdown = async () => {
    shuttingDown = true;
    if (!child) return;
    const current = child;
    rejectPending(new Error("persistent worker shutting down"));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { current.kill(); resolve(); }, 5_000);
      current.once("exit", () => { clearTimeout(timer); resolve(); });
      if (current.connected) current.send({ type: "shutdown" });
      else current.kill();
    });
    child = undefined;
  };
  return execute;
}
