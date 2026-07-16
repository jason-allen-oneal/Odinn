import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { redact } from "@odinn/store-sqlite";
import type { RunLedger } from "@odinn/store-sqlite";
import type { JsonObject } from "@odinn/protocol";
import type { DatabaseSync } from "node:sqlite";

export const PROOF_CONTRACT_SCHEMA_VERSION = 1;

const CONTRACT_KEYS = new Set(["schemaVersion", "id", "runId", "description", "assertions"]);
const COMMAND_KEYS = new Set(["id", "type", "command", "cwd", "timeoutMs", "expect"]);
const FILE_KEYS = new Set(["id", "type", "path", "expect"]);
const HTTP_KEYS = new Set(["id", "type", "url", "method", "timeoutMs", "expect"]);
const GIT_KEYS = new Set(["id", "type", "cwd", "expect"]);
const COMMAND_EXPECT_KEYS = new Set(["exitCode", "stdout", "stderr"]);
const FILE_EXPECT_KEYS = new Set(["exists", "content"]);
const HTTP_EXPECT_KEYS = new Set(["status", "body"]);
const GIT_EXPECT_KEYS = new Set(["clean"]);
const MATCHER_KEYS = new Set(["equals", "contains", "matches", "flags"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

type NodeError = Error & { code?: string };
type Matcher = { equals: string } | { contains: string } | { matches: string; flags?: string };
interface CommandAssertion { id: string; type: "command"; command: string[]; cwd?: string; timeoutMs: number; expect: { exitCode: number; stdout?: Matcher; stderr?: Matcher } }
interface FileAssertion { id: string; type: "file"; path: string; expect: { exists: boolean; content?: Matcher } }
interface HttpAssertion { id: string; type: "http"; url: string; method: "GET" | "HEAD"; timeoutMs: number; expect: { status: number; body?: Matcher } }
interface GitAssertion { id: string; type: "git"; cwd?: string; expect: { clean: boolean } }
export type ProofAssertion = CommandAssertion | FileAssertion | HttpAssertion | GitAssertion;
export interface VerificationContract { schemaVersion: number; id: string; runId: string; description?: string; assertions: ProofAssertion[] }
interface ProcessResult extends JsonObject { startedAt: string; completedAt: string; exitCode: number | null; signal?: string; stdout: string; stderr: string; timedOut: boolean; outputLimitExceeded: boolean; error?: string }
interface AssertionResult { id: string; type: ProofAssertion["type"]; status: "passed" | "failed"; passed: boolean; message: string; expected: unknown; actual: JsonObject; startedAt: string; completedAt: string }
interface StoredArtifact { digest: string; path: string; mediaType: string; sizeBytes: number }
interface ProofVerifierOptions {
  runLedger: RunLedger; allowedRoot?: string; maxOutputBytes?: number; maxFileBytes?: number;
  allowExternalHttp?: boolean; allowedCommands?: string[][]; commandEnvironment?: NodeJS.ProcessEnv;
}

const asObject = (value: unknown): JsonObject => value as JsonObject;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function isPlainObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value as object);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function assertKnownKeys(value: JsonObject, allowed: Set<string>, label: string) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new TypeError(`${label} contains unknown field: ${String(key)}`);
    if (value[key] === undefined) throw new TypeError(`${label}.${key} cannot be undefined`);
  }
}

function requiredString(value: unknown, label: string, maxLength = 1_000, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxLength || value.includes("\0")) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maxLength} characters`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const normalized = requiredString(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new TypeError(`${label} must start with an alphanumeric character and contain only letters, numbers, '.', '_', ':', or '-'`);
  }
  return normalized;
}

function optionalDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, "verification contract description", 1_000);
}

function normalizeMatcher(value: unknown, label: string): Matcher {
  assertObject(value, label);
  assertKnownKeys(value, MATCHER_KEYS, label);
  const operators = ["equals", "contains", "matches"].filter((key) => value[key] !== undefined);
  if (operators.length !== 1) throw new TypeError(`${label} must contain exactly one of: equals, contains, matches`);
  const operator = operators[0]!;
  const pattern = requiredString(value[operator], `${label}.${operator}`, operator === "matches" ? 2_000 : 100_000, operator === "equals");
  if (operator !== "matches" && value.flags !== undefined) throw new TypeError(`${label}.flags is only valid with matches`);
  if (operator === "matches") {
    const flags = value.flags === undefined ? "" : requiredString(value.flags, `${label}.flags`, 5, true);
    if (!/^(?!.*(.).*\1)[imsu]*$/.test(flags)) throw new TypeError(`${label}.flags may contain each of i, m, s, or u at most once`);
    try { new RegExp(pattern, flags); } catch (error) { throw new TypeError(`${label}.matches is not a valid regular expression: ${errorMessage(error)}`); }
    return { matches: pattern, ...(flags ? { flags } : {}) };
  }
  return operator === "equals" ? { equals: pattern } : { contains: pattern };
}

function normalizeCommandAssertion(value: JsonObject, position: number): CommandAssertion {
  const label = `assertions[${position}]`;
  assertKnownKeys(value, COMMAND_KEYS, label);
  if (!Array.isArray(value.command) || value.command.length === 0 || value.command.length > 128) {
    throw new TypeError(`${label}.command must be a non-empty argument array with at most 128 entries`);
  }
  const command = value.command.map((part, index) => requiredString(part, `${label}.command[${index}]`, 32_000, index > 0));
  const cwd = value.cwd === undefined ? undefined : requiredString(value.cwd, `${label}.cwd`, 4_096);
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(value.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError(`${label}.timeoutMs must be an integer from 1 through 300000`);
  }
  assertObject(value.expect, `${label}.expect`);
  assertKnownKeys(value.expect, COMMAND_EXPECT_KEYS, `${label}.expect`);
  if (Object.keys(value.expect).length === 0) throw new TypeError(`${label}.expect must contain an exitCode, stdout, or stderr assertion`);
  const exitCode = value.expect.exitCode === undefined ? 0 : Number(value.expect.exitCode);
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 0xffff_ffff) {
    throw new TypeError(`${label}.expect.exitCode must be an unsigned 32-bit integer`);
  }
  const rawExpect = asObject(value.expect);
  const expect = {
    exitCode,
    ...(rawExpect.stdout === undefined ? {} : { stdout: normalizeMatcher(rawExpect.stdout, `${label}.expect.stdout`) }),
    ...(rawExpect.stderr === undefined ? {} : { stderr: normalizeMatcher(rawExpect.stderr, `${label}.expect.stderr`) })
  };
  return {
    id: identifier(value.id, `${label}.id`),
    type: "command",
    command,
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs,
    expect
  };
}

function normalizeFileAssertion(value: JsonObject, position: number): FileAssertion {
  const label = `assertions[${position}]`;
  assertKnownKeys(value, FILE_KEYS, label);
  assertObject(value.expect, `${label}.expect`);
  assertKnownKeys(value.expect, FILE_EXPECT_KEYS, `${label}.expect`);
  if (typeof value.expect.exists !== "boolean") throw new TypeError(`${label}.expect.exists must be a boolean`);
  if (value.expect.exists === false && value.expect.content !== undefined) {
    throw new TypeError(`${label}.expect.content cannot be used when exists is false`);
  }
  const rawExpect = asObject(value.expect);
  return {
    id: identifier(value.id, `${label}.id`),
    type: "file",
    path: requiredString(value.path, `${label}.path`, 4_096),
    expect: {
      exists: rawExpect.exists as boolean,
      ...(rawExpect.content === undefined ? {} : { content: normalizeMatcher(rawExpect.content, `${label}.expect.content`) })
    }
  };
}

function normalizeHttpAssertion(value: JsonObject, position: number): HttpAssertion {
  const label = `assertions[${position}]`;
  assertKnownKeys(value, HTTP_KEYS, label);
  const url = requiredString(value.url, `${label}.url`, 4_096);
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError(`${label}.url must be a valid URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new TypeError(`${label}.url must be an http(s) URL without credentials or fragments`);
  const method = value.method === undefined ? "GET" : requiredString(value.method, `${label}.method`, 8).toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) throw new TypeError(`${label}.method must be GET or HEAD`);
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(value.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError(`${label}.timeoutMs must be an integer from 1 through 300000`);
  assertObject(value.expect, `${label}.expect`);
  assertKnownKeys(value.expect, HTTP_EXPECT_KEYS, `${label}.expect`);
  const status = Number(value.expect.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new TypeError(`${label}.expect.status must be an HTTP status code`);
  const rawExpect = asObject(value.expect);
  return { id: identifier(value.id, `${label}.id`), type: "http", url, method: method as "GET" | "HEAD", timeoutMs, expect: { status, ...(rawExpect.body === undefined ? {} : { body: normalizeMatcher(rawExpect.body, `${label}.expect.body`) }) } };
}

function normalizeGitAssertion(value: JsonObject, position: number): GitAssertion {
  const label = `assertions[${position}]`;
  assertKnownKeys(value, GIT_KEYS, label);
  const cwd = value.cwd === undefined ? undefined : requiredString(value.cwd, `${label}.cwd`, 4_096);
  assertObject(value.expect, `${label}.expect`);
  assertKnownKeys(value.expect, GIT_EXPECT_KEYS, `${label}.expect`);
  if (typeof value.expect.clean !== "boolean") throw new TypeError(`${label}.expect.clean must be a boolean`);
  return { id: identifier(value.id, `${label}.id`), type: "git", ...(cwd === undefined ? {} : { cwd }), expect: { clean: asObject(value.expect).clean as boolean } };
}

export function validateVerificationContract(input: unknown): VerificationContract {
  assertObject(input, "verification contract");
  assertKnownKeys(input, CONTRACT_KEYS, "verification contract");
  if (input.schemaVersion !== PROOF_CONTRACT_SCHEMA_VERSION) {
    throw new TypeError(`verification contract schemaVersion must be ${PROOF_CONTRACT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.assertions) || input.assertions.length === 0 || input.assertions.length > 256) {
    throw new TypeError("verification contract assertions must be a non-empty array with at most 256 entries");
  }
  const assertions = input.assertions.map((assertion, position) => {
    assertObject(assertion, `assertions[${position}]`);
    if (assertion.type === "command") return normalizeCommandAssertion(assertion, position);
    if (assertion.type === "file") return normalizeFileAssertion(assertion, position);
    if (assertion.type === "http") return normalizeHttpAssertion(assertion, position);
    if (assertion.type === "git") return normalizeGitAssertion(assertion, position);
    throw new TypeError(`assertions[${position}].type must be 'command', 'file', 'http', or 'git'`);
  });
  const seen = new Set<string>();
  for (const assertion of assertions) {
    if (seen.has(assertion.id)) throw new TypeError(`assertion id must be unique: ${assertion.id}`);
    seen.add(assertion.id);
  }
  const description = optionalDescription(input.description);
  return {
    schemaVersion: PROOF_CONTRACT_SCHEMA_VERSION,
    id: identifier(input.id, "verification contract id"),
    runId: identifier(input.runId, "verification contract runId"),
    ...(description === undefined ? {} : { description }),
    assertions
  };
}

export const validateProofContract = validateVerificationContract;

function isWithin(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function resolveAllowedPath(root: string, candidate: string): Promise<{ path: string; exists: boolean }> {
  const lexical = resolve(root, candidate);
  if (!isWithin(root, lexical)) throw new Error(`path escapes allowed root: ${candidate}`);
  try {
    const physical = await realpath(lexical);
    if (!isWithin(root, physical)) throw new Error(`path escapes allowed root through a symbolic link: ${candidate}`);
    return { path: physical, exists: true };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeError | undefined)?.code ?? "")) throw error;
  }

  let ancestor = dirname(lexical);
  while (true) {
    try {
      await lstat(ancestor);
      const physicalAncestor = await realpath(ancestor);
      if (!isWithin(root, physicalAncestor)) throw new Error(`path escapes allowed root through a symbolic link: ${candidate}`);
      return { path: lexical, exists: false };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeError | undefined)?.code ?? "")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`cannot resolve path within allowed root: ${candidate}`);
      ancestor = parent;
    }
  }
}

function matchesText(actual: string, matcher: Matcher) {
  if ("equals" in matcher) return actual === matcher.equals;
  if ("contains" in matcher) return actual.includes(matcher.contains);
  return new RegExp(matcher.matches, matcher.flags ?? "").test(actual);
}

function isLoopbackUrl(value: string) {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function terminateProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean }) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

function captureProcess(command: string[], { cwd, timeoutMs, maxOutputBytes, environment }: { cwd: string; timeoutMs: number; maxOutputBytes: number; environment: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolveResult) => {
    const startedAt = new Date().toISOString();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;
    let settled = false;
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const collect = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const available = Math.max(0, maxOutputBytes - used);
      if (available > 0) chunks.push(chunk.subarray(0, available));
      if (stream === "stdout") stdoutBytes += Math.min(chunk.byteLength, available);
      else stderrBytes += Math.min(chunk.byteLength, available);
      if (chunk.byteLength > available) {
        outputLimitExceeded = true;
        terminateProcessTree(child);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    child.once("error", (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        startedAt,
        completedAt: new Date().toISOString(),
        exitCode,
        signal: signal ?? undefined,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputLimitExceeded,
        error: spawnError?.message
      });
    });
  });
}

function registerArtifact(db: DatabaseSync, artifact: StoredArtifact, createdAt: string) {
  db.prepare("INSERT OR IGNORE INTO artifacts(digest, path, media_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(artifact.digest, artifact.path, artifact.mediaType, artifact.sizeBytes, createdAt);
}

function assertionExpectation(assertion: ProofAssertion) {
  return assertion.expect;
}

export class ProofVerifier {
  readonly runLedger: RunLedger;
  readonly allowedRoot: string;
  readonly maxOutputBytes: number;
  readonly maxFileBytes: number;
  readonly allowExternalHttp: boolean;
  readonly allowedCommands: string[][];
  readonly commandEnvironment: NodeJS.ProcessEnv;

  constructor({ runLedger, allowedRoot, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, maxFileBytes = DEFAULT_MAX_FILE_BYTES, allowExternalHttp = false, allowedCommands = [], commandEnvironment }: ProofVerifierOptions) {
    if (!runLedger || typeof runLedger.getRun !== "function" || typeof runLedger.appendEvent !== "function") {
      throw new TypeError("ProofVerifier requires a RunLedger");
    }
    if (!runLedger.database?.db || typeof runLedger.database.transaction !== "function" || !runLedger.artifacts?.put) {
      throw new TypeError("ProofVerifier requires RunLedger database and ArtifactStore APIs");
    }
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 10_000_000) {
      throw new TypeError("maxOutputBytes must be an integer from 1 through 10000000");
    }
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 10_000_000) {
      throw new TypeError("maxFileBytes must be an integer from 1 through 10000000");
    }
    if (!Array.isArray(allowedCommands) || allowedCommands.some((command) => !Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string") || !isAbsolute(command[0]))) {
      throw new TypeError("ProofVerifier allowedCommands must contain exact non-empty argument arrays with absolute executable paths");
    }
    this.runLedger = runLedger;
    this.allowedRoot = resolve(allowedRoot ?? runLedger.workspaceRoot ?? process.cwd());
    this.maxOutputBytes = maxOutputBytes;
    this.maxFileBytes = maxFileBytes;
    this.allowExternalHttp = allowExternalHttp === true;
    this.allowedCommands = allowedCommands.map((command) => [...command]);
    this.commandEnvironment = commandEnvironment ?? {
      PATH: process.env.PATH ?? "",
      ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
    };
  }

  async verify(input: unknown) {
    const contract = validateVerificationContract(input);
    if (this.runLedger.featureFlags?.proof !== true) throw new Error("experimental proof feature is disabled");
    const root = await realpath(this.allowedRoot);
    if (!this.runLedger.getRun(contract.runId)) throw new Error(`run not found for verification contract: ${contract.runId}`);
    const existing = this.runLedger.database.db.prepare("SELECT id FROM verification_contracts WHERE id = ?").get(contract.id);
    if (existing) throw new Error(`verification contract already exists: ${contract.id}`);

    const startedAt = new Date().toISOString();
    const contractArtifact = this.runLedger.artifacts.putJson(contract);
    this.runLedger.database.transaction((db) => {
      registerArtifact(db, contractArtifact, startedAt);
      db.prepare(`INSERT INTO verification_contracts
        (id, run_id, version, contract_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(
        contract.id,
        contract.runId,
        contract.schemaVersion,
        JSON.stringify(redact(contract)),
        startedAt
      );
    });
    this.runLedger.appendEvent({
      runId: contract.runId,
      type: "verification-started",
      payload: { contractId: contract.id, contractDigest: contractArtifact.digest, assertionCount: contract.assertions.length }
    });

    const results: AssertionResult[] = [];
    for (let sequence = 0; sequence < contract.assertions.length; sequence += 1) {
      const assertion = contract.assertions[sequence];
      let result;
      try {
        result = assertion.type === "command"
          ? await this.verifyCommand(assertion, root)
          : assertion.type === "file"
            ? await this.verifyFile(assertion, root)
            : assertion.type === "http"
              ? await this.verifyHttp(assertion)
              : await this.verifyGit(assertion, root);
      } catch (error) {
        result = this.failedResult(assertion, `assertion execution failed: ${errorMessage(error)}`, {});
      }
      results.push(result);
      this.persistAssertion(contract.id, assertion, result, sequence + 1);
      this.runLedger.appendEvent({
        runId: contract.runId,
        type: "assertion-result",
        payload: { contractId: contract.id, assertionId: assertion.id, assertionType: assertion.type, status: result.status, message: result.message }
      });
    }

    const passed = results.every((result) => result.passed);
    const status = passed ? "passed" : "failed";
    const completedAt = new Date().toISOString();
    this.runLedger.database.transaction((db) => {
      db.prepare("UPDATE runs SET status = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
        .run(passed ? "verified" : "failed", completedAt, contract.runId);
    });
    this.runLedger.appendEvent({
      runId: contract.runId,
      type: "verification-completed",
      payload: { contractId: contract.id, status, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length }
    });
    return { contractId: contract.id, runId: contract.runId, status, passed, startedAt, completedAt, assertions: results };
  }

  async verifyCommand(assertion: CommandAssertion, root: string): Promise<AssertionResult> {
    const approved = this.allowedCommands.some((command) => command.length === assertion.command.length && command.every((part, index) => part === assertion.command[index]));
    if (!approved) {
      return this.failedResult(assertion, "command assertion is not present in the operator-controlled exact command allowlist", { command: assertion.command });
    }
    let cwdResult;
    try {
      cwdResult = await resolveAllowedPath(root, assertion.cwd ?? ".");
    } catch (error) {
      return this.failedResult(assertion, errorMessage(error), { cwd: assertion.cwd ?? "." });
    }
    if (!cwdResult.exists) {
      return this.failedResult(assertion, `command working directory does not exist: ${assertion.cwd ?? "."}`, { cwd: assertion.cwd ?? "." });
    }
    const cwdStat = await stat(cwdResult.path);
    if (!cwdStat.isDirectory()) {
      return this.failedResult(assertion, `command working directory is not a directory: ${assertion.cwd ?? "."}`, { cwd: assertion.cwd ?? "." });
    }
    const actual = await captureProcess(assertion.command, {
      cwd: cwdResult.path,
      timeoutMs: assertion.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      environment: this.commandEnvironment
    });
    const failures: string[] = [];
    if (actual.error) failures.push(`command could not start: ${actual.error}`);
    if (actual.timedOut) failures.push(`command timed out after ${assertion.timeoutMs}ms`);
    if (actual.outputLimitExceeded) failures.push(`command output exceeded ${this.maxOutputBytes} bytes`);
    if (actual.exitCode !== assertion.expect.exitCode) failures.push(`expected exit code ${assertion.expect.exitCode}, received ${actual.exitCode ?? "none"}`);
    if (assertion.expect.stdout && !matchesText(actual.stdout, assertion.expect.stdout)) failures.push("stdout did not match expectation");
    if (assertion.expect.stderr && !matchesText(actual.stderr, assertion.expect.stderr)) failures.push("stderr did not match expectation");
    return {
      id: assertion.id,
      type: assertion.type,
      status: failures.length ? "failed" : "passed",
      passed: failures.length === 0,
      message: failures.length ? failures.join("; ") : "command assertion passed",
      expected: assertion.expect,
      actual,
      startedAt: actual.startedAt,
      completedAt: actual.completedAt
    };
  }

  async verifyFile(assertion: FileAssertion, root: string): Promise<AssertionResult> {
    let target;
    try {
      target = await resolveAllowedPath(root, assertion.path);
    } catch (error) {
      return this.failedResult(assertion, errorMessage(error), { exists: false, path: assertion.path });
    }
    if (target.exists !== assertion.expect.exists) {
      return this.failedResult(
        assertion,
        assertion.expect.exists ? `expected file to exist: ${assertion.path}` : `expected file not to exist: ${assertion.path}`,
        { exists: target.exists, path: assertion.path }
      );
    }
    if (!target.exists) {
      return this.passedResult(assertion, "file absence assertion passed", { exists: false, path: assertion.path });
    }
    const metadata = await stat(target.path);
    if (!metadata.isFile()) return this.failedResult(assertion, `path is not a regular file: ${assertion.path}`, { exists: true, path: assertion.path });
    const actual: JsonObject = { exists: true, path: assertion.path, sizeBytes: metadata.size };
    if (assertion.expect.content) {
      if (metadata.size > this.maxFileBytes) {
        return this.failedResult(assertion, `file exceeds content assertion limit of ${this.maxFileBytes} bytes`, actual);
      }
      const content = await readFile(target.path, "utf8");
      actual.content = content;
      if (!matchesText(content, assertion.expect.content)) return this.failedResult(assertion, "file content did not match expectation", actual);
    }
    return this.passedResult(assertion, "file assertion passed", actual);
  }

  async verifyHttp(assertion: HttpAssertion): Promise<AssertionResult> {
    if (!this.allowExternalHttp && !isLoopbackUrl(assertion.url)) return this.failedResult(assertion, "external HTTP verification is disabled by default", { url: assertion.url });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), assertion.timeoutMs);
    const startedAt = new Date().toISOString();
    try {
      const response = await fetch(assertion.url, { method: assertion.method, redirect: "error", signal: controller.signal });
      const body = assertion.method === "HEAD" ? "" : (await response.text()).slice(0, this.maxOutputBytes);
      const failures: string[] = [];
      if (response.status !== assertion.expect.status) failures.push(`expected HTTP status ${assertion.expect.status}, received ${response.status}`);
      if (assertion.expect.body && !matchesText(body, assertion.expect.body)) failures.push("HTTP response body did not match expectation");
      return { id: assertion.id, type: assertion.type, status: failures.length ? "failed" : "passed", passed: failures.length === 0, message: failures.length ? failures.join("; ") : "HTTP assertion passed", expected: assertion.expect, actual: { status: response.status, body }, startedAt, completedAt: new Date().toISOString() };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return this.failedResult(assertion, `HTTP assertion failed: ${failure.name === "AbortError" ? `timed out after ${assertion.timeoutMs}ms` : failure.message}`, { url: assertion.url });
    } finally { clearTimeout(timer); }
  }

  async verifyGit(assertion: GitAssertion, root: string): Promise<AssertionResult> {
    let cwdResult;
    try { cwdResult = await resolveAllowedPath(root, assertion.cwd ?? "."); }
    catch (error) { return this.failedResult(assertion, errorMessage(error), { cwd: assertion.cwd ?? "." }); }
    if (!cwdResult.exists) return this.failedResult(assertion, `git working directory does not exist: ${assertion.cwd ?? "."}`, { cwd: assertion.cwd ?? "." });
    const actual = await captureProcess(["git", "status", "--porcelain"], {
      cwd: cwdResult.path,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: this.maxOutputBytes,
      environment: this.commandEnvironment
    });
    const clean = actual.exitCode === 0 && actual.stdout.trim() === "";
    const passed = clean === assertion.expect.clean && actual.exitCode === 0;
    return { id: assertion.id, type: assertion.type, status: passed ? "passed" : "failed", passed, message: passed ? "git assertion passed" : `expected clean=${assertion.expect.clean}, received clean=${clean}`, expected: assertion.expect, actual, startedAt: actual.startedAt, completedAt: actual.completedAt };
  }

  passedResult(assertion: ProofAssertion, message: string, actual: JsonObject): AssertionResult {
    const now = new Date().toISOString();
    return { id: assertion.id, type: assertion.type, status: "passed", passed: true, message, expected: assertion.expect, actual, startedAt: now, completedAt: now };
  }

  failedResult(assertion: ProofAssertion, message: string, actual: JsonObject): AssertionResult {
    const now = new Date().toISOString();
    return { id: assertion.id, type: assertion.type, status: "failed", passed: false, message, expected: assertion.expect, actual, startedAt: now, completedAt: now };
  }

  persistAssertion(contractId: string, assertion: ProofAssertion, result: AssertionResult, sequence: number) {
    const createdAt = result.startedAt ?? new Date().toISOString();
    const completedAt = result.completedAt ?? new Date().toISOString();
    const stdout = result.actual.stdout;
    const stderr = result.actual.stderr;
    const content = result.actual.content;
    const stdoutArtifact = typeof stdout === "string"
      ? this.runLedger.artifacts.put(String(redact(stdout)), { mediaType: "text/plain; charset=utf-8" })
      : undefined;
    const stderrArtifact = typeof stderr === "string"
      ? this.runLedger.artifacts.put(String(redact(stderr)), { mediaType: "text/plain; charset=utf-8" })
      : undefined;
    const contentArtifact = typeof content === "string"
      ? this.runLedger.artifacts.put(String(redact(content)), { mediaType: "text/plain; charset=utf-8" })
      : undefined;
    const evidenceArtifactIds = [stdoutArtifact?.digest, stderrArtifact?.digest, contentArtifact?.digest].filter(Boolean);
    this.runLedger.database.transaction((db) => {
      if (stdoutArtifact) registerArtifact(db, stdoutArtifact, completedAt);
      if (stderrArtifact) registerArtifact(db, stderrArtifact, completedAt);
      if (contentArtifact) registerArtifact(db, contentArtifact, completedAt);
      const contractRow = db.prepare("SELECT run_id FROM verification_contracts WHERE id = ?").get(contractId) as { run_id: string } | undefined;
      if (!contractRow) throw new Error(`verification contract not found: ${contractId}`);
      const runId = contractRow.run_id;
      db.prepare(`INSERT INTO assertion_results
        (id, contract_id, run_id, assertion_id, status, started_at, completed_at, evidence_artifact_ids_json, message, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `assertion_result_${randomUUID()}`,
        contractId,
        runId,
        assertion.id,
        result.status,
        createdAt,
        completedAt,
        JSON.stringify(evidenceArtifactIds),
        result.message,
        JSON.stringify(redact({ sequence, type: assertion.type, expected: assertionExpectation(assertion), actual: result.actual }))
      );
    });
  }
}

export function verifyContract(contract: unknown, options: ProofVerifierOptions) {
  return new ProofVerifier(options).verify(contract);
}

export const verifyProof = verifyContract;
