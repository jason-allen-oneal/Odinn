import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export const SQLITE_SCHEMA_VERSION = 2;

const SECRET_KEY = /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|secret|private[_-]?key)/i;
const SECRET_VALUE = /Bearer\s+[A-Za-z0-9._~+\/-]+|(?:sk|rk)-[A-Za-z0-9_-]{12,}/g;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function redact(value, key = "", depth = 0) {
  if (depth > 8) return "[redacted-depth]";
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]").slice(0, 100_000);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redact(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 1_000).filter(([, item]) => item !== undefined).map(([name, item]) => [name, redact(item, name, depth + 1)]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    parent_run_id TEXT,
    branch_point_step_id TEXT,
    status TEXT NOT NULL,
    objective TEXT NOT NULL,
    model_id TEXT,
    provider_id TEXT,
    workspace_root TEXT NOT NULL,
    feature_flags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    input_digest TEXT,
    output_digest TEXT,
    metadata_json TEXT NOT NULL,
    UNIQUE(run_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    digest TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    previous_hash TEXT,
    hash TEXT NOT NULL,
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, hash)
  );
  CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_ledger_events_run ON ledger_events(run_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_ledger_events_type ON ledger_events(type, timestamp);`
  ,
  `CREATE TABLE IF NOT EXISTS verification_contracts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    version INTEGER NOT NULL,
    contract_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, id)
  );
  CREATE TABLE IF NOT EXISTS assertion_results (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES verification_contracts(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    assertion_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    evidence_artifact_ids_json TEXT NOT NULL,
    message TEXT NOT NULL,
    result_json TEXT NOT NULL,
    UNIQUE(contract_id, assertion_id)
  );
  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS policy_evaluations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT,
    policy_id TEXT,
    invariant_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    enforcement TEXT NOT NULL,
    reason TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    nonce TEXT NOT NULL UNIQUE,
    revoked_at TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS capability_uses (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    tool_name TEXT NOT NULL,
    resource_json TEXT NOT NULL,
    used_at TEXT NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT,
    label TEXT,
    workspace_root TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshot_entries (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    path TEXT NOT NULL,
    existed INTEGER NOT NULL,
    mode INTEGER,
    digest TEXT,
    artifact_digest TEXT,
    UNIQUE(snapshot_id, path)
  );
  CREATE TABLE IF NOT EXISTS run_branches (
    id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL REFERENCES runs(id),
    source_step_id TEXT NOT NULL,
    child_run_id TEXT NOT NULL REFERENCES runs(id),
    label TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(source_run_id, child_run_id)
  );
  CREATE TABLE IF NOT EXISTS compensation_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT NOT NULL,
    handler TEXT NOT NULL,
    status TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS capsules (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    path TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_observations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    task_class TEXT NOT NULL,
    verified INTEGER NOT NULL,
    partially_verified INTEGER NOT NULL,
    cost_usd REAL,
    duration_ms INTEGER NOT NULL,
    tool_calls INTEGER NOT NULL,
    tool_errors INTEGER NOT NULL,
    retries INTEGER NOT NULL,
    policy_violations INTEGER NOT NULL,
    rolled_back INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS counterfactual_groups (
    id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL REFERENCES runs(id),
    contract_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS counterfactual_candidates (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES counterfactual_groups(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL,
    selected_at TEXT,
    UNIQUE(group_id, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_assertion_results_run ON assertion_results(run_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_policy_evaluations_run ON policy_evaluations(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_capabilities_run ON capabilities(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_model_observations_model ON model_observations(provider_id, model_id, task_class);`
];

export class SqliteStore {
  constructor(path) {
    if (!path) throw new Error("SqliteStore requires a path");
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    this.migrate();
  }

  migrate() {
    const current = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
    for (let version = Number(current) + 1; version <= MIGRATIONS.length; version += 1) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(MIGRATIONS[version - 1]);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(this.db);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

export class ArtifactStore {
  constructor(root) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  put(value, { mediaType = "application/octet-stream" } = {}) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const hash = digest(bytes);
    const relativePath = join("sha256", hash.slice(0, 2), hash);
    const path = join(this.root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return { digest: hash, path: relativePath.replaceAll("\\", "/"), mediaType, sizeBytes: bytes.byteLength };
  }

  putJson(value) {
    return this.put(JSON.stringify(redact(value)), { mediaType: "application/json" });
  }
}

export class RunLedger {
  constructor({ database, artifacts, workspaceRoot, featureFlags = {} } = {}) {
    if (!database || !artifacts) throw new Error("RunLedger requires database and artifacts");
    this.database = database;
    this.artifacts = artifacts;
    this.workspaceRoot = resolve(workspaceRoot ?? process.cwd());
    this.featureFlags = { ...featureFlags };
  }

  ensureRun({ runId, objective, modelId = "", providerId = "", parentRunId, branchPointStepId } = {}) {
    if (!runId) throw new Error("RunLedger requires runId");
    const now = new Date().toISOString();
    this.database.db.prepare(`INSERT OR IGNORE INTO runs
      (id, parent_run_id, branch_point_step_id, status, objective, model_id, provider_id, workspace_root, feature_flags_json, created_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`)
      .run(runId, parentRunId ?? null, branchPointStepId ?? null, String(objective ?? ""), String(modelId), String(providerId), this.workspaceRoot, JSON.stringify(this.featureFlags), now);
    return runId;
  }

  appendEvent({ runId, type, payload = {}, timestamp = new Date().toISOString() } = {}) {
    return this.database.transaction((db) => this.appendEventUnsafe(db, { runId, type, payload, timestamp }));
  }

  appendEventUnsafe(db, { runId, type, payload = {}, timestamp }) {
    const previous = db.prepare("SELECT sequence, hash FROM ledger_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1").get(runId);
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const safePayload = redact(payload);
    const envelope = { id: randomUUID(), runId, sequence, type, timestamp, payload: safePayload, previousHash: previous?.hash ?? null };
    const hash = digest(stable(envelope));
    db.prepare(`INSERT INTO ledger_events
      (id, run_id, sequence, type, timestamp, payload_json, previous_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(envelope.id, runId, sequence, type, timestamp, JSON.stringify(safePayload), envelope.previousHash, hash);
    return { ...envelope, hash };
  }

  beginTool({ runId, toolName, input, safety, metadata = {} } = {}) {
    const inputArtifact = this.artifacts.putJson(input ?? {});
    const now = new Date().toISOString();
    const stepId = `step_${randomUUID()}`;
    this.database.transaction((db) => {
      db.prepare("UPDATE runs SET status = 'executing', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, runId);
      const next = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_steps WHERE run_id = ?").get(runId).sequence + 1;
      db.prepare(`INSERT INTO run_steps
        (id, run_id, sequence, type, status, started_at, input_digest, metadata_json)
        VALUES (?, ?, ?, 'tool-request', 'running', ?, ?, ?)`)
        .run(stepId, runId, next, now, inputArtifact.digest, JSON.stringify(redact({ toolName, safety, ...metadata })));
      this.appendEventUnsafe(db, { runId, type: "tool-request", timestamp: now, payload: { stepId, toolName, inputDigest: inputArtifact.digest, safety } });
      db.prepare("INSERT OR IGNORE INTO artifacts(digest, path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(inputArtifact.digest, inputArtifact.path, inputArtifact.mediaType, inputArtifact.sizeBytes, now);
    });
    return { stepId, inputArtifact };
  }

  recordPolicy({ runId, stepId, decision, reason, details } = {}) {
    return this.appendEvent({ runId, type: "policy-check", payload: { stepId, decision, reason, details } });
  }

  finishTool({ runId, stepId, output, status = "succeeded", error } = {}) {
    const outputArtifact = output === undefined ? undefined : this.artifacts.putJson(output);
    const now = new Date().toISOString();
    this.database.transaction((db) => {
      const row = db.prepare("SELECT sequence FROM run_steps WHERE id = ? AND run_id = ?").get(stepId, runId);
      if (!row) throw new Error(`ledger step not found: ${stepId}`);
      db.prepare("UPDATE run_steps SET status = ?, completed_at = ?, output_digest = ? WHERE id = ?")
        .run(status, now, outputArtifact?.digest ?? null, stepId);
      this.appendEventUnsafe(db, { runId, type: "tool-result", timestamp: now, payload: { stepId, status, outputDigest: outputArtifact?.digest, error } });
      if (outputArtifact) db.prepare("INSERT OR IGNORE INTO artifacts(digest, path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(outputArtifact.digest, outputArtifact.path, outputArtifact.mediaType, outputArtifact.sizeBytes, now);
      db.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?").run(status === "succeeded" ? "completed-unverified" : status, now, runId);
    });
    return outputArtifact;
  }

  listRuns({ limit = 20 } = {}) {
    return this.database.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(Number(limit) || 20, 200))).map((row) => this.hydrateRun(row));
  }

  getRun(runId) {
    const row = this.database.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!row) return undefined;
    const steps = this.database.db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY sequence").all(runId).map((step) => ({ ...step, metadata: parseJson(step.metadata_json, {}) }));
    const events = this.database.db.prepare("SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence").all(runId).map((event) => ({ ...event, payload: parseJson(event.payload_json, {}) }));
    return { ...this.hydrateRun(row), steps, events };
  }

  verify(runId) {
    const events = this.database.db.prepare("SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence").all(runId);
    let previousHash = null;
    let valid = true;
    for (const event of events) {
      const envelope = { id: event.id, runId: event.run_id, sequence: event.sequence, type: event.type, timestamp: event.timestamp, payload: parseJson(event.payload_json, {}), previousHash };
      if (event.previous_hash !== previousHash || event.hash !== digest(stable(envelope))) valid = false;
      previousHash = event.hash;
    }
    return { runId, valid, eventCount: events.length };
  }

  close() {
    this.database.close();
  }

  hydrateRun(row) {
    return {
      id: row.id,
      parentRunId: row.parent_run_id ?? undefined,
      branchPointStepId: row.branch_point_step_id ?? undefined,
      status: row.status,
      objective: row.objective,
      modelId: row.model_id,
      providerId: row.provider_id,
      workspaceRoot: row.workspace_root,
      featureFlags: parseJson(row.feature_flags_json, {}),
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    };
  }
}

export function createRunLedger({ stateDir = ".odinn", workspaceRoot = process.cwd(), featureFlags = {} } = {}) {
  const state = resolve(stateDir);
  const database = new SqliteStore(join(state, "db", "odinn.sqlite"));
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  return new RunLedger({ database, artifacts, workspaceRoot, featureFlags });
}
