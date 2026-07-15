import { createAuditStore, createApprovalStore, createBuiltInRegistry, runTask } from "./index.mjs";
import { join } from "node:path";

process.on("message", async (message) => {
  try {
    const { payload, stateDir, workspaceRoot, config, policy } = message;
    const auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
    const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
    const registry = createBuiltInRegistry({ workspaceRoot, stateDir, config, approvalStore });
    const result = await runTask({ task: payload.task, auditStore, policy, registry });
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({ ok: false, error: error.message });
  }
});
