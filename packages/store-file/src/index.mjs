import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeAuditEvent } from "@odinn/protocol";

export class FileAuditStore {
  constructor(path) {
    if (!path) throw new Error("FileAuditStore requires a path");
    this.path = path;
  }

  async append(event) {
    const normalized = normalizeAuditEvent(event);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(normalized)}\n`, { flag: "a" });
    return normalized;
  }

  async readAll() {
    let content = "";
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async readRuns() {
    const runs = new Map();
    for (const event of await this.readAll()) {
      const current = runs.get(event.runId) ?? {
        id: event.runId,
        actor: event.actor,
        tool: event.tool,
        capability: event.capability,
        status: "unknown",
        startedAt: undefined,
        completedAt: undefined,
        lastEventAt: event.at,
        message: undefined,
        eventCount: 0
      };
      current.actor = event.actor ?? current.actor;
      current.tool = event.tool ?? current.tool;
      current.capability = event.capability ?? current.capability;
      current.lastEventAt = event.at;
      current.eventCount += 1;

      if (event.type === "task.policy" && event.decision === "deny") {
        current.status = "denied";
        current.message = event.message;
      } else if (event.type === "plan.started") {
        current.status = "running";
        current.startedAt = event.at;
        current.message = event.data?.name;
      } else if (event.type === "plan.completed") {
        current.status = "completed";
        current.completedAt = event.at;
      } else if (event.type === "plan.failed") {
        current.status = "failed";
        current.completedAt = event.at;
        current.message = event.message;
      } else if (event.type === "task.started") {
        current.status = "running";
        current.startedAt = event.at;
      } else if (event.type === "task.completed") {
        current.status = "completed";
        current.completedAt = event.at;
      } else if (event.type === "task.approval_required") {
        current.status = "awaiting_approval";
        current.message = event.message;
      } else if (event.type === "task.failed") {
        current.status = "failed";
        current.completedAt = event.at;
        current.message = event.message;
      }
      runs.set(event.runId, current);
    }
    return Array.from(runs.values()).sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
  }

  async readRun(id) {
    if (!id) throw new Error("readRun requires id");
    const events = (await this.readAll()).filter((event) => event.runId === id);
    const summary = (await this.readRuns()).find((run) => run.id === id);
    return summary ? { ...summary, events } : undefined;
  }
}

export class FileRecordStore {
  constructor(path) {
    if (!path) throw new Error("FileRecordStore requires a path");
    this.path = path;
  }

  async append(record) {
    const normalized = {
      schemaVersion: 1,
      at: typeof record.at === "string" ? record.at : new Date().toISOString(),
      ...record
    };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(normalized)}\n`, { flag: "a" });
    return normalized;
  }

  async readAll() {
    let content = "";
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async list({ type, limit = 50 } = {}) {
    const records = await this.readAll();
    const filtered = type ? records.filter((record) => record.type === type) : records;
    const count = Number.isFinite(limit) && limit > 0 ? limit : 50;
    return filtered.slice(-count).reverse();
  }

  async search({ type, query = "", limit = 20 } = {}) {
    const needle = String(query).trim().toLowerCase();
    const records = type ? (await this.readAll()).filter((record) => record.type === type) : await this.readAll();
    const filtered = needle
      ? records.filter((record) => JSON.stringify(record).toLowerCase().includes(needle))
      : records;
    const count = Number.isFinite(limit) && limit > 0 ? limit : 20;
    return filtered.slice(-count).reverse();
  }
}
