import { createAuditStore, createApprovalStore, createBuiltInRegistry, createRunLedger, closeBrowserManagers, normalizeExperimentalFlags, runTask } from "./index.mjs";
import { join } from "node:path";

let queue = Promise.resolve();
let shuttingDown = false;

async function handle(message) {
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
      const { payload, stateDir, workspaceRoot, config, policy } = message;
      const auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
      const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
      const registry = createBuiltInRegistry({ workspaceRoot, stateDir, config, approvalStore });
      runLedger = createRunLedger({ stateDir, workspaceRoot, featureFlags: normalizeExperimentalFlags(config.experimental) });
      const result = await runTask({ task: payload.task, auditStore, policy, registry, runLedger });
      process.send?.({ id: message.id, ok: true, result });
    } catch (error) {
      process.send?.({ id: message.id, ok: false, error: error.message });
    } finally {
      runLedger?.close();
    }
  });
  await queue;
}

process.on("message", (message) => {
  if (!shuttingDown) handle(message).catch(() => undefined);
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
