import { closeBrowserManagers, createAuditStore, createApprovalStore, createBuiltInRegistry, createRunLedger, normalizeExperimentalFlags, runPlan, runTask } from "./index.ts";
import { join } from "node:path";
import type { RuntimePolicy } from "@odinn/policy";

let shuttingDown = false;

interface TaskWorkerMessage {
  payload?: { plan?: unknown; task?: unknown };
  stateDir?: string;
  workspaceRoot?: string;
  config?: { auditLog?: string; experimental?: unknown };
  policy?: RuntimePolicy;
}

const messageError = (error: unknown) => error instanceof Error ? error.message : String(error);

process.on("message", async (rawMessage: unknown) => {
  let runLedger;
  try {
    if (!rawMessage || typeof rawMessage !== "object") throw new Error("task worker received an invalid envelope");
    const { payload, stateDir, workspaceRoot, config = {}, policy } = rawMessage as TaskWorkerMessage;
    if (!payload || !stateDir || !workspaceRoot) throw new Error("task worker received an incomplete envelope");
    const auditStore = createAuditStore(join(stateDir, config.auditLog ?? "audit.jsonl"));
    const approvalStore = createApprovalStore({ path: join(stateDir, "approvals.json") });
    const registryOptions = { workspaceRoot, stateDir, config, approvalStore, auditStore };
    const registry = createBuiltInRegistry(registryOptions);
    runLedger = createRunLedger({ stateDir, workspaceRoot, featureFlags: normalizeExperimentalFlags(config.experimental) });
    const result = payload.plan
      ? await runPlan({ plan: payload.plan, auditStore, policy, registry, runLedger })
      : await runTask({ task: payload.task, auditStore, policy, registry, runLedger, signal: undefined });
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({ ok: false, error: messageError(error) });
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
