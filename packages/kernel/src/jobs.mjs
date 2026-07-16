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
    this.stopping = false;
  }

  async start() {
    if (this.started) return;
    this.stopping = false;
    await this.store.recover({ maxAttempts: this.maxAttempts });
    this.started = true;
    await this.drain();
  }

  async submit(payload, { id = `job_${randomUUID()}`, timeoutMs = this.defaultTimeoutMs, requestHash } = {}) {
    const job = await this.store.create({ id, payload, requestHash, status: "queued", timeoutMs });
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
    if (!this.started || this.stopping || this.draining) return;
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
    this.stopping = true;
    this.started = false;
    for (const active of this.active.values()) active.controller.abort(new Error("supervisor shutting down"));
    await Promise.allSettled(Array.from(this.active.values(), (active) => active.promise));
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
        if (!this.stopping && !cancelled && current?.attempts < this.maxAttempts) {
          await this.store.update(job.id, { status: "queued", completedAt: undefined, error: error.message });
        }
      } finally {
        clearTimeout(timeout);
        this.active.delete(job.id);
        if (!this.stopping) await this.drain();
      }
    })();
    active.promise = promise;
    return promise;
  }
}

export function createIsolatedTaskExecutor({ stateDir, workspaceRoot, config, policy } = {}) {
  const workerPath = fileURLToPath(new URL("./task-worker.mjs", import.meta.url));
  const browserWorkerPath = fileURLToPath(new URL("./browser-worker.mjs", import.meta.url));
  const browserExecutor = createPersistentWorkerExecutor({
    workerPath: browserWorkerPath,
    stateDir,
    workspaceRoot,
    config,
    policy
  });
  const children = new Set();
  const execute = (payload, { signal } = {}) => {
    if (String(payload?.task?.tool || "").startsWith("browser.")) return browserExecutor(payload, { signal });
    return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.add(child);
    let settled = false;
    const finish = (error, result) => {
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
  };
  execute.shutdown = async () => {
    await browserExecutor.shutdown();
    for (const child of children) child.kill();
    children.clear();
  };
  return execute;
}

function createPersistentWorkerExecutor({ workerPath, stateDir, workspaceRoot, config, policy } = {}) {
  let child;
  let sequence = 0;
  let shuttingDown = false;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const request of pending.values()) request.finish(error);
    pending.clear();
  };

  const ensureChild = () => {
    if (child && child.connected) return child;
    const currentChild = fork(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child = currentChild;
    currentChild.on("message", (message) => {
      const request = pending.get(message?.id);
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

  const execute = (payload, { signal } = {}) => new Promise((resolve, reject) => {
    if (shuttingDown) {
      reject(new Error("persistent worker is shutting down"));
      return;
    }
    const id = `request_${++sequence}`;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      for (const request of pending.values()) request.finish(signal.reason instanceof Error ? signal.reason : new Error("persistent task aborted"));
      pending.clear();
      child?.kill();
      finish(signal.reason instanceof Error ? signal.reason : new Error("persistent task aborted"));
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
      finish(error);
    }
  });

  execute.shutdown = async () => {
    shuttingDown = true;
    if (!child) return;
    const current = child;
    rejectPending(new Error("persistent worker shutting down"));
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        current.kill();
        resolve();
      }, 5_000);
      current.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (current.connected) current.send({ type: "shutdown" });
      else current.kill();
    });
    child = undefined;
  };
  return execute;
}
