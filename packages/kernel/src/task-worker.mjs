import { closeBrowserManagers, createAuditStore, createApprovalStore, createBuiltInRegistry, runPlan, runTask } from "./index.mjs";
import { join } from "node:path";

let shuttingDown = false;

process.on("message", async (message) => {
  try {
    const { payload, stateDir, workspaceRoot, config, policy } = message;
    const auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
    const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
    const registry = createBuiltInRegistry({ workspaceRoot, stateDir, config, approvalStore });
    const result = payload.plan
      ? await runPlan({ plan: payload.plan, auditStore, policy, registry })
      : await runTask({ task: payload.task, auditStore, policy, registry });
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({ ok: false, error: error.message });
  }
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeBrowserManagers();
  process.exit(0);
}

process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
