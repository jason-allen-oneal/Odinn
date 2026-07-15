import { randomUUID } from "node:crypto";

export const AUDIT_SCHEMA_VERSION = 1;

export class ProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProtocolError";
    this.details = details;
  }
}

export function createRunId() {
  return `run_${randomUUID()}`;
}

export function normalizeTaskRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("task request must be an object");
  }
  if (typeof input.tool !== "string" || input.tool.trim() === "") {
    throw new ProtocolError("task request requires a non-empty tool");
  }
  const request = {
    id: typeof input.id === "string" && input.id.trim() ? input.id : createRunId(),
    tool: input.tool.trim(),
    input: input.input && typeof input.input === "object" && !Array.isArray(input.input) ? input.input : {},
    actor: typeof input.actor === "string" && input.actor.trim() ? input.actor.trim() : "local",
    reason: typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined
  };
  return request;
}

export function normalizeAuditEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("audit event must be an object");
  }
  if (typeof input.runId !== "string" || input.runId.trim() === "") {
    throw new ProtocolError("audit event requires runId");
  }
  if (typeof input.type !== "string" || input.type.trim() === "") {
    throw new ProtocolError("audit event requires type");
  }
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    at: typeof input.at === "string" ? input.at : new Date().toISOString(),
    runId: input.runId,
    type: input.type,
    actor: typeof input.actor === "string" ? input.actor : "local",
    tool: typeof input.tool === "string" ? input.tool : undefined,
    capability: typeof input.capability === "string" ? input.capability : undefined,
    decision: typeof input.decision === "string" ? input.decision : undefined,
    message: typeof input.message === "string" ? input.message : undefined,
    data: input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : undefined
  };
}
