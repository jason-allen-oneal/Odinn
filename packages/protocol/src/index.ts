import { randomUUID } from "node:crypto";

export const AUDIT_SCHEMA_VERSION = 1;

export type JsonObject = { [key: string]: unknown };

export interface TaskRequest {
  id: string;
  tool: string;
  input: JsonObject;
  actor: string;
  reason?: string;
}

export interface AuditEvent {
  schemaVersion: number;
  at: string;
  runId: string;
  type: string;
  actor: string;
  tool?: string;
  capability?: string;
  decision?: string;
  message?: string;
  data?: JsonObject;
}

export class ProtocolError extends Error {
  readonly details: JsonObject;

  constructor(message: string, details: JsonObject = {}) {
    super(message);
    this.name = "ProtocolError";
    this.details = details;
  }
}

export function createRunId() {
  return `run_${randomUUID()}`;
}

export function normalizeTaskRequest(input: unknown): TaskRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("task request must be an object");
  }
  const value = input as JsonObject;
  if (typeof value.tool !== "string" || value.tool.trim() === "") {
    throw new ProtocolError("task request requires a non-empty tool");
  }
  const request: TaskRequest = {
    id: typeof value.id === "string" && value.id.trim() ? value.id : createRunId(),
    tool: (value.tool as string).trim(),
    input: value.input && typeof value.input === "object" && !Array.isArray(value.input) ? value.input as JsonObject : {},
    actor: typeof value.actor === "string" && value.actor.trim() ? value.actor.trim() : "local"
  };
  if (typeof value.reason === "string" && value.reason.trim()) request.reason = value.reason.trim();
  return request;
}

export function normalizeAuditEvent(input: unknown): AuditEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("audit event must be an object");
  }
  const value = input as JsonObject;
  if (typeof value.runId !== "string" || value.runId.trim() === "") {
    throw new ProtocolError("audit event requires runId");
  }
  if (typeof value.type !== "string" || value.type.trim() === "") {
    throw new ProtocolError("audit event requires type");
  }
  const event: AuditEvent = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    at: typeof value.at === "string" ? value.at : new Date().toISOString(),
    runId: value.runId,
    type: value.type,
    actor: typeof value.actor === "string" ? value.actor : "local"
  };
  if (typeof value.tool === "string") event.tool = value.tool;
  if (typeof value.capability === "string") event.capability = value.capability;
  if (typeof value.decision === "string") event.decision = value.decision;
  if (typeof value.message === "string") event.message = value.message;
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) event.data = value.data as JsonObject;
  return event;
}
