import { closeBrowserManagers, createAuditStore, createApprovalStore, createBuiltInRegistry, createRunLedger, normalizeExperimentalFlags, runPlan, runTask } from "./index.mjs";
import { join } from "node:path";

let shuttingDown = false;

process.on("message", async (message) => {
  let runLedger;
  try {
    const { payload, stateDir, workspaceRoot, config, policy } = message;
    const auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
    const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
    const registry = createBuiltInRegistry({ workspaceRoot, stateDir, config, approvalStore });
    runLedger = createRunLedger({ stateDir, workspaceRoot, featureFlags: normalizeExperimentalFlags(config.experimental) });
    const result = payload.plan
      ? await runPlan({ plan: payload.plan, auditStore, policy, registry, runLedger })
      : await runTask({ task: payload.task, auditStore, policy, registry, runLedger });
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({ ok: false, error: error.message });
  } finally {
    runLedger?.close();
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
