import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

export type StateMutationLockOptions = {
  timeoutMs?: number;
};

/**
 * Serialize mutations to one Odinn state directory across CLI and gateway
 * processes. The lock lives beside the state directory so acquiring it never
 * creates a fresh state as a side effect.
 */
export async function withStateMutationLock<T>(
  stateDir: string,
  operation: () => Promise<T>,
  options: StateMutationLockOptions = {}
): Promise<T> {
  const root = resolve(stateDir);
  const parent = dirname(root);
  const lockPath = join(parent, `.${basename(root)}.state-mutation.lock`);
  const timeoutMs = positiveTimeout(options.timeoutMs);
  await mkdir(parent, { recursive: true });

  const token = randomBytes(18).toString("hex");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
      if (await removeDeadOwnerLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error("Odinn state is busy in another process. Wait for that operation to finish, then try again.");
      }
      await wait(POLL_INTERVAL_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await removeOwnedLock(lockPath, token);
  }
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1) throw new Error("state mutation lock timeout must be a positive integer");
  return timeout;
}

async function removeDeadOwnerLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error: unknown) {
    return isCode(error, "ENOENT");
  }
  let owner: { pid?: unknown };
  try {
    owner = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Number.isInteger(owner.pid) || Number(owner.pid) < 1 || processExists(Number(owner.pid))) return false;
  try {
    if (await readFile(lockPath, "utf8") !== raw) return false;
    await rm(lockPath);
    return true;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8"));
    if (current?.token === token) await rm(lockPath);
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isCode(error, "ESRCH");
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
