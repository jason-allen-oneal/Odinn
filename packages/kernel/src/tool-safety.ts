const READ_TOOLS = new Set(["job.healthcheck", "text.echo", "workspace.readText", "web.search", "web.fetch", "browser.tabs", "browser.open", "browser.snapshot", "memory.search", "memory.recall", "memory.browse", "memory.open", "memory.curate", "session.list", "session.read", "goal.list", "improve.list"]);
const WRITE_TOOLS = new Set(["memory.remember", "memory.compact", "memory.correct", "session.create", "session.message", "session.rename", "session.delete", "goal.create", "goal.update", "improve.propose", "improve.decide"]);
const RETRY_SAFE_TOOLS = new Set(["job.healthcheck", "text.echo", "workspace.readText", "web.search", "web.fetch", "memory.search", "memory.recall", "memory.browse", "memory.open", "memory.curate", "session.list", "session.read", "goal.list", "improve.list"]);

export type ToolEffect = "read" | "filesystem-write" | "process" | "network" | "credential" | "external-state";
export type Reversibility = "pure" | "snapshot-reversible" | "compensatable" | "irreversible";

export interface ToolSafetyDescriptor {
  toolName: string;
  effects: ToolEffect[];
  reversibility: Reversibility;
  requiresCapability: boolean;
  requiresApproval: boolean;
  retrySafe: boolean;
}

export function toolSafetyDescriptor(toolName: unknown, tool: unknown): ToolSafetyDescriptor {
  const name = String(toolName || "unknown");
  if (!tool) return { toolName: name, effects: ["read", "filesystem-write", "process", "network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
  if (["browser.click", "browser.type", "browser.press"].includes(name)) return { toolName: name, effects: ["network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
  if (name === "model.chat" || name === "agent.run") return { toolName: name, effects: ["network", "credential"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: false };
  if (READ_TOOLS.has(name)) return { toolName: name, effects: name.startsWith("web.") || name.startsWith("browser.") ? ["read", "network"] : ["read"], reversibility: "pure", requiresCapability: true, requiresApproval: false, retrySafe: RETRY_SAFE_TOOLS.has(name) };
  if (WRITE_TOOLS.has(name)) return { toolName: name, effects: ["filesystem-write"], reversibility: "snapshot-reversible", requiresCapability: true, requiresApproval: false, retrySafe: false };
  return { toolName: name, effects: ["read", "filesystem-write", "process", "network", "credential", "external-state"], reversibility: "irreversible", requiresCapability: true, requiresApproval: true, retrySafe: false };
}
