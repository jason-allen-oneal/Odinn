import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, stat, lstat, rm, cp } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRunLedger, redact } from "./run-ledger.mjs";

export const ODINN_ERROR_CODES = Object.freeze([
  "POLICY_VIOLATION", "CAPABILITY_DENIED", "CAPABILITY_EXPIRED", "CAPABILITY_SCOPE_MISMATCH",
  "VERIFICATION_FAILED", "SNAPSHOT_FAILED", "ROLLBACK_CONFLICT", "COMPENSATION_FAILED",
  "CAPSULE_INVALID", "CAPSULE_TAMPERED", "REPLAY_UNSUPPORTED", "BUDGET_EXCEEDED",
  "WORKSPACE_CONFLICT", "MODEL_ROUTING_UNAVAILABLE"
]);

export class OdinnRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OdinnRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function now() { return new Date().toISOString(); }
function json(value) { return JSON.stringify(value); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function parse(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function requireExperimental(flags, name) {
  if (flags?.[name] !== true) throw new OdinnRuntimeError("POLICY_VIOLATION", `experimental.${name} is disabled`, { feature: name });
}
function safePath(root, candidate) {
  const base = resolve(root);
  const target = resolve(base, candidate);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new OdinnRuntimeError("POLICY_VIOLATION", "path escapes allowed root", { path: candidate });
  return target;
}
function safeExistingPath(root, candidate) {
  const target = safePath(root, candidate);
  let cursor = target;
  while (cursor !== root && !existsSync(cursor)) cursor = dirname(cursor);
  const real = resolve(realpathSync(cursor));
  if (real !== root && !real.startsWith(`${resolve(root)}${sep}`)) throw new OdinnRuntimeError("POLICY_VIOLATION", "symlink escapes allowed root", { path: candidate });
  return target;
}

// Minimal JSON/YAML-shaped loader: JSON is canonical; simple YAML is accepted for
// contracts and policies so the CLI remains dependency-free and rejects ambiguous input.
export function parseStructuredDocument(source, label = "document") {
  try { return JSON.parse(source); } catch {}
  const lines = String(source).split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, "")).filter((line) => line.trim());
  const root = {};
  let currentList;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      if (!currentList) throw new OdinnRuntimeError("CAPSULE_INVALID", `${label} YAML list has no parent`);
      const item = line.replace(/^\s*-\s+/, "");
      if (item.includes(": ")) { const [key, ...rest] = item.split(": "); currentList.push({ [key.trim()]: scalar(rest.join(": ").trim()) }); }
      else currentList.push(scalar(item));
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) throw new OdinnRuntimeError("CAPSULE_INVALID", `${label} must be JSON or simple YAML`);
    const [, key, raw] = match;
    if (!raw) { root[key] = []; currentList = root[key]; }
    else { root[key] = scalar(raw); currentList = undefined; }
  }
  return root;
}
function scalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") || value.startsWith("{")) { try { return JSON.parse(value); } catch {} }
  return value;
}

export function validateContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract must be an object");
  if (contract.version !== 1) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract version must be 1");
  if (typeof contract.goal !== "string" || !contract.goal.trim()) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract goal is required");
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract acceptance must contain assertions");
  const ids = new Set();
  for (const assertion of contract.acceptance) {
    if (!assertion || typeof assertion.id !== "string" || ids.has(assertion.id)) throw new OdinnRuntimeError("CAPSULE_INVALID", "assertion ids must be unique");
    ids.add(assertion.id);
    if (!["command", "file", "http", "git"].includes(assertion.type)) throw new OdinnRuntimeError("CAPSULE_INVALID", `unsupported assertion type: ${assertion.type}`);
    if (assertion.type === "command" && (typeof assertion.command !== "string" || !Array.isArray(assertion.args ?? []))) throw new OdinnRuntimeError("CAPSULE_INVALID", `command assertion ${assertion.id} requires command and args`);
    if (assertion.type === "file" && typeof assertion.path !== "string") throw new OdinnRuntimeError("CAPSULE_INVALID", `file assertion ${assertion.id} requires path`);
    if (assertion.type === "http" && typeof assertion.url !== "string") throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} requires url`);
  }
  return contract;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy must be an object");
  if (policy.version !== 1) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy version must be 1");
  if (!Array.isArray(policy.invariants)) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy invariants must be an array");
  for (const item of policy.invariants) {
    if (!item?.id || !item?.type || !["log", "warn", "pause", "block", "rollback", "terminate"].includes(item.enforcement ?? "block")) throw new OdinnRuntimeError("POLICY_VIOLATION", "invalid policy invariant");
  }
  return policy;
}

function runProcess(command, args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1_000_000) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 1_000_000) child.kill("SIGTERM"); });
    child.on("error", (error) => { clearTimeout(timer); rejectProcess(error); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolveProcess({ code: code ?? 1, signal, stdout: stdout.slice(0, 1_000_000), stderr: stderr.slice(0, 1_000_000), timedOut }); });
  });
}

export class ProofEngine {
  constructor({ ledger, featureFlags = {} } = {}) { this.ledger = ledger; this.featureFlags = featureFlags; }
  async run(runId, contract, { workspaceRoot = process.cwd() } = {}) {
    requireExperimental(this.featureFlags, "proof");
    validateContract(contract);
    const id = contract.id ?? `contract_${randomUUID()}`;
    const createdAt = now();
    this.ledger.database.transaction((db) => db.prepare("INSERT OR REPLACE INTO verification_contracts(id, run_id, version, contract_json, created_at) VALUES (?, ?, ?, ?, ?)").run(id, runId, contract.version, json(redact(contract)), createdAt));
    const results = [];
    for (const assertion of contract.acceptance) {
      const startedAt = now(); let result;
      try { result = await this.evaluate(assertion, workspaceRoot); }
      catch (error) { result = { status: "error", message: error.message, evidence: [] }; }
      const completedAt = now();
      const artifactIds = [];
      if (result.stdout || result.stderr || result.body || result.evidence) artifactIds.push(this.ledger.artifacts.putJson(redact(result)).digest);
      const row = { assertionId: assertion.id, status: result.status, startedAt, completedAt, evidenceArtifactIds: artifactIds, message: result.message ?? "", result };
      this.ledger.database.transaction((db) => db.prepare(`INSERT OR REPLACE INTO assertion_results(id, contract_id, run_id, assertion_id, status, started_at, completed_at, evidence_artifact_ids_json, message, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, runId, assertion.id, row.status, startedAt, completedAt, json(artifactIds), row.message, json(redact(result))));
      this.ledger.appendEvent({ runId, type: "verification", payload: row });
      results.push(row);
    }
    const required = results.filter((item) => item.status !== "skipped");
    const failed = required.some((item) => ["failed", "error"].includes(item.status));
    const passed = required.length > 0 && required.every((item) => item.status === "passed");
    const status = failed ? "failed" : passed ? "verified" : "partially-verified";
    this.ledger.database.db.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?").run(status, now(), runId);
    this.ledger.appendEvent({ runId, type: "verification-completed", payload: { contractId: id, status, results: results.map(({ assertionId, status: resultStatus }) => ({ assertionId, status: resultStatus })) } });
    return { runId, contractId: id, status, results };
  }
  async evaluate(assertion, workspaceRoot) {
    if (assertion.type === "command") {
      const result = await runProcess(assertion.command, assertion.args ?? [], { cwd: workspaceRoot, timeoutMs: assertion.timeoutMs ?? 120_000 });
      const expect = assertion.expect ?? {};
      const output = `${result.stdout}${result.stderr}`;
      const passed = result.code === (expect.exitCode ?? 0)
        && (expect.contains ? output.includes(expect.contains) : true)
        && (expect.excludes ? !output.includes(expect.excludes) : true);
      return { status: passed ? "passed" : "failed", message: passed ? "command assertion passed" : `exit=${result.code}`, code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
    if (assertion.type === "file") {
      const path = safeExistingPath(workspaceRoot, assertion.path); const exists = existsSync(path); const expectExists = assertion.expect?.exists !== false;
      const content = exists && lstatSync(path).isFile() ? readFileSync(path, "utf8") : "";
      const passed = expectExists ? exists && (!assertion.expect?.contains || content.includes(assertion.expect.contains)) : !exists;
      return { status: passed ? "passed" : "failed", message: passed ? "file assertion passed" : "file assertion failed", exists, digest: exists ? hash(content) : undefined };
    }
    if (assertion.type === "http") {
      const response = await fetch(assertion.url, { method: assertion.method ?? "GET", redirect: "manual" });
      const body = await response.text(); const expectedStatus = assertion.expect?.status ?? 200;
      const passed = response.status === expectedStatus && (!assertion.expect?.bodyContains || body.includes(assertion.expect.bodyContains));
      return { status: passed ? "passed" : "failed", message: passed ? "http assertion passed" : `status=${response.status}`, statusCode: response.status, body: body.slice(0, 100_000) };
    }
    if (assertion.type === "git") {
      const result = await runProcess("git", ["status", "--porcelain"], { cwd: workspaceRoot });
      const expectedClean = assertion.expect?.clean === true; const clean = result.stdout.trim() === "";
      return { status: clean === expectedClean ? "passed" : "failed", message: clean === expectedClean ? "git assertion passed" : "git working tree mismatch", stdout: result.stdout };
    }
    throw new OdinnRuntimeError("CAPSULE_INVALID", `unsupported assertion: ${assertion.type}`);
  }
  show(runId) { return this.ledger.database.db.prepare("SELECT * FROM assertion_results WHERE run_id = ? ORDER BY completed_at").all(runId).map((row) => ({ ...row, evidenceArtifactIds: parse(row.evidence_artifact_ids_json, []), result: parse(row.result_json) })); }
}

function policyMatch(invariant, toolName, input, workspaceRoot = process.cwd()) {
  const value = JSON.stringify(input ?? {});
  if (invariant.type === "tool.requires-approval") return (invariant.values ?? []).includes(toolName);
  if (invariant.type === "command.deny-pattern") return (invariant.values ?? []).some((pattern) => value.includes(pattern));
  if (invariant.type === "filesystem.allowed-roots") return toolName.includes("write") && typeof input?.path === "string" && !(invariant.values ?? []).some((root) => safePath(workspaceRoot, input.path).startsWith(safePath(workspaceRoot, root)));
  return false;
}

export class Sentinel {
  constructor({ ledger, featureFlags = {} } = {}) { this.ledger = ledger; this.featureFlags = featureFlags; }
  evaluate({ runId, stepId, toolName, input, policy, workspaceRoot = process.cwd() }) {
    requireExperimental(this.featureFlags, "sentinel"); validatePolicy(policy);
    const evaluations = [];
    for (const invariant of policy.invariants) {
      const violated = policyMatch(invariant, toolName, input, workspaceRoot);
      const decision = violated ? (invariant.enforcement ?? "block") : "allow";
      const evaluation = { id: randomUUID(), runId, stepId, policyId: policy.id ?? null, invariantId: invariant.id, decision, enforcement: invariant.enforcement ?? "block", reason: violated ? `invariant violated: ${invariant.id}` : "invariant satisfied", input: redact({ toolName, input }), createdAt: now() };
      this.ledger.database.db.prepare("INSERT INTO policy_evaluations(id, run_id, step_id, policy_id, invariant_id, decision, enforcement, reason, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evaluation.id, runId, stepId ?? null, evaluation.policyId, evaluation.invariantId, decision, evaluation.enforcement, evaluation.reason, json(evaluation.input), evaluation.createdAt);
      this.ledger.appendEvent({ runId, type: "policy-check", payload: evaluation }); evaluations.push(evaluation);
    }
    const blocked = evaluations.find((item) => ["block", "terminate", "rollback", "pause"].includes(item.decision));
    if (blocked) throw new OdinnRuntimeError("POLICY_VIOLATION", blocked.reason, { evaluation: blocked });
    return { allowed: true, evaluations };
  }
}

export class CapabilityBroker {
  constructor({ ledger, stateDir, featureFlags = {} } = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; this.keyPath = join(this.stateDir, "capability-signing.key"); mkdirSync(this.stateDir, { recursive: true }); this.key = this.loadKey(); }
  loadKey() { if (existsSync(this.keyPath)) return readFileSync(this.keyPath); const key = randomBytes(32); writeFileSync(this.keyPath, key, { mode: 0o600, flag: "wx" }); chmodSync(this.keyPath, 0o600); return key; }
  issue({ runId, stepId, toolName, scopes = [], resourceConstraints = {}, expiresInMs = 60_000, maxUses = 1, approvalId } = {}) {
    requireExperimental(this.featureFlags, "capabilities");
    const claims = { id: `cap_${randomUUID()}`, runId, stepId, toolName, scopes, resourceConstraints, issuedAt: now(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(), maxUses, approvalId, nonce: randomBytes(16).toString("hex") };
    const encoded = Buffer.from(json(claims)).toString("base64url"); const signature = createHmac("sha256", this.key).update(encoded).digest("base64url");
    this.ledger.database.db.prepare("INSERT INTO capabilities(id, run_id, step_id, tool_name, scopes_json, constraints_json, issued_at, expires_at, max_uses, nonce, approval_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')").run(claims.id, runId, stepId, toolName, json(scopes), json(resourceConstraints), claims.issuedAt, claims.expiresAt, maxUses, claims.nonce, approvalId ?? null);
    this.ledger.appendEvent({ runId, type: "capability-issued", payload: { ...claims, token: undefined } });
    return { token: `${encoded}.${signature}`, claims };
  }
  consume(token, { runId, toolName, resource = {} } = {}) {
    requireExperimental(this.featureFlags, "capabilities");
    const [encoded, signature] = String(token ?? "").split("."); const expected = createHmac("sha256", this.key).update(encoded ?? "").digest("base64url");
    if (!encoded || signature !== expected) throw new OdinnRuntimeError("CAPABILITY_DENIED", "invalid capability signature");
    const claims = parse(Buffer.from(encoded, "base64url").toString("utf8"), null); if (!claims) throw new OdinnRuntimeError("CAPABILITY_DENIED", "invalid capability claims");
    const row = this.ledger.database.db.prepare("SELECT * FROM capabilities WHERE id = ?").get(claims.id);
    if (!row || row.run_id !== runId || row.tool_name !== toolName) throw new OdinnRuntimeError("CAPABILITY_SCOPE_MISMATCH", "capability is not valid for this run or tool");
    if (Date.now() >= Date.parse(row.expires_at)) throw new OdinnRuntimeError("CAPABILITY_EXPIRED", "capability expired");
    if (row.uses >= row.max_uses) throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability use limit exceeded");
    if (row.status !== "active") throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability is not active");
    const constraints = parse(row.constraints_json, {}); for (const [key, expectedValue] of Object.entries(constraints)) if (Array.isArray(expectedValue) ? !expectedValue.includes(resource[key]) : resource[key] !== expectedValue) throw new OdinnRuntimeError("CAPABILITY_SCOPE_MISMATCH", `resource constraint mismatch: ${key}`);
    this.ledger.database.transaction((db) => { db.prepare("UPDATE capabilities SET uses = uses + 1, status = CASE WHEN uses + 1 >= max_uses THEN 'consumed' ELSE status END WHERE id = ?").run(claims.id); db.prepare("INSERT INTO capability_uses(id, capability_id, run_id, tool_name, resource_json, used_at, ok) VALUES (?, ?, ?, ?, ?, ?, 1)").run(randomUUID(), claims.id, runId, toolName, json(redact(resource)), now()); });
    this.ledger.appendEvent({ runId, type: "capability-consumed", payload: { capabilityId: claims.id, toolName, resource: redact(resource) } });
    return claims;
  }
  revoke(id) { this.ledger.database.db.prepare("UPDATE capabilities SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now(), id); return this.ledger.database.db.prepare("SELECT id, run_id, tool_name, status, revoked_at FROM capabilities WHERE id = ?").get(id); }
  list(runId) { return this.ledger.database.db.prepare("SELECT id, run_id, step_id, tool_name, scopes_json, constraints_json, issued_at, expires_at, max_uses, uses, status, revoked_at FROM capabilities WHERE run_id = ? ORDER BY issued_at").all(runId).map((row) => ({ ...row, scopes: parse(row.scopes_json, []), resourceConstraints: parse(row.constraints_json, {}) })); }
}

function fileDigest(path) { return existsSync(path) && lstatSync(path).isFile() ? hash(readFileSync(path)) : null; }
function walkFiles(root, current = root, output = []) { if (!existsSync(current)) return output; const st = lstatSync(current); if (st.isSymbolicLink()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "symlinks are not snapshot-safe", { path: current }); if (st.isFile()) { output.push(current); return output; } for (const entry of readdirSync(current)) walkFiles(root, join(current, entry), output); return output; }

export class SnapshotManager {
  constructor({ ledger, featureFlags = {} } = {}) { this.ledger = ledger; this.featureFlags = featureFlags; }
  create({ runId, stepId, paths = [], label, workspaceRoot = process.cwd() } = {}) {
    requireExperimental(this.featureFlags, "rewind"); const snapshotId = `snap_${randomUUID()}`; const entries = [];
    for (const relativePath of paths) { const target = safeExistingPath(workspaceRoot, relativePath); for (const path of walkFiles(workspaceRoot, target)) { const rel = relative(workspaceRoot, path); const artifact = this.ledger.artifacts.put(readFileSync(path)); entries.push({ path: rel, existed: true, mode: lstatSync(path).mode, digest: fileDigest(path), artifactDigest: artifact.digest }); } if (!existsSync(target)) entries.push({ path: relativePath, existed: false }); }
    const createdAt = now(); this.ledger.database.transaction((db) => { db.prepare("INSERT INTO snapshots(id, run_id, step_id, label, workspace_root, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(snapshotId, runId, stepId ?? null, label ?? null, resolve(workspaceRoot), json({ entries: entries.map((entry) => ({ path: entry.path, existed: entry.existed, digest: entry.digest, artifactDigest: entry.artifactDigest })) }), createdAt); for (const entry of entries) db.prepare("INSERT INTO snapshot_entries(id, snapshot_id, path, existed, mode, digest, artifact_digest) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), snapshotId, entry.path, entry.existed ? 1 : 0, entry.mode ?? null, entry.digest ?? null, entry.artifactDigest ?? null); }); this.ledger.appendEvent({ runId, type: "snapshot", payload: { snapshotId, label, entries: entries.length } }); return { snapshotId, entries };
  }
  plan(snapshotId) { const snapshot = this.ledger.database.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId); if (!snapshot) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot not found"); return { snapshotId, workspaceRoot: snapshot.workspace_root, entries: this.ledger.database.db.prepare("SELECT * FROM snapshot_entries WHERE snapshot_id = ? ORDER BY path").all(snapshotId) }; }
  restore(snapshotId, { apply = false } = {}) { requireExperimental(this.featureFlags, "rewind"); const plan = this.plan(snapshotId); const actions = []; for (const entry of plan.entries) { const target = safeExistingPath(plan.workspaceRoot, entry.path); if (!apply) { actions.push({ path: entry.path, action: entry.existed ? "restore" : "remove" }); continue; } if (entry.existed) { const artifactPath = join(this.ledger.artifacts.root, "sha256", entry.artifact_digest.slice(0, 2), entry.artifact_digest); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(artifactPath), { mode: entry.mode ?? 0o600 }); actions.push({ path: entry.path, action: "restored" }); } else if (existsSync(target)) { rmSync(target, { recursive: true, force: true }); actions.push({ path: entry.path, action: "removed" }); } } this.ledger.appendEvent({ runId: this.ledger.database.db.prepare("SELECT run_id FROM snapshots WHERE id = ?").get(snapshotId).run_id, type: "rollback", payload: { snapshotId, applied: apply, actions } }); return { snapshotId, applied: apply, actions }; }
}

export class DarwinRouter {
  constructor({ ledger, featureFlags = {}, weights = {} } = {}) { this.ledger = ledger; this.featureFlags = featureFlags; this.weights = { verified: 0.45, reliability: 0.15, speed: 0.1, cost: 0.15, compliance: 0.15, ...weights }; }
  observe(observation) { requireExperimental(this.featureFlags, "darwin"); const item = { id: observation.id ?? randomUUID(), runId: observation.runId, providerId: observation.providerId, modelId: observation.modelId, taskClass: observation.taskClass ?? "general", verified: Boolean(observation.verified), partiallyVerified: Boolean(observation.partiallyVerified), costUsd: observation.costUsd ?? null, durationMs: Number(observation.durationMs ?? 0), toolCalls: Number(observation.toolCalls ?? 0), toolErrors: Number(observation.toolErrors ?? 0), retries: Number(observation.retries ?? 0), policyViolations: Number(observation.policyViolations ?? 0), rolledBack: Boolean(observation.rolledBack), createdAt: now() }; this.ledger.database.db.prepare("INSERT INTO model_observations(id, run_id, provider_id, model_id, task_class, verified, partially_verified, cost_usd, duration_ms, tool_calls, tool_errors, retries, policy_violations, rolled_back, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(item.id, item.runId, item.providerId, item.modelId, item.taskClass, item.verified ? 1 : 0, item.partiallyVerified ? 1 : 0, item.costUsd, item.durationMs, item.toolCalls, item.toolErrors, item.retries, item.policyViolations, item.rolledBack ? 1 : 0, item.createdAt); return item; }
  stats(taskClass = "general") { requireExperimental(this.featureFlags, "darwin"); const rows = this.ledger.database.db.prepare("SELECT provider_id, model_id, AVG(verified) verified, AVG(tool_errors = 0) reliability, AVG(duration_ms) duration, AVG(COALESCE(cost_usd, 0)) cost, AVG(policy_violations = 0) compliance, COUNT(*) observations FROM model_observations WHERE task_class = ? GROUP BY provider_id, model_id").all(taskClass); const maxDuration = Math.max(...rows.map((row) => Number(row.duration)), 1); const maxCost = Math.max(...rows.map((row) => Number(row.cost)), 0.000001); return rows.map((row) => ({ ...row, score: Number(row.verified) * this.weights.verified + Number(row.reliability) * this.weights.reliability + (1 - Number(row.duration) / maxDuration) * this.weights.speed + (1 - Number(row.cost) / maxCost) * this.weights.cost + Number(row.compliance) * this.weights.compliance, uncertaintyPenalty: 1 / Math.max(Number(row.observations), 1) })); }
  choose(taskClass = "general", { pinnedModel } = {}) { if (pinnedModel) return { model: pinnedModel, reason: "user-pinned model" }; const stats = this.stats(taskClass).map((row) => ({ ...row, adjustedScore: row.score - row.uncertaintyPenalty })); stats.sort((a, b) => b.adjustedScore - a.adjustedScore); if (!stats[0]) throw new OdinnRuntimeError("MODEL_ROUTING_UNAVAILABLE", "no observations for task class", { taskClass }); return { model: `${stats[0].provider_id}:${stats[0].model_id}`, taskClass, score: stats[0].adjustedScore, explanation: `selected from ${stats[0].observations} observed runs; verified=${Number(stats[0].verified).toFixed(2)}, reliability=${Number(stats[0].reliability).toFixed(2)}`, candidates: stats };
  }
}

export class CapsuleManager {
  constructor({ ledger, stateDir, featureFlags = {} } = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; this.root = join(this.stateDir, "capsules"); mkdirSync(this.root, { recursive: true }); }
  async export(runId, { output, contract, policy, replayMode = "verification-only" } = {}) {
    requireExperimental(this.featureFlags, "capsules");
    if (!output) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output is required");
    const run = this.ledger.getRun(runId); if (!run) throw new OdinnRuntimeError("CAPSULE_INVALID", "run not found", { runId });
    const destination = resolve(output); const staging = join(this.root, `.staging-${randomUUID()}`); mkdirSync(join(staging, "artifacts"), { recursive: true }); mkdirSync(join(staging, "verification"), { recursive: true });
    const manifest = { formatVersion: 1, odinnVersion: "0.1.0", runId, createdAt: now(), sourcePlatform: `${process.platform}-${process.arch}`, model: { provider: run.providerId, modelId: run.modelId }, replayMode, redactions: ["api keys", "tokens", "cookies", "authorization headers"], requiredSecrets: [], checksumsFile: "checksums.sha256" };
    writeFileSync(join(staging, "manifest.json"), `${json(manifest)}\n`); writeFileSync(join(staging, "run.json"), `${json(redact(run))}\n`); writeFileSync(join(staging, "events.jsonl"), `${(run.events ?? []).map((event) => json(redact(event))).join("\n")}\n`); if (contract) writeFileSync(join(staging, "contract.json"), `${json(redact(contract))}\n`); if (policy) writeFileSync(join(staging, "policy.json"), `${json(redact(policy))}\n`);
    const files = []; for (const name of readdirSync(staging, { recursive: true })) { if (name === "checksums.sha256") continue; const file = join(staging, name); if (lstatSync(file).isFile()) files.push(name.replaceAll("\\", "/")); }
    writeFileSync(join(staging, "checksums.sha256"), `${files.map((name) => `${hash(readFileSync(join(staging, name)))}  ${name}`).join("\n")}\n`); mkdirSync(dirname(destination), { recursive: true }); const zipped = await runProcess("zip", ["-q", "-r", destination, "."], { cwd: staging, timeoutMs: 120_000 }); if (zipped.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", `zip failed: ${zipped.stderr}`);
    const digest = hash(readFileSync(destination)); this.ledger.database.db.prepare("INSERT OR REPLACE INTO capsules(id, run_id, path, manifest_json, digest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`capsule_${randomUUID()}`, runId, destination, json(manifest), digest, now()); this.ledger.appendEvent({ runId, type: "artifact-created", payload: { kind: "capsule", path: destination, digest } }); await rm(staging, { recursive: true, force: true }); return { path: destination, digest, manifest };
  }
  async verify(path) {
    requireExperimental(this.featureFlags, "capsules");
    const archive = resolve(path); if (!existsSync(archive)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule not found"); const recorded = this.ledger.database.db.prepare("SELECT digest FROM capsules WHERE path = ? ORDER BY created_at DESC LIMIT 1").get(archive); if (recorded && recorded.digest !== hash(readFileSync(archive))) throw new OdinnRuntimeError("CAPSULE_TAMPERED", "capsule archive digest changed", { path: archive });
    const listing = await runProcess("unzip", ["-Z1", archive], { timeoutMs: 30_000 }); if (listing.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "invalid capsule archive");
    const names = listing.stdout.split(/\r?\n/).filter(Boolean); for (const name of names) if (name.startsWith("/") || name.includes("..") || /^[A-Za-z]:/.test(name)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule contains unsafe path", { name });
    const staging = join(this.root, `.verify-${randomUUID()}`); mkdirSync(staging, { recursive: true }); const extracted = await runProcess("unzip", ["-q", archive, "-d", staging], { timeoutMs: 60_000 }); if (extracted.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule extraction failed");
    const manifest = parse(readFileSync(join(staging, "manifest.json"), "utf8"), null); if (!manifest || manifest.formatVersion !== 1) throw new OdinnRuntimeError("CAPSULE_INVALID", "unsupported capsule version"); const checksums = readFileSync(join(staging, "checksums.sha256"), "utf8").split(/\r?\n/).filter(Boolean); const failures = []; for (const line of checksums) { const match = line.match(/^([a-f0-9]{64})  (.+)$/); if (!match || !names.includes(match[2]) || !existsSync(join(staging, match[2])) || hash(readFileSync(join(staging, match[2]))) !== match[1]) failures.push(match?.[2] ?? line); } await rm(staging, { recursive: true, force: true }); if (failures.length) throw new OdinnRuntimeError("CAPSULE_TAMPERED", "capsule checksum verification failed", { failures }); return { valid: true, manifest, entries: names };
  }
  async replay(path, { mode = "verification-only", workspace } = {}) { const verified = await this.verify(path); if (!['verification-only', 'tool-mocked', 'full'].includes(mode)) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", `unsupported replay mode: ${mode}`); if (mode === "full" && !workspace) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", "full replay requires a disposable workspace"); return { ...verified, mode, executed: false, message: mode === "verification-only" ? "capsule integrity verified; acceptance replay requires a supplied contract" : "recorded replay boundaries loaded; external tools were not executed" }; }
}

export class CounterfactualManager {
  constructor({ ledger, stateDir, featureFlags = {} } = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; }
  async create({ sourceRunId, sourceStepId, plans = [], workspaceRoot = process.cwd() } = {}) {
    requireExperimental(this.featureFlags, "counterfactual"); if (!plans.length || plans.length > 4) throw new OdinnRuntimeError("BUDGET_EXCEEDED", "counterfactual plans must contain 1-4 candidates"); const groupId = `cf_${randomUUID()}`; this.ledger.database.db.prepare("INSERT INTO counterfactual_groups(id, source_run_id, status, created_at) VALUES (?, ?, 'created', ?)").run(groupId, sourceRunId, now()); const candidates = [];
    for (const plan of plans) { if (!plan?.id || !plan.title || !plan.summary) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual plans require id, title, and summary"); const runId = `run_${randomUUID()}`; const branchRoot = join(dirname(resolve(workspaceRoot)), `.odinn-worktrees`, groupId, plan.id); mkdirSync(dirname(branchRoot), { recursive: true }); await cp(workspaceRoot, branchRoot, { recursive: true, filter: (source) => !source.includes(`${sep}.odinn${sep}`) }); this.ledger.ensureRun({ runId, parentRunId: sourceRunId, branchPointStepId: sourceStepId, objective: plan.summary, workspaceRoot: branchRoot }); this.ledger.database.db.prepare("INSERT INTO run_branches(id, source_run_id, source_step_id, child_run_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`branch_${randomUUID()}`, sourceRunId, sourceStepId, runId, plan.title, now()); this.ledger.database.db.prepare("INSERT INTO counterfactual_candidates(id, group_id, run_id, plan_json, status) VALUES (?, ?, ?, ?, 'created')").run(`candidate_${randomUUID()}`, groupId, runId, json(redact(plan))); candidates.push({ runId, plan, workspaceRoot: branchRoot }); }
    this.ledger.appendEvent({ runId: sourceRunId, type: "branch-created", payload: { groupId, candidates: candidates.map((candidate) => ({ runId: candidate.runId, title: candidate.plan.title })) } }); return { groupId, candidates };
  }
  compare(groupId) { requireExperimental(this.featureFlags, "counterfactual"); const rows = this.ledger.database.db.prepare("SELECT c.*, r.status, r.workspace_root FROM counterfactual_candidates c JOIN runs r ON r.id = c.run_id WHERE c.group_id = ? ORDER BY c.id").all(groupId); return { groupId, candidates: rows.map((row) => ({ ...row, plan: parse(row.plan_json), proof: this.ledger.database.db.prepare("SELECT status, COUNT(*) count FROM assertion_results WHERE run_id = ? GROUP BY status").all(row.run_id) })) }; }
  select(groupId, runId) { requireExperimental(this.featureFlags, "counterfactual"); const candidate = this.ledger.database.db.prepare("SELECT * FROM counterfactual_candidates WHERE group_id = ? AND run_id = ?").get(groupId, runId); if (!candidate) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual candidate not found"); this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = CASE WHEN run_id = ? THEN 'selected' ELSE 'discarded' END, selected_at = CASE WHEN run_id = ? THEN ? ELSE selected_at END WHERE group_id = ?").run(runId, runId, now(), groupId); this.ledger.database.db.prepare("UPDATE counterfactual_groups SET status = 'selected' WHERE id = ?").run(groupId); return { groupId, runId, selected: true }; }
}

export function createDifferentiatedRuntime({ stateDir = ".odinn", workspaceRoot = process.cwd(), featureFlags = {} } = {}) {
  const ledger = createRunLedger({ stateDir, workspaceRoot, featureFlags });
  return { ledger, proof: new ProofEngine({ ledger, featureFlags }), sentinel: new Sentinel({ ledger, featureFlags }), capabilities: new CapabilityBroker({ ledger, stateDir, featureFlags }), snapshots: new SnapshotManager({ ledger, featureFlags }), capsules: new CapsuleManager({ ledger, stateDir, featureFlags }), counterfactual: new CounterfactualManager({ ledger, stateDir, featureFlags }), darwin: new DarwinRouter({ ledger, featureFlags }) };
}
