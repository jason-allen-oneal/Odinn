import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, stat, lstat, rm, cp } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRunLedger, redact } from "./run-ledger.ts";
import { ProofVerifier } from "./proof.ts";

type AnyRecord = Record<string, any>;
type FeatureFlags = Record<string, boolean>;
const failureMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export const ODINN_ERROR_CODES = Object.freeze([
  "POLICY_VIOLATION", "CAPABILITY_DENIED", "CAPABILITY_EXPIRED", "CAPABILITY_SCOPE_MISMATCH",
  "VERIFICATION_FAILED", "SNAPSHOT_FAILED", "ROLLBACK_CONFLICT", "COMPENSATION_FAILED",
  "CAPSULE_INVALID", "CAPSULE_TAMPERED", "REPLAY_UNSUPPORTED", "BUDGET_EXCEEDED",
  "WORKSPACE_CONFLICT", "MODEL_ROUTING_UNAVAILABLE"
]);

export class OdinnRuntimeError extends Error {
  readonly code: string;
  readonly details: AnyRecord;
  constructor(code: string, message: string, details: AnyRecord = {}) {
    super(message);
    this.name = "OdinnRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function now() { return new Date().toISOString(); }
function json(value: unknown) { return JSON.stringify(value); }
function containsRedaction(value: unknown): boolean {
  if (typeof value === "string") return value.includes("[redacted");
  if (Array.isArray(value)) return value.some(containsRedaction);
  if (value && typeof value === "object") return Object.values(value).some(containsRedaction);
  return false;
}
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function parse(value: string | undefined | null, fallback: any = {}): any { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function odinnVersion() {
  const configured = process.env.ODINN_VERSION?.trim();
  if (configured) return configured;
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    if (typeof manifest.version === "string" && manifest.version.trim()) return manifest.version.trim();
  } catch {}
  return "unknown";
}
function requireExperimental(flags: FeatureFlags, name: string) {
  if (flags?.[name] !== true) throw new OdinnRuntimeError("POLICY_VIOLATION", `experimental.${name} is disabled`, { feature: name });
}
function safePath(root: string, candidate: string) {
  const base = resolve(root);
  const target = resolve(base, candidate);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new OdinnRuntimeError("POLICY_VIOLATION", "path escapes allowed root", { path: candidate });
  return target;
}
function safeExistingPath(root: string, candidate: string) {
  const base = resolve(root);
  const target = safePath(base, candidate);
  let cursor = target;
  while (cursor !== base && !existsSync(cursor)) cursor = dirname(cursor);
  const real = resolve(realpathSync(cursor));
  const physicalBase = resolve(realpathSync(base));
  if (real !== physicalBase && !real.startsWith(`${physicalBase}${sep}`)) throw new OdinnRuntimeError("POLICY_VIOLATION", "symlink escapes allowed root", { path: candidate });
  return target;
}

function isWithin(root: string, target: string) {
  const base = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === base || resolvedTarget.startsWith(`${base}${sep}`);
}

function isPlainRecord(value: unknown): value is AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLoopbackUrl(value: string) {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// Minimal JSON/YAML-shaped loader: JSON is canonical; simple YAML is accepted for
// contracts and policies so the CLI remains dependency-free and rejects ambiguous input.
export function parseStructuredDocument(source: string, label = "document"): AnyRecord {
  try { return JSON.parse(source); } catch {}
  const lines = String(source).split(/\r?\n/).map((line) => { const comment = line.indexOf(" #"); return comment === -1 ? line : line.slice(0, comment); }).filter((line) => line.trim());
  const root: AnyRecord = {};
  let currentList: any[] | undefined;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ")) {
      if (!currentList) throw new OdinnRuntimeError("CAPSULE_INVALID", `${label} YAML list has no parent`);
      const item = trimmed.slice(2).trimStart();
      if (item.includes(": ")) { const [key, ...rest] = item.split(": "); currentList.push({ [key.trim()]: scalar(rest.join(": ").trim()) }); }
      else currentList.push(scalar(item));
      continue;
    }
    const colon = line.indexOf(":");
    const key = colon === -1 ? "" : line.slice(0, colon).trim();
    const raw = colon === -1 ? "" : line.slice(colon + 1).trim();
    if (!key || [...key].some((character) => !/[A-Za-z0-9_.-]/.test(character))) throw new OdinnRuntimeError("CAPSULE_INVALID", `${label} must be JSON or simple YAML`);
    if (!raw) { root[key] = []; currentList = root[key]; }
    else { root[key] = scalar(raw); currentList = undefined; }
  }
  return root;
}
function scalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") || value.startsWith("{")) { try { return JSON.parse(value); } catch {} }
  return value;
}

export function validateContract(contract: unknown): AnyRecord {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract must be an object");
  const value = contract as AnyRecord;
  if (value.version !== 1) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract version must be 1");
  if (typeof value.goal !== "string" || !value.goal.trim()) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract goal is required");
  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract acceptance must contain assertions");
  const ids = new Set<string>();
  for (const assertion of value.acceptance) {
    if (!assertion || typeof assertion.id !== "string" || ids.has(assertion.id)) throw new OdinnRuntimeError("CAPSULE_INVALID", "assertion ids must be unique");
    ids.add(assertion.id);
    if (!["command", "file", "http", "git"].includes(assertion.type)) throw new OdinnRuntimeError("CAPSULE_INVALID", `unsupported assertion type: ${assertion.type}`);
    if (assertion.type === "command" && (typeof assertion.command !== "string" || !Array.isArray(assertion.args ?? []))) throw new OdinnRuntimeError("CAPSULE_INVALID", `command assertion ${assertion.id} requires command and args`);
    if (assertion.type === "file" && typeof assertion.path !== "string") throw new OdinnRuntimeError("CAPSULE_INVALID", `file assertion ${assertion.id} requires path`);
    if (assertion.type === "http") {
      if (typeof assertion.url !== "string") throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} requires url`);
      let parsedUrl;
      try { parsedUrl = new URL(assertion.url); } catch { throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} requires a valid URL`); }
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.hash) throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} URL is not safe`);
      if (assertion.method !== undefined && !['GET', 'HEAD'].includes(String(assertion.method).toUpperCase())) throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} method must be GET or HEAD`);
      if (!Number.isInteger(assertion.expect?.status) || assertion.expect.status < 100 || assertion.expect.status > 599) throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} requires an HTTP status expectation`);
    }
  }
  return value;
}

export function validatePolicy(policy: unknown): AnyRecord {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy must be an object");
  const value = policy as AnyRecord;
  if (value.version !== 1) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy version must be 1");
  if (!Array.isArray(value.invariants)) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy invariants must be an array");
  const ids = new Set<string>();
  for (const item of value.invariants) {
    if (!isPlainRecord(item) || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy invariant ids must be unique non-empty strings");
    ids.add(item.id);
    if (!["command.deny-pattern", "tool.requires-approval", "filesystem.allowed-roots"].includes(item.type)) throw new OdinnRuntimeError("POLICY_VIOLATION", `unsupported policy invariant type: ${String(item.type ?? "missing")}`);
    if (!Array.isArray(item.values) || item.values.length === 0 || item.values.some((entry: unknown) => typeof entry !== "string" || !entry.trim())) throw new OdinnRuntimeError("POLICY_VIOLATION", `policy invariant ${item.id} requires non-empty string values`);
    if (!["log", "warn", "pause", "block", "rollback", "terminate"].includes(item.enforcement ?? "block")) throw new OdinnRuntimeError("POLICY_VIOLATION", `invalid enforcement for policy invariant ${item.id}`);
  }
  return value;
}

interface ProcessResult { code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
function runProcess(command: string, args: string[], { cwd, timeoutMs = 120_000 }: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolveProcess, rejectProcess) => {
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
  [key: string]: any;
  constructor({ ledger, featureFlags = {}, allowExternalHttp = false, allowedCommands = [], maxOutputBytes, maxFileBytes, commandEnvironment }: AnyRecord = {}) {
    this.ledger = ledger;
    this.featureFlags = featureFlags;
    this.allowExternalHttp = allowExternalHttp === true;
    this.verifierOptions = { allowedCommands, maxOutputBytes, maxFileBytes, commandEnvironment };
  }
  async run(runId: string, contract: AnyRecord, { workspaceRoot = process.cwd() }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "proof");
    if (contract?.schemaVersion === 1) {
      const verifierOptions = Object.fromEntries(Object.entries(this.verifierOptions).filter(([, value]) => value !== undefined));
      return new ProofVerifier({
        runLedger: this.ledger,
        ...verifierOptions,
        allowedRoot: workspaceRoot,
        allowExternalHttp: this.allowExternalHttp
      }).verify({ ...contract, runId });
    }
    validateContract(contract);
    const id = contract.id ?? `contract_${randomUUID()}`;
    const createdAt = now();
    this.ledger.database.transaction((db: any) => db.prepare("INSERT OR REPLACE INTO verification_contracts(id, run_id, version, contract_json, created_at) VALUES (?, ?, ?, ?, ?)").run(id, runId, contract.version, json(redact(contract)), createdAt));
    const results = [];
    for (const assertion of contract.acceptance) {
      const startedAt = now(); let result;
      try { result = await this.evaluate(assertion, workspaceRoot); }
      catch (error) { result = { status: "error", message: failureMessage(error), evidence: [] }; }
      const completedAt = now();
      const artifactIds: string[] = [];
      if (result.stdout || result.stderr || result.body || result.evidence) artifactIds.push(this.ledger.artifacts.putJson(redact(result)).digest);
      const row = { assertionId: assertion.id, status: result.status, startedAt, completedAt, evidenceArtifactIds: artifactIds, message: result.message ?? "", result };
      this.ledger.database.transaction((db: any) => db.prepare(`INSERT OR REPLACE INTO assertion_results(id, contract_id, run_id, assertion_id, status, started_at, completed_at, evidence_artifact_ids_json, message, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, runId, assertion.id, row.status, startedAt, completedAt, json(artifactIds), row.message, json(redact(result))));
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
  async evaluate(assertion: AnyRecord, workspaceRoot: string): Promise<AnyRecord> {
    if (assertion.type === "command") {
      throw new OdinnRuntimeError("POLICY_VIOLATION", "legacy Proof command assertions are disabled; use ProofVerifier with an operator-controlled exact command allowlist");
    }
    if (assertion.type === "file") {
      const path = safeExistingPath(workspaceRoot, assertion.path); const exists = existsSync(path); const expectExists = assertion.expect?.exists !== false;
      const content = exists && lstatSync(path).isFile() ? readFileSync(path, "utf8") : "";
      const passed = expectExists ? exists && (!assertion.expect?.contains || content.includes(assertion.expect.contains)) : !exists;
      return { status: passed ? "passed" : "failed", message: passed ? "file assertion passed" : "file assertion failed", exists, digest: exists ? hash(content) : undefined };
    }
    if (assertion.type === "http") {
      if (!this.allowExternalHttp && !isLoopbackUrl(assertion.url)) throw new OdinnRuntimeError("POLICY_VIOLATION", "external HTTP verification is disabled by default");
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
  show(runId: string) { return this.ledger.database.db.prepare("SELECT * FROM assertion_results WHERE run_id = ? ORDER BY completed_at").all(runId).map((row: AnyRecord) => ({ ...row, evidenceArtifactIds: parse(row.evidence_artifact_ids_json, []), result: parse(row.result_json) })); }
}

function policyMatch(invariant: AnyRecord, toolName: string, input: AnyRecord, workspaceRoot = process.cwd()) {
  const value = JSON.stringify(input ?? {});
  if (invariant.type === "tool.requires-approval") return (invariant.values ?? []).includes(toolName);
  if (invariant.type === "command.deny-pattern") return (invariant.values ?? []).some((pattern: string) => value.includes(pattern));
  if (invariant.type === "filesystem.allowed-roots") {
    if (!toolName.includes("write") || typeof input?.path !== "string") return false;
    const target = safePath(workspaceRoot, input.path);
    return !(invariant.values ?? []).some((root: string) => isWithin(safePath(workspaceRoot, root), target));
  }
  return false;
}

export class Sentinel {
  [key: string]: any;
  constructor({ ledger, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.featureFlags = featureFlags; }
  evaluate({ runId, stepId, toolName, input, policy, workspaceRoot = process.cwd() }: AnyRecord) {
    requireExperimental(this.featureFlags, "sentinel"); validatePolicy(policy);
    const policyId = policy.id ?? `policy_${runId}_${hash(json(redact(policy))).slice(0, 16)}`;
    this.ledger.database.db.prepare("INSERT OR IGNORE INTO policies(id, run_id, policy_json, created_at) VALUES (?, ?, ?, ?)").run(policyId, runId, json(redact(policy)), now());
    const evaluations = [];
    for (const invariant of policy.invariants) {
      const violated = policyMatch(invariant, toolName, input, workspaceRoot);
      const decision = violated ? (invariant.enforcement ?? "block") : "allow";
      const evaluation = { id: randomUUID(), runId, stepId, policyId, invariantId: invariant.id, decision, enforcement: invariant.enforcement ?? "block", reason: violated ? `invariant violated: ${invariant.id}` : "invariant satisfied", input: redact({ toolName, input }), createdAt: now() };
      this.ledger.database.db.prepare("INSERT INTO policy_evaluations(id, run_id, step_id, policy_id, invariant_id, decision, enforcement, reason, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evaluation.id, runId, stepId ?? null, evaluation.policyId, evaluation.invariantId, decision, evaluation.enforcement, evaluation.reason, json(evaluation.input), evaluation.createdAt);
      this.ledger.appendEvent({ runId, type: "policy-check", payload: evaluation }); evaluations.push(evaluation);
    }
    const blocked = evaluations.find((item) => ["block", "terminate", "rollback", "pause"].includes(item.decision));
    if (blocked) throw new OdinnRuntimeError("POLICY_VIOLATION", blocked.reason, { evaluation: blocked });
    return { allowed: true, evaluations };
  }
}

export class CapabilityBroker {
  [key: string]: any;
  constructor({ ledger, stateDir, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; this.keyPath = join(this.stateDir, "capability-signing.key"); mkdirSync(this.stateDir, { recursive: true }); this.key = this.loadKey(); }
  loadKey() { if (existsSync(this.keyPath)) return readFileSync(this.keyPath); const key = randomBytes(32); writeFileSync(this.keyPath, key, { mode: 0o600, flag: "wx" }); chmodSync(this.keyPath, 0o600); return key; }
  issue({ runId, stepId, toolName, scopes = [], resourceConstraints = {}, expiresInMs = 60_000, maxUses = 1, approvalId }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "capabilities");
    if (typeof runId !== "string" || !runId || typeof stepId !== "string" || !stepId || typeof toolName !== "string" || !toolName) throw new OdinnRuntimeError("CAPABILITY_DENIED", "runId, stepId, and toolName are required");
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string" || !scope)) throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability scopes must be non-empty strings");
    if (!Number.isInteger(expiresInMs) || expiresInMs < 1 || expiresInMs > 3_600_000) throw new OdinnRuntimeError("CAPABILITY_DENIED", "expiresInMs must be an integer from 1 through 3600000");
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) throw new OdinnRuntimeError("CAPABILITY_DENIED", "maxUses must be an integer from 1 through 100");
    const claims = { id: `cap_${randomUUID()}`, runId, stepId, toolName, scopes, resourceConstraints, issuedAt: now(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(), maxUses, approvalId, nonce: randomBytes(16).toString("hex") };
    const encoded = Buffer.from(json(claims)).toString("base64url"); const signature = createHmac("sha256", this.key).update(encoded).digest("base64url");
    this.ledger.database.db.prepare("INSERT INTO capabilities(id, run_id, step_id, tool_name, scopes_json, constraints_json, issued_at, expires_at, max_uses, nonce, approval_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')").run(claims.id, runId, stepId, toolName, json(scopes), json(resourceConstraints), claims.issuedAt, claims.expiresAt, maxUses, claims.nonce, approvalId ?? null);
    this.ledger.appendEvent({ runId, type: "capability-issued", payload: { ...claims, token: undefined } });
    return { token: `${encoded}.${signature}`, claims };
  }
  consume(token: string, { runId, toolName, resource = {} }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "capabilities");
    const [encoded, signature] = String(token ?? "").split("."); const expected = createHmac("sha256", this.key).update(encoded ?? "").digest("base64url");
    if (!encoded || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new OdinnRuntimeError("CAPABILITY_DENIED", "invalid capability signature");
    const claims = parse(Buffer.from(encoded, "base64url").toString("utf8"), null); if (!claims) throw new OdinnRuntimeError("CAPABILITY_DENIED", "invalid capability claims");
    const row = this.ledger.database.db.prepare("SELECT * FROM capabilities WHERE id = ?").get(claims.id);
    if (!row || row.run_id !== runId || row.tool_name !== toolName) throw new OdinnRuntimeError("CAPABILITY_SCOPE_MISMATCH", "capability is not valid for this run or tool");
    if (Date.now() >= Date.parse(row.expires_at)) throw new OdinnRuntimeError("CAPABILITY_EXPIRED", "capability expired");
    if (row.uses >= row.max_uses) throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability use limit exceeded");
    if (row.status !== "active") throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability is not active");
    const constraints = parse(row.constraints_json, {}); for (const [key, expectedValue] of Object.entries(constraints)) if (Array.isArray(expectedValue) ? !expectedValue.includes(resource[key]) : resource[key] !== expectedValue) throw new OdinnRuntimeError("CAPABILITY_SCOPE_MISMATCH", `resource constraint mismatch: ${key}`);
    this.ledger.database.transaction((db: any) => {
      const update = db.prepare("UPDATE capabilities SET uses = uses + 1, status = CASE WHEN uses + 1 >= max_uses THEN 'consumed' ELSE status END WHERE id = ? AND status = 'active' AND uses < max_uses").run(claims.id);
      if (Number(update.changes ?? 0) !== 1) throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability was already consumed or revoked");
      db.prepare("INSERT INTO capability_uses(id, capability_id, run_id, tool_name, resource_json, used_at, ok) VALUES (?, ?, ?, ?, ?, ?, 1)").run(randomUUID(), claims.id, runId, toolName, json(redact(resource)), now());
    });
    this.ledger.appendEvent({ runId, type: "capability-consumed", payload: { capabilityId: claims.id, toolName, resource: redact(resource) } });
    return claims;
  }
  revoke(id: string) { this.ledger.database.db.prepare("UPDATE capabilities SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now(), id); return this.ledger.database.db.prepare("SELECT id, run_id, tool_name, status, revoked_at FROM capabilities WHERE id = ?").get(id); }
  list(runId: string) { return this.ledger.database.db.prepare("SELECT id, run_id, step_id, tool_name, scopes_json, constraints_json, issued_at, expires_at, max_uses, uses, status, revoked_at FROM capabilities WHERE run_id = ? ORDER BY issued_at").all(runId).map((row: AnyRecord) => ({ ...row, scopes: parse(row.scopes_json, []), resourceConstraints: parse(row.constraints_json, {}) })); }
}

function walkFiles(root: string, current = root, output: string[] = []): string[] { if (!existsSync(current)) return output; const st = lstatSync(current); if (st.isSymbolicLink()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "symlinks are not snapshot-safe", { path: current }); if (st.isFile()) { output.push(current); return output; } for (const entry of readdirSync(current)) walkFiles(root, join(current, entry), output); return output; }
function rejectSymbolicPath(root: string, target: string) {
  const base = resolve(root);
  let cursor = resolve(target);
  while (cursor !== base && isWithin(base, cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "symlinks are not snapshot-safe", { path: relative(base, cursor) });
    cursor = dirname(cursor);
  }
}

export class SnapshotManager {
  [key: string]: any;
  constructor({ ledger, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.featureFlags = featureFlags; }
  create({ runId, stepId, paths = [], label, workspaceRoot = process.cwd() }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "rewind");
    if (!this.ledger.getRun(runId)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot run not found", { runId });
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || !path.trim())) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot paths must contain at least one non-empty path");
    const requestedPaths = [...new Set(paths)];
    if (requestedPaths.length !== paths.length) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot paths must be unique");
    const root = resolve(workspaceRoot);
    const snapshotId = `snap_${randomUUID()}`;
    const entriesByPath = new Map<string, AnyRecord>();
    for (const relativePath of requestedPaths) {
      const target = safeExistingPath(root, relativePath);
      if (isWithin(target, this.ledger.stateDir) || isWithin(this.ledger.stateDir, target)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot paths cannot include the Odinn state directory", { path: relativePath });
      rejectSymbolicPath(root, target);
      for (const path of walkFiles(root, target)) {
        const rel = relative(root, path);
        if (entriesByPath.has(rel)) continue;
        const bytes = readFileSync(path);
        const artifact = this.ledger.artifacts.put(bytes);
        entriesByPath.set(rel, { path: rel, existed: true, mode: lstatSync(path).mode, digest: hash(bytes), artifactDigest: artifact.digest });
      }
      if (!existsSync(target)) entriesByPath.set(relativePath, { path: relativePath, existed: false });
    }
    const entries = [...entriesByPath.values()];
    const createdAt = now(); this.ledger.database.transaction((db: any) => { db.prepare("INSERT INTO snapshots(id, run_id, step_id, label, workspace_root, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(snapshotId, runId, stepId ?? null, label ?? null, resolve(workspaceRoot), json({ entries: entries.map((entry) => ({ path: entry.path, existed: entry.existed, digest: entry.digest, artifactDigest: entry.artifactDigest })) }), createdAt); for (const entry of entries) db.prepare("INSERT INTO snapshot_entries(id, snapshot_id, path, existed, mode, digest, artifact_digest) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), snapshotId, entry.path, entry.existed ? 1 : 0, entry.mode ?? null, entry.digest ?? null, entry.artifactDigest ?? null); }); this.ledger.appendEvent({ runId, type: "snapshot", payload: { snapshotId, label, entries: entries.length } }); return { snapshotId, entries };
  }
  plan(snapshotId: string): AnyRecord { const snapshot = this.ledger.database.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as AnyRecord | undefined; if (!snapshot) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot not found"); return { snapshotId, workspaceRoot: snapshot.workspace_root, entries: this.ledger.database.db.prepare("SELECT * FROM snapshot_entries WHERE snapshot_id = ? ORDER BY path").all(snapshotId) }; }
  restore(snapshotId: string, { apply = false }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "rewind");
    const plan = this.plan(snapshotId);
    const prepared = plan.entries.map((entry: AnyRecord) => {
      const target = safeExistingPath(plan.workspaceRoot, entry.path);
      rejectSymbolicPath(plan.workspaceRoot, target);
      if (!entry.existed) return { entry, target };
      if (typeof entry.artifact_digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.artifact_digest)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot entry has an invalid artifact digest", { path: entry.path });
      const artifactPath = join(this.ledger.artifacts.root, "sha256", entry.artifact_digest.slice(0, 2), entry.artifact_digest);
      if (!isWithin(this.ledger.artifacts.root, artifactPath) || !existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot artifact is missing", { path: entry.path, digest: entry.artifact_digest });
      const bytes = readFileSync(artifactPath);
      const actualDigest = hash(bytes);
      if (actualDigest !== entry.artifact_digest || (entry.digest && actualDigest !== entry.digest)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot artifact failed integrity verification", { path: entry.path, expected: entry.artifact_digest, actual: actualDigest });
      return { entry, target, bytes };
    });
    const actions: AnyRecord[] = [];
    for (const item of prepared) {
      const { entry, target, bytes } = item;
      if (!apply) { actions.push({ path: entry.path, action: entry.existed ? "restore" : "remove" }); continue; }
      if (entry.existed) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { mode: entry.mode ?? 0o600 });
        actions.push({ path: entry.path, action: "restored" });
      } else if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        actions.push({ path: entry.path, action: "removed" });
      }
    }
    const snapshotRow = this.ledger.database.db.prepare("SELECT run_id FROM snapshots WHERE id = ?").get(snapshotId) as AnyRecord;
    this.ledger.appendEvent({ runId: snapshotRow.run_id, type: "rollback", payload: { snapshotId, applied: apply, actions } });
    return { snapshotId, applied: apply, actions };
  }
}

export class DarwinRouter {
  [key: string]: any;
  constructor({ ledger, featureFlags = {}, weights = {} }: AnyRecord = {}) { this.ledger = ledger; this.featureFlags = featureFlags; this.weights = { verified: 0.45, reliability: 0.15, speed: 0.1, cost: 0.15, compliance: 0.15, ...weights }; }
  observe(observation: AnyRecord) { requireExperimental(this.featureFlags, "darwin"); const item = { id: observation.id ?? randomUUID(), runId: observation.runId, providerId: observation.providerId, modelId: observation.modelId, taskClass: observation.taskClass ?? "general", verified: Boolean(observation.verified), partiallyVerified: Boolean(observation.partiallyVerified), costUsd: observation.costUsd ?? null, durationMs: Number(observation.durationMs ?? 0), toolCalls: Number(observation.toolCalls ?? 0), toolErrors: Number(observation.toolErrors ?? 0), retries: Number(observation.retries ?? 0), policyViolations: Number(observation.policyViolations ?? 0), rolledBack: Boolean(observation.rolledBack), createdAt: now() }; this.ledger.database.db.prepare("INSERT INTO model_observations(id, run_id, provider_id, model_id, task_class, verified, partially_verified, cost_usd, duration_ms, tool_calls, tool_errors, retries, policy_violations, rolled_back, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(item.id, item.runId, item.providerId, item.modelId, item.taskClass, item.verified ? 1 : 0, item.partiallyVerified ? 1 : 0, item.costUsd, item.durationMs, item.toolCalls, item.toolErrors, item.retries, item.policyViolations, item.rolledBack ? 1 : 0, item.createdAt); return item; }
  stats(taskClass = "general") { requireExperimental(this.featureFlags, "darwin"); const rows = this.ledger.database.db.prepare("SELECT provider_id, model_id, AVG(verified) verified, AVG(tool_errors = 0) reliability, AVG(duration_ms) duration, AVG(COALESCE(cost_usd, 0)) cost, AVG(policy_violations = 0) compliance, COUNT(*) observations FROM model_observations WHERE task_class = ? GROUP BY provider_id, model_id").all(taskClass) as AnyRecord[]; const maxDuration = Math.max(...rows.map((row: AnyRecord) => Number(row.duration)), 1); const maxCost = Math.max(...rows.map((row: AnyRecord) => Number(row.cost)), 0.000001); return rows.map((row: AnyRecord) => ({ ...row, score: Number(row.verified) * this.weights.verified + Number(row.reliability) * this.weights.reliability + (1 - Number(row.duration) / maxDuration) * this.weights.speed + (1 - Number(row.cost) / maxCost) * this.weights.cost + Number(row.compliance) * this.weights.compliance, uncertaintyPenalty: 1 / Math.max(Number(row.observations), 1) })); }
  choose(taskClass = "general", { pinnedModel }: AnyRecord = {}) { if (pinnedModel) return { model: pinnedModel, reason: "user-pinned model" }; const stats: AnyRecord[] = this.stats(taskClass).map((row: AnyRecord) => ({ ...row, adjustedScore: row.score - row.uncertaintyPenalty })); stats.sort((a: AnyRecord, b: AnyRecord) => b.adjustedScore - a.adjustedScore); if (!stats[0]) throw new OdinnRuntimeError("MODEL_ROUTING_UNAVAILABLE", "no observations for task class", { taskClass }); return { model: `${stats[0].provider_id}:${stats[0].model_id}`, taskClass, score: stats[0].adjustedScore, explanation: `selected from ${stats[0].observations} observed runs; verified=${Number(stats[0].verified).toFixed(2)}, reliability=${Number(stats[0].reliability).toFixed(2)}`, candidates: stats };
  }
}

export class CapsuleManager {
  [key: string]: any;
  constructor({ ledger, stateDir, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; this.root = join(this.stateDir, "capsules"); mkdirSync(this.root, { recursive: true }); }
  async export(runId: string, { output, contract, policy, replayMode = "verification-only" }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "capsules");
    if (!output) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output is required");
    const run = this.ledger.getRun(runId); if (!run) throw new OdinnRuntimeError("CAPSULE_INVALID", "run not found", { runId });
    const destination = resolve(output);
    const allowedRoots = [this.root, this.ledger.workspaceRoot].map((root) => resolve(root));
    if (!allowedRoots.some((root) => destination === root || destination.startsWith(`${root}${sep}`))) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output must remain inside the workspace or .odinn/capsules directory", { output });
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output cannot be a symbolic link", { output });
    const staging = join(this.root, `.staging-${randomUUID()}`); mkdirSync(join(staging, "artifacts"), { recursive: true }); mkdirSync(join(staging, "snapshots"), { recursive: true }); mkdirSync(join(staging, "verification"), { recursive: true });
    try {
      const storedContract = this.ledger.database.db.prepare("SELECT contract_json FROM verification_contracts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId);
      const storedPolicy = this.ledger.database.db.prepare("SELECT policy_json FROM policies WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId);
      const effectiveContract = contract ?? parse(storedContract?.contract_json, null);
      const effectivePolicy = policy ?? parse(storedPolicy?.policy_json, null);
      const manifest = { formatVersion: 1, odinnVersion: odinnVersion(), runId, createdAt: now(), sourcePlatform: `${process.platform}-${process.arch}`, model: { provider: run.providerId, modelId: run.modelId }, replayMode, redactions: ["api keys", "tokens", "cookies", "authorization headers"], requiredSecrets: [], checksumsFile: "checksums.sha256" };
      writeFileSync(join(staging, "manifest.json"), `${json(manifest)}\n`);
      writeFileSync(join(staging, "run.json"), `${json(redact(run))}\n`);
      writeFileSync(join(staging, "events.jsonl"), `${(run.events ?? []).map((event: AnyRecord) => json(redact(event))).join("\n")}\n`);
      writeFileSync(join(staging, "environment.json"), `${json({ platform: process.platform, arch: process.arch, node: process.version })}\n`);
      writeFileSync(join(staging, "README.txt"), "This Odinn Forge capsule is content-addressed, redacted, and safe to inspect before replay.\n");
      if (effectiveContract) writeFileSync(join(staging, "contract.json"), `${json(redact(effectiveContract))}\n`);
      if (effectivePolicy) writeFileSync(join(staging, "policy.json"), `${json(redact(effectivePolicy))}\n`);
      const referenced = this.referencedArtifactRows(runId);
      for (const artifact of referenced) {
        const source = resolve(this.ledger.artifacts.root, artifact.path);
        if (!source.startsWith(`${resolve(this.ledger.artifacts.root)}${sep}`) || !existsSync(source)) continue;
        const target = join(staging, "artifacts", artifact.digest);
        copyFileSync(source, target);
      }
      const verification = this.ledger.database.db.prepare("SELECT * FROM assertion_results WHERE run_id = ? ORDER BY completed_at").all(runId).map((row: AnyRecord) => redact({ ...row, evidenceArtifactIds: parse(row.evidence_artifact_ids_json, []), result: parse(row.result_json) }));
      writeFileSync(join(staging, "verification", "results.json"), `${json(verification)}\n`);
      const snapshots = this.ledger.database.db.prepare("SELECT * FROM snapshots WHERE run_id = ? ORDER BY created_at").all(runId).map((row: AnyRecord) => redact({ ...row, manifest: parse(row.manifest_json, {}) }));
      writeFileSync(join(staging, "snapshots", "index.json"), `${json(snapshots)}\n`);
      const files: string[] = []; for (const entryName of readdirSync(staging, { recursive: true })) { const name = String(entryName); if (name === "checksums.sha256") continue; const file = join(staging, name); if (lstatSync(file).isFile()) files.push(name.replaceAll("\\", "/")); }
      writeFileSync(join(staging, "checksums.sha256"), `${files.sort().map((name) => `${hash(readFileSync(join(staging, name)))}  ${name}`).join("\n")}\n`);
      mkdirSync(dirname(destination), { recursive: true });
      const zipped = await runProcess("zip", ["-q", "-r", destination, "."], { cwd: staging, timeoutMs: 120_000 });
      if (zipped.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", `zip failed: ${zipped.stderr}`);
      const digest = hash(readFileSync(destination)); this.ledger.database.db.prepare("INSERT OR REPLACE INTO capsules(id, run_id, path, manifest_json, digest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`capsule_${randomUUID()}`, runId, destination, json(manifest), digest, now()); this.ledger.appendEvent({ runId, type: "artifact-created", payload: { kind: "capsule", path: destination, digest } }); return { path: destination, digest, manifest };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  referencedArtifactRows(runId: string) {
    const digests = new Set();
    const run = this.ledger.getRun(runId);
    for (const event of run?.events ?? []) for (const key of ["inputDigest", "outputDigest", "contractDigest"]) if (typeof event.payload?.[key] === "string") digests.add(event.payload[key]);
    for (const row of this.ledger.database.db.prepare("SELECT evidence_artifact_ids_json FROM assertion_results WHERE run_id = ?").all(runId)) for (const digest of parse(row.evidence_artifact_ids_json, [])) if (typeof digest === "string") digests.add(digest);
    for (const row of this.ledger.database.db.prepare("SELECT se.artifact_digest FROM snapshot_entries se JOIN snapshots s ON s.id = se.snapshot_id WHERE s.run_id = ? AND se.artifact_digest IS NOT NULL").all(runId)) digests.add(row.artifact_digest);
    return [...digests].map((digest) => this.ledger.database.db.prepare("SELECT digest, path FROM artifacts WHERE digest = ?").get(digest)).filter(Boolean);
  }
  async verify(path: string) {
    requireExperimental(this.featureFlags, "capsules");
    const archive = resolve(path);
    if (!existsSync(archive)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule not found");
    const recorded = this.ledger.database.db.prepare("SELECT digest FROM capsules WHERE path = ? ORDER BY created_at DESC LIMIT 1").get(archive);
    if (recorded && recorded.digest !== hash(readFileSync(archive))) throw new OdinnRuntimeError("CAPSULE_TAMPERED", "capsule archive digest changed", { path: archive });
    const listing = await runProcess("unzip", ["-Z1", archive], { timeoutMs: 30_000 });
    if (listing.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "invalid capsule archive");
    const names = listing.stdout.split(/\r?\n/).filter(Boolean);
    const normalizedNames = names.map((name) => name.replaceAll("\\", "/"));
    const seenNames = new Set<string>();
    for (const name of normalizedNames) {
      const segments = name.split("/").filter(Boolean);
      if (!name || name.startsWith("/") || name.includes("\0") || /^[A-Za-z]:/.test(name) || segments.some((segment) => segment === "." || segment === "..") || seenNames.has(name)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule contains an unsafe or duplicate path", { name });
      seenNames.add(name);
    }
    const staging = join(this.root, `.verify-${randomUUID()}`);
    mkdirSync(staging, { recursive: true });
    try {
      const extracted = await runProcess("unzip", ["-q", archive, "-d", staging], { timeoutMs: 60_000 });
      if (extracted.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule extraction failed");
      for (const name of normalizedNames) {
        const target = join(staging, name);
        if (!existsSync(target)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule entry was not extracted", { name });
        if (lstatSync(target).isSymbolicLink()) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule contains a symbolic link", { name });
      }
      const required = ["manifest.json", "run.json", "events.jsonl", "environment.json", "checksums.sha256"];
      for (const name of required) if (!seenNames.has(name)) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule is missing ${name}`);
      const manifest = parse(readFileSync(join(staging, "manifest.json"), "utf8"), null);
      if (!manifest || manifest.formatVersion !== 1) throw new OdinnRuntimeError("CAPSULE_INVALID", "unsupported capsule version");
      const checksumLines = readFileSync(join(staging, "checksums.sha256"), "utf8").split(/\r?\n/).filter(Boolean);
      const checksummed = new Set<string>();
      const failures: string[] = [];
      for (const line of checksumLines) {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/);
        const name = match?.[2]?.replaceAll("\\", "/");
        if (!match || !name || checksummed.has(name) || !seenNames.has(name) || name === "checksums.sha256" || !existsSync(join(staging, name)) || !lstatSync(join(staging, name)).isFile() || hash(readFileSync(join(staging, name))) !== match[1]) failures.push(name ?? line);
        else checksummed.add(name);
      }
      const expectedFiles = normalizedNames.filter((name) => name !== "checksums.sha256" && existsSync(join(staging, name)) && lstatSync(join(staging, name)).isFile());
      for (const name of expectedFiles) if (!checksummed.has(name)) failures.push(name);
      if (failures.length) throw new OdinnRuntimeError("CAPSULE_TAMPERED", "capsule checksum verification failed", { failures: [...new Set(failures)] });
      return { valid: true, manifest, entries: normalizedNames };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async replay(path: string, { mode = "verification-only", workspace, executor, approveExternal = false }: AnyRecord = {}) {
    const verified = await this.verify(path);
    if (!["verification-only", "tool-mocked", "full"].includes(mode)) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", `unsupported replay mode: ${mode}`);
    if (mode === "full") {
      if (!workspace) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", "full replay requires a disposable workspace");
      if (typeof executor !== "function") throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", "full replay requires an audited task executor");
      const target = resolve(workspace);
      if (target === resolve(this.ledger.workspaceRoot)) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", "full replay refuses the original workspace");
      mkdirSync(target, { recursive: true });
      const runJson = await runProcess("unzip", ["-p", resolve(path), "run.json"], { timeoutMs: 30_000 });
      const eventsJson = await runProcess("unzip", ["-p", resolve(path), "events.jsonl"], { timeoutMs: 30_000 });
      if (runJson.code !== 0 || eventsJson.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule is missing replay metadata");
      const sourceRun = parse(runJson.stdout, null);
      const requests = eventsJson.stdout.split(/\r?\n/).filter(Boolean).map((line) => parse(line, null)).filter((event) => event?.type === "tool-request");
      const replayRunId = `replay_${randomUUID()}`;
      this.ledger.ensureRun({ runId: replayRunId, objective: `full replay of ${sourceRun?.id ?? verified.manifest.runId}`, workspaceRoot: target });
      this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-started", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, mode, taskCount: requests.length } });
      const results = [];
      for (let index = 0; index < requests.length; index += 1) {
        const event = requests[index];
        const tool = event.payload?.toolName;
        const digest = event.payload?.inputDigest;
        if (!tool || !digest) throw new OdinnRuntimeError("CAPSULE_INVALID", "recorded tool request is missing replay metadata");
        const artifact = await runProcess("unzip", ["-p", resolve(path), `artifacts/${digest}`], { timeoutMs: 30_000 });
        if (artifact.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule is missing input artifact ${digest}`);
        if (hash(artifact.stdout) !== digest) throw new OdinnRuntimeError("CAPSULE_TAMPERED", `tool ${tool} input artifact does not match its digest`);
        const input = parse(artifact.stdout, null);
        if (!isPlainRecord(input) || containsRedaction(input)) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", `tool ${tool} requires redacted, missing, or invalid input`);
        const safety = event.payload?.safety ?? {};
        const external = safety.reversibility === "irreversible" || (safety.effects ?? []).some((effect: string) => ["network", "credential", "external-state"].includes(effect));
        if (external && approveExternal !== true) throw new OdinnRuntimeError("CAPABILITY_DENIED", `full replay of external tool ${tool} requires explicit approval`);
        const result = await executor({ tool, input, external, replayRunId, stepIndex: index, workspaceRoot: target, sourceEvent: event });
        results.push({ tool, external, result: redact(result) });
        this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-action", payload: { sourceEventId: event.id, tool, external, result: redact(result) } });
      }
      this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-completed", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, taskCount: results.length } });
      this.ledger.database.db.prepare("UPDATE runs SET status = 'completed-unverified', completed_at = ? WHERE id = ?").run(now(), replayRunId);
      return { ...verified, mode, executed: true, replayRunId, results, message: "recorded actions re-executed through the audited runtime in a disposable workspace" };
    }
    if (mode === "verification-only") return { ...verified, mode, executed: false, contractIncluded: verified.entries.includes("contract.json"), message: "capsule integrity verified; run the included contract against a supplied workspace" };

    const runJson = await runProcess("unzip", ["-p", resolve(path), "run.json"], { timeoutMs: 30_000 });
    const eventsJson = await runProcess("unzip", ["-p", resolve(path), "events.jsonl"], { timeoutMs: 30_000 });
    if (runJson.code !== 0 || eventsJson.code !== 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule is missing replay metadata");
    const sourceRun = parse(runJson.stdout, null);
    const recordedEvents = eventsJson.stdout.split(/\r?\n/).filter(Boolean).map((line) => parse(line, null)).filter(Boolean);
    const replayRunId = `replay_${randomUUID()}`;
    this.ledger.ensureRun({ runId: replayRunId, objective: `tool-mocked replay of ${sourceRun?.id ?? verified.manifest.runId}`, modelId: verified.manifest.model?.modelId ?? "", providerId: verified.manifest.model?.provider ?? "", workspaceRoot: workspace ? resolve(workspace) : this.ledger.workspaceRoot });
    this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-started", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, mode, eventCount: recordedEvents.length } });
    for (const event of recordedEvents) this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-boundary", payload: { sourceEventId: event.id, sourceType: event.type, payload: redact(event.payload ?? event.data ?? {}) } });
    this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-completed", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, boundaryCount: recordedEvents.length } });
    this.ledger.database.db.prepare("UPDATE runs SET status = 'completed-unverified', completed_at = ? WHERE id = ?").run(now(), replayRunId);
    return { ...verified, mode, executed: true, replayRunId, boundaryCount: recordedEvents.length, message: "recorded model and tool boundaries replayed without executing external tools" };
  }
}

async function copyWorkspaceTree(sourceRoot: string, destinationRoot: string) {
  const excluded = new Set([
    ".git", ".odinn", ".odinn-worktrees", ".cache", ".next", ".pnpm-store",
    ".turbo", "build", "coverage", "dist", "node_modules"
  ]);
  await mkdir(destinationRoot, { recursive: true });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    await cp(join(sourceRoot, entry.name), join(destinationRoot, entry.name), { recursive: true });
  }
}

function validateCounterfactualPlans(plans: unknown): AnyRecord[] {
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 4) throw new OdinnRuntimeError("BUDGET_EXCEEDED", "counterfactual plans must contain 1-4 candidates");
  const ids = new Set<string>();
  return plans.map((plan, index) => {
    if (!isPlainRecord(plan)) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${index + 1} must be an object`);
    if (typeof plan.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plan.id)) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${index + 1} has an unsafe id`);
    if (ids.has(plan.id)) throw new OdinnRuntimeError("CAPSULE_INVALID", `duplicate counterfactual plan id: ${plan.id}`);
    ids.add(plan.id);
    if (typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 256 || typeof plan.summary !== "string" || !plan.summary.trim() || plan.summary.length > 4_096) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${plan.id} requires a bounded title and summary`);
    return plan;
  });
}

export class CounterfactualManager {
  [key: string]: any;
  constructor({ ledger, stateDir, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; }
  async create({ sourceRunId, sourceStepId, plans = [], workspaceRoot = process.cwd() }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "counterfactual");
    const normalizedPlans = validateCounterfactualPlans(plans);
    if (typeof sourceRunId !== "string" || !sourceRunId || typeof sourceStepId !== "string" || !sourceStepId) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual sourceRunId and sourceStepId are required");
    const sourceRun = this.ledger.getRun(sourceRunId);
    if (!sourceRun) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual source run not found", { sourceRunId });
    const sourceRoot = resolve(workspaceRoot);
    const expectedRoot = resolve(sourceRun.workspaceRoot);
    if (sourceRoot !== expectedRoot) throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "counterfactual workspace must match the source run workspace", { expectedRoot, requestedRoot: sourceRoot });
    const groupId = `cf_${randomUUID()}`;
    const groupRoot = resolve(sourceRoot, ".odinn-worktrees", groupId);
    const candidates: AnyRecord[] = [];
    const createdRunIds: string[] = [];
    this.ledger.database.db.prepare("INSERT INTO counterfactual_groups(id, source_run_id, status, created_at) VALUES (?, ?, 'created', ?)").run(groupId, sourceRunId, now());
    try {
      for (const plan of normalizedPlans) {
        const runId = `run_${randomUUID()}`;
        const branchRoot = resolve(groupRoot, plan.id);
        if (!isWithin(groupRoot, branchRoot) || branchRoot === groupRoot) throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "counterfactual branch escaped its group directory", { planId: plan.id });
        await copyWorkspaceTree(sourceRoot, branchRoot);
        this.ledger.ensureRun({ runId, parentRunId: sourceRunId, branchPointStepId: sourceStepId, objective: plan.summary, workspaceRoot: branchRoot });
        createdRunIds.push(runId);
        this.ledger.database.db.prepare("INSERT INTO run_branches(id, source_run_id, source_step_id, child_run_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`branch_${randomUUID()}`, sourceRunId, sourceStepId, runId, plan.title, now());
        this.ledger.database.db.prepare("INSERT INTO counterfactual_candidates(id, group_id, run_id, plan_json, status) VALUES (?, ?, ?, ?, 'created')").run(`candidate_${randomUUID()}`, groupId, runId, json(redact(plan)));
        candidates.push({ runId, plan, workspaceRoot: branchRoot });
      }
      this.ledger.appendEvent({ runId: sourceRunId, type: "branch-created", payload: { groupId, candidates: candidates.map((candidate) => ({ runId: candidate.runId, title: candidate.plan.title })) } });
      return { groupId, candidates };
    } catch (error) {
      this.ledger.database.transaction((db: any) => {
        db.prepare("DELETE FROM counterfactual_candidates WHERE group_id = ?").run(groupId);
        for (const runId of createdRunIds) {
          db.prepare("DELETE FROM run_branches WHERE child_run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
        }
        db.prepare("DELETE FROM counterfactual_groups WHERE id = ?").run(groupId);
      });
      await rm(groupRoot, { recursive: true, force: true });
      throw error;
    }
  }
  async execute(groupId: string, { executor, proof, capabilities, policy, workspaceRoot = this.ledger.workspaceRoot }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "counterfactual");
    if (typeof executor !== "function") throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual execution requires an executor");
    const rows = this.ledger.database.db.prepare("SELECT c.*, r.workspace_root FROM counterfactual_candidates c JOIN runs r ON r.id = c.run_id WHERE c.group_id = ? ORDER BY c.id").all(groupId);
    if (!rows.length) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual group not found");
    const results = [];
    for (const row of rows) {
      const plan = parse(row.plan_json, {});
      const startedAt = now();
      this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = 'executing' WHERE run_id = ?").run(row.run_id);
      this.ledger.database.db.prepare("UPDATE runs SET status = 'executing', started_at = ? WHERE id = ?").run(startedAt, row.run_id);
      this.ledger.appendEvent({ runId: row.run_id, type: "counterfactual-started", payload: { groupId, planId: plan.id } });
      const taskResults = [];
      try {
        if (!Array.isArray(plan.tasks) || plan.tasks.length === 0 || plan.tasks.length > 32) {
          throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${plan.id} must contain 1-32 executable tasks`);
        }
        for (let index = 0; index < plan.tasks.length; index += 1) {
          const task = plan.tasks[index];
          const taskId = `${row.run_id}:task:${index + 1}`;
          if (!task || typeof task.tool !== "string" || !task.tool) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${plan.id} task ${index} requires a tool`);
          this.ledger.ensureRun({ runId: taskId, parentRunId: row.run_id, objective: task.reason ?? `counterfactual task ${index + 1}`, workspaceRoot: row.workspace_root });
          const executableTask = { ...task, input: { ...(task.input ?? {}) } };
          if (task.readOnly === true && capabilities && this.featureFlags.capabilities === true && !executableTask.input.capabilityToken) {
            const issued = capabilities.issue({ runId: taskId, stepId: taskId, toolName: task.tool, scopes: ["read"], expiresInMs: 300_000, maxUses: 1 });
            executableTask.input.capabilityToken = issued.token;
          }
          const result = await executor({
            ...executableTask,
            id: taskId,
            actor: "counterfactual",
            reason: `counterfactual:${groupId}:${plan.id}`
          }, { workspaceRoot: row.workspace_root, policy });
          taskResults.push(redact(result));
        }
        let proofResult;
        if (plan.contract) {
          if (!proof) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual plan includes a contract but no proof engine was supplied");
          const contract = { ...plan.contract, runId: row.run_id };
          proofResult = await proof.run(row.run_id, contract, { workspaceRoot: row.workspace_root });
          if (proofResult.status === "failed" || proofResult.passed === false) throw new OdinnRuntimeError("VERIFICATION_FAILED", `counterfactual plan ${plan.id} failed Proof verification`, { proof: proofResult });
        }
        const verified = proofResult && (proofResult.status === "passed" || proofResult.status === "verified" || proofResult.passed === true);
        const resultStatus = verified ? "verified" : proofResult?.status ?? "completed-unverified";
        this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = ? WHERE run_id = ?").run(verified ? "verified" : "completed", row.run_id);
        this.ledger.database.db.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?").run(resultStatus, now(), row.run_id);
        this.ledger.appendEvent({ runId: row.run_id, type: "counterfactual-completed", payload: { groupId, planId: plan.id, proof: resultStatus, taskCount: taskResults.length } });
        results.push({ runId: row.run_id, planId: plan.id, status: resultStatus, tasks: taskResults, proof: proofResult });
      } catch (error) {
        const failure = error instanceof OdinnRuntimeError ? error : new OdinnRuntimeError("RUNTIME_ERROR", failureMessage(error));
        this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = 'failed' WHERE run_id = ?").run(row.run_id);
        this.ledger.database.db.prepare("UPDATE runs SET status = 'failed', completed_at = ? WHERE id = ?").run(now(), row.run_id);
        this.ledger.appendEvent({ runId: row.run_id, type: "counterfactual-failed", payload: { groupId, planId: plan.id, code: failure.code, message: failure.message } });
        results.push({ runId: row.run_id, planId: plan.id, status: "failed", error: { code: failure.code, message: failure.message } });
      }
    }
    this.ledger.database.db.prepare("UPDATE counterfactual_groups SET status = 'executed' WHERE id = ?").run(groupId);
    return { groupId, results };
  }
  compare(groupId: string) { requireExperimental(this.featureFlags, "counterfactual"); const rows = this.ledger.database.db.prepare("SELECT c.*, c.status AS candidate_status, r.status AS run_status, r.workspace_root FROM counterfactual_candidates c JOIN runs r ON r.id = c.run_id WHERE c.group_id = ? ORDER BY c.id").all(groupId) as AnyRecord[]; return { groupId, candidates: rows.map((row: AnyRecord) => ({ ...row, status: row.candidate_status, runStatus: row.run_status, plan: parse(row.plan_json), proof: this.ledger.database.db.prepare("SELECT status, COUNT(*) count FROM assertion_results WHERE run_id = ? GROUP BY status").all(row.run_id) })) }; }
  async commit(groupId: string, runId: string, { apply = false }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "counterfactual");
    const candidate = this.ledger.database.db.prepare("SELECT c.*, r.workspace_root AS candidate_root, parent.workspace_root AS source_root FROM counterfactual_candidates c JOIN runs r ON r.id = c.run_id JOIN runs parent ON parent.id = (SELECT source_run_id FROM counterfactual_groups WHERE id = c.group_id) WHERE c.group_id = ? AND c.run_id = ?").get(groupId, runId) as AnyRecord | undefined;
    if (!candidate) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual candidate not found");
    if (candidate.status !== "completed" && candidate.status !== "verified" && candidate.status !== "completed-unverified") throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "only a completed candidate can be selected", { status: candidate.status });
    const sourceRoot = resolve(candidate.source_root); const candidateRoot = resolve(candidate.candidate_root);
    const internalBranchRoot = join(sourceRoot, ".odinn-worktrees");
    const authorizedInternalBranch = candidateRoot.startsWith(`${internalBranchRoot}${sep}`);
    if (sourceRoot === candidateRoot || (candidateRoot.startsWith(`${sourceRoot}${sep}`) && !authorizedInternalBranch)) throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "candidate workspace is not an authorized isolated branch");
    const actions = [{ action: "replace-workspace", source: candidateRoot, destination: sourceRoot }];
    if (!apply) return { groupId, runId, applied: false, actions, warning: "dry-run; pass --apply to replace the source workspace" };
    const backup = join(this.stateDir, "worktrees", `${groupId}-${randomUUID()}`);
    await cp(sourceRoot, backup, { recursive: true, filter: (source) => !source.includes(`${sep}.odinn${sep}`) && !source.endsWith(`${sep}.odinn`) });
    try {
      await syncWorkspace(candidateRoot, sourceRoot);
      this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = CASE WHEN run_id = ? THEN 'selected' ELSE 'discarded' END, selected_at = CASE WHEN run_id = ? THEN ? ELSE selected_at END WHERE group_id = ?").run(runId, runId, now(), groupId);
      this.ledger.database.db.prepare("UPDATE counterfactual_groups SET status = 'selected' WHERE id = ?").run(groupId);
      const sourceRunId = (this.ledger.database.db.prepare("SELECT source_run_id FROM counterfactual_groups WHERE id = ?").get(groupId) as AnyRecord | undefined)?.source_run_id;
      if (sourceRunId) this.ledger.appendEvent({ runId: sourceRunId, type: "branch-selected", payload: { groupId, runId, sourceRoot } });
      return { groupId, runId, applied: true, actions };
    } catch (error) {
      await syncWorkspace(backup, sourceRoot).catch(() => undefined);
      throw new OdinnRuntimeError("WORKSPACE_CONFLICT", `selected branch could not be applied: ${failureMessage(error)}`, { groupId, runId });
    } finally { await rm(backup, { recursive: true, force: true }); }
  }
  async select(groupId: string, runId: string, options: AnyRecord = {}) { const result = await this.commit(groupId, runId, options); if (!result.applied) return result; return { ...result, selected: true }; }
}

async function syncWorkspace(source: string, destination: string) {
  const excluded = new Set([".odinn", ".git", ".odinn-worktrees"]);
  const sourceEntries = new Set((await readdir(source, { withFileTypes: true })).filter((entry) => !excluded.has(entry.name)).map((entry) => entry.name));
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (excluded.has(entry.name) || sourceEntries.has(entry.name)) continue;
    await rm(join(destination, entry.name), { recursive: true, force: true });
  }
  for (const name of sourceEntries) {
    await rm(join(destination, name), { recursive: true, force: true });
    await cp(join(source, name), join(destination, name), { recursive: true, preserveTimestamps: true });
  }
}

export function createDifferentiatedRuntime({ stateDir = ".odinn", workspaceRoot = process.cwd(), featureFlags = {}, proofOptions = {} }: AnyRecord = {}) {
  const ledger = createRunLedger({ stateDir, workspaceRoot, featureFlags });
  return { ledger, proof: new ProofEngine({ ledger, featureFlags, ...proofOptions }), sentinel: new Sentinel({ ledger, featureFlags }), capabilities: new CapabilityBroker({ ledger, stateDir, featureFlags }), snapshots: new SnapshotManager({ ledger, featureFlags }), capsules: new CapsuleManager({ ledger, stateDir, featureFlags }), counterfactual: new CounterfactualManager({ ledger, stateDir, featureFlags }), darwin: new DarwinRouter({ ledger, featureFlags }) };
}
