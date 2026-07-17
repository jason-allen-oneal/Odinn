import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export const SQLITE_SCHEMA_VERSION = 3;
type JsonMap = { [key: string]: unknown };
type SqlRow = { [key: string]: any };
type FeatureFlags = Record<string, boolean>;
type Artifact = { digest: string; path: string; mediaType: string; sizeBytes: number };

const SECRET_KEY = /(api[_-]?key|access[_-]?token|refresh[_-]?token|capability(?:[_-]?token)?|authorization|cookie|credential|password|secret|private[_-]?key)/i;
const SECRET_VALUE = /Bearer\s+[A-Za-z0-9._~+\/-]+|(?:sk|rk)-[A-Za-z0-9_-]{12,}/g;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonMap;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function redact(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[redacted-depth]";
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]").slice(0, 100_000);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redact(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 1_000).filter(([, item]) => item !== undefined).map(([name, item]) => [name, redact(item, name, depth + 1)]));
  }
  return value;
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotateRight(value: number, bits: number) { return (value >>> bits) | (value << (32 - bits)); }

function digest(value: string | Buffer): string {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = Buffer.alloc(paddedLength);
  input.copy(padded);
  padded[input.length] = 0x80;
  padded.writeUInt32BE(Math.floor(bitLength / 0x100000000), paddedLength - 8);
  padded.writeUInt32BE(bitLength >>> 0, paddedLength - 4);
  let [a0, b0, c0, d0, e0, f0, g0, h0] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = padded.readUInt32BE(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]; const y = words[index - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [a0, b0, c0, d0, e0, f0, g0, h0];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + temp2) >>> 0];
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    e0 = (e0 + e) >>> 0; f0 = (f0 + f) >>> 0; g0 = (g0 + g) >>> 0; h0 = (h0 + h) >>> 0;
  }
  return [a0, b0, c0, d0, e0, f0, g0, h0].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return typeof value === "string" && value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
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
  CREATE INDEX IF NOT EXISTS idx_model_observations_model ON model_observations(provider_id, model_id, task_class);`,
  `CREATE TABLE IF NOT EXISTS run_request_bindings (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    request_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`
];

export class SqliteStore {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path) throw new Error("SqliteStore requires a path");
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    this.migrate();
  }

  migrate() {
    const current = (this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as SqlRow).version;
    for (let version = Number(current) + 1; version <= MIGRATIONS.length; version += 1) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(MIGRATIONS[version - 1]!);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  transaction<T>(callback: (database: DatabaseSync) => T): T {
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
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  put(value: string | Buffer, { mediaType = "application/octet-stream" }: { mediaType?: string } = {}): Artifact {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const hash = digest(bytes);
    const relativePath = join("sha256", hash.slice(0, 2), hash);
    const path = join(this.root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return { digest: hash, path: relativePath.replaceAll("\\", "/"), mediaType, sizeBytes: bytes.byteLength };
  }

  putJson(value: unknown): Artifact {
    return this.put(JSON.stringify(redact(value)), { mediaType: "application/json" });
  }
}

export class RunLedger {
  readonly database: SqliteStore;
  readonly artifacts: ArtifactStore;
  readonly workspaceRoot: string;
  readonly stateDir: string;
  readonly featureFlags: FeatureFlags;

  constructor({ database, artifacts, workspaceRoot, stateDir, featureFlags = {} }: { database: SqliteStore; artifacts: ArtifactStore; workspaceRoot?: string; stateDir?: string; featureFlags?: FeatureFlags }) {
    if (!database || !artifacts) throw new Error("RunLedger requires database and artifacts");
    this.database = database;
    this.artifacts = artifacts;
    this.workspaceRoot = resolve(workspaceRoot ?? process.cwd());
    this.stateDir = resolve(stateDir ?? dirname(database.path));
    this.featureFlags = { ...featureFlags };
  }

  ensureRun({ runId, objective, modelId = "", providerId = "", parentRunId, branchPointStepId, workspaceRoot = this.workspaceRoot }: { runId: string; objective?: string; modelId?: string; providerId?: string; parentRunId?: string; branchPointStepId?: string; workspaceRoot?: string }) {
    if (!runId) throw new Error("RunLedger requires runId");
    const now = new Date().toISOString();
    this.database.db.prepare(`INSERT OR IGNORE INTO runs
      (id, parent_run_id, branch_point_step_id, status, objective, model_id, provider_id, workspace_root, feature_flags_json, created_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`)
      .run(runId, parentRunId ?? null, branchPointStepId ?? null, String(objective ?? ""), String(modelId), String(providerId), resolve(workspaceRoot), JSON.stringify(this.featureFlags), now);
    return runId;
  }

  bindRunRequest({ runId, requestDigest }: { runId: string; requestDigest: string }) {
    if (!runId || !requestDigest) throw new Error("run request binding requires runId and requestDigest");
    return this.database.transaction((db) => {
      const existing = db.prepare("SELECT request_digest FROM run_request_bindings WHERE run_id = ?").get(runId) as SqlRow | undefined;
      if (existing && existing.request_digest !== requestDigest) {
        const error = new Error(`run id ${runId} was already used for a different request`) as Error & { code?: string };
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      if (!existing) db.prepare("INSERT INTO run_request_bindings(run_id, request_digest, created_at) VALUES (?, ?, ?)").run(runId, requestDigest, new Date().toISOString());
      return { runId, requestDigest, replay: Boolean(existing) };
    });
  }

  appendEvent({ runId, type, payload = {}, timestamp = new Date().toISOString() }: { runId: string; type: string; payload?: JsonMap; timestamp?: string }) {
    return this.database.transaction((db) => this.appendEventUnsafe(db, { runId, type, payload, timestamp }));
  }

  appendEventUnsafe(db: DatabaseSync, { runId, type, payload = {}, timestamp }: { runId: string; type: string; payload?: JsonMap; timestamp: string }) {
    const previous = db.prepare("SELECT sequence, hash FROM ledger_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1").get(runId) as SqlRow | undefined;
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

  beginTool({ runId, toolName, input, safety, metadata = {} }: { runId: string; toolName: string; input?: unknown; safety?: unknown; metadata?: JsonMap }) {
    const inputArtifact = this.artifacts.putJson(input ?? {});
    const now = new Date().toISOString();
    const stepId = `step_${randomUUID()}`;
    this.database.transaction((db) => {
      db.prepare("UPDATE runs SET status = 'executing', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, runId);
      const next = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_steps WHERE run_id = ?").get(runId) as SqlRow).sequence) + 1;
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

  recordPolicy({ runId, stepId, decision, reason, details }: { runId: string; stepId: string; decision: string; reason?: string; details?: unknown }) {
    return this.appendEvent({ runId, type: "policy-check", payload: { stepId, decision, reason, details } });
  }

  finishTool({ runId, stepId, output, status = "succeeded", error }: { runId: string; stepId: string; output?: unknown; status?: string; error?: unknown }) {
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

  listRuns({ limit = 20 }: { limit?: number } = {}) {
    return (this.database.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(Number(limit) || 20, 200))) as SqlRow[]).map((row) => this.hydrateRun(row));
  }

  getRun(runId: string) {
    const row = this.database.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as SqlRow | undefined;
    if (!row) return undefined;
    const steps = (this.database.db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY sequence").all(runId) as SqlRow[]).map((step) => ({ ...step, metadata: parseJson(step.metadata_json, {}) }));
    const events = (this.database.db.prepare("SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence").all(runId) as SqlRow[]).map((event) => ({ ...event, payload: parseJson(event.payload_json, {}) }));
    return { ...this.hydrateRun(row), steps, events };
  }

  verify(runId: string) {
    const events = this.database.db.prepare("SELECT * FROM ledger_events WHERE run_id = ? ORDER BY sequence").all(runId) as SqlRow[];
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

  hydrateRun(row: SqlRow) {
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

export function createRunLedger({ stateDir = ".odinn", workspaceRoot = process.cwd(), featureFlags = {} }: { stateDir?: string; workspaceRoot?: string; featureFlags?: FeatureFlags } = {}) {
  const state = resolve(stateDir);
  const database = new SqliteStore(join(state, "db", "odinn.sqlite"));
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  return new RunLedger({ database, artifacts, workspaceRoot, stateDir: state, featureFlags });
}
