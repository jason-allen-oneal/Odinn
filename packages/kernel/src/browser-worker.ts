import { createAuditStore, createApprovalStore, createBuiltInRegistry, createRunLedger, closeBrowserManagers, normalizeExperimentalFlags, runTask } from "./index.mjs";
import { join } from "node:path";
import type { RuntimePolicy } from "@odinn/policy";

let queue = Promise.resolve();
let shuttingDown = false;

interface BrowserWorkerMessage {
  type?: "task" | "shutdown";
  id?: string;
  payload?: { task?: unknown };
  stateDir?: string;
  workspaceRoot?: string;
  config?: { auditLog?: string; experimental?: unknown };
  policy?: RuntimePolicy;
}

const messageError = (error: unknown) => error instanceof Error ? error.message : String(error);

async function handle(message: BrowserWorkerMessage) {
  if (message?.type === "shutdown") {
    shuttingDown = true;
    await queue;
    await closeBrowserManagers();
    process.exit(0);
  }
  if (message?.type !== "task") return;
  queue = queue.then(async () => {
    let runLedger;
    try {
      const { payload, stateDir, workspaceRoot, config = {}, policy } = message;
      if (!payload?.task || !stateDir || !workspaceRoot) throw new Error("browser worker received an invalid task envelope");
      const auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
      const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
      const registry = createBuiltInRegistry({ workspaceRoot, stateDir, config, approvalStore });
      runLedger = createRunLedger({ stateDir, workspaceRoot, featureFlags: normalizeExperimentalFlags(config.experimental) });
      const result = await runTask({ task: payload.task, auditStore, policy, registry, runLedger, signal: undefined });
      process.send?.({ id: message.id, ok: true, result });
    } catch (error) {
      process.send?.({ id: message.id, ok: false, error: messageError(error) });
    } finally {
      runLedger?.close();
    }
  });
  await queue;
}

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  if (!shuttingDown) handle(message as BrowserWorkerMessage).catch(() => undefined);
});
process.on("disconnect", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await queue;
  await closeBrowserManagers();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await queue;
  await closeBrowserManagers();
  process.exit(0);
});
