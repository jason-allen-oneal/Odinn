import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export class JobSupervisor {
  constructor({ store, execute, concurrency = 1, maxAttempts = 3, defaultTimeoutMs = 120_000 } = {}) {
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
  }

  async start() {
    if (this.started) return;
    await this.store.recover({ maxAttempts: this.maxAttempts });
    this.started = true;
    await this.drain();
  }

  async submit(payload, { id = `job_${randomUUID()}`, timeoutMs = this.defaultTimeoutMs } = {}) {
    const job = await this.store.create({ id, payload, status: "queued", timeoutMs });
    await this.drain();
    return job;
  }

  async cancel(id) {
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

  async get(id) { return this.store.get(id); }
  async list() { return this.store.list(); }

  async drain() {
    if (!this.started || this.draining) return;
    this.draining = true;
    try {
      while (this.active.size < this.concurrency) {
        const queued = (await this.store.list()).find((job) => job.status === "queued");
        if (!queued) break;
        this.run(queued).catch(() => undefined);
      }
    } finally {
      this.draining = false;
    }
  }

  async shutdown() {
    for (const active of this.active.values()) active.controller.abort(new Error("supervisor shutting down"));
    await Promise.allSettled(Array.from(this.active.values(), (active) => active.promise));
    this.started = false;
  }

  async run(job) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("job timed out")), job.timeoutMs || this.defaultTimeoutMs);
    const active = { controller, promise: undefined };
    this.active.set(job.id, active);
    const promise = (async () => {
      await this.store.update(job.id, { status: "running", startedAt: new Date().toISOString(), attempts: job.attempts + 1 });
      try {
        const result = await this.execute(job.payload, { signal: controller.signal, job });
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("job aborted");
        await this.store.update(job.id, { status: "completed", completedAt: new Date().toISOString(), result });
      } catch (error) {
        const current = await this.store.get(job.id);
        const cancelled = controller.signal.aborted && String(controller.signal.reason?.message ?? "").includes("cancel");
        await this.store.update(job.id, {
          status: cancelled ? "cancelled" : "failed",
          completedAt: new Date().toISOString(),
          error: error.message
        });
        if (!cancelled && current?.attempts < this.maxAttempts) {
          await this.store.update(job.id, { status: "queued", completedAt: undefined, error: error.message });
        }
      } finally {
        clearTimeout(timeout);
        this.active.delete(job.id);
        await this.drain();
      }
    })();
    active.promise = promise;
    return promise;
  }
}

export function createIsolatedTaskExecutor({ stateDir, workspaceRoot, config, policy } = {}) {
  const workerPath = fileURLToPath(new URL("./task-worker.mjs", import.meta.url));
  return (payload, { signal } = {}) => new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      child.kill();
      finish(signal.reason instanceof Error ? signal.reason : new Error("isolated task aborted"));
    };
    child.on("message", (message) => {
      if (message?.ok) finish(undefined, message.result);
      else finish(new Error(message?.error || "isolated task failed"));
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (!settled) finish(new Error(`isolated task worker exited unexpectedly: ${code ?? exitSignal}`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    child.send({ payload, stateDir, workspaceRoot, config, policy });
  });
}
