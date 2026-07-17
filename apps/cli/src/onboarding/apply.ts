import { createHash, randomBytes } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withStateMutationLock } from "@odinn/kernel";

const TRANSACTION_PREFIX = ".onboarding-transaction-";
const PHASE_FILE = "phase";

export type OnboardingDraft = {
  targetState: string;
  draftState: string;
  targetExisted: boolean;
  baselineFingerprint: string;
};

export type CommitResult = {
  configPath: string;
  backupPath?: string;
};

export async function createOnboardingDraft(targetState: string): Promise<OnboardingDraft> {
  const parent = dirname(targetState);
  await mkdir(parent, { recursive: true });
  const draftState = await mkdtemp(join(parent, `.${basename(targetState)}-onboarding-`));
  await chmod(draftState, 0o700);
  try {
    return await withStateMutationLock(targetState, async () => {
      await recoverInterruptedTransactionsUnlocked(targetState);
      const targetExisted = await pathExists(targetState);
      const baselineFingerprint = await fingerprintControlledState(targetState);
      if (targetExisted) {
        await copyIfPresent(join(targetState, "config.json"), join(draftState, "config.json"));
        await copyDirectoryIfPresent(join(targetState, "oauth"), join(draftState, "oauth"));
      }
      return { targetState, draftState, targetExisted, baselineFingerprint };
    });
  } catch (error) {
    await rm(draftState, { recursive: true, force: true });
    throw error;
  }
}

export async function commitOnboardingDraft(draft: OnboardingDraft): Promise<CommitResult> {
  const sourceConfig = join(draft.draftState, "config.json");
  await assertSafeFile(sourceConfig);

  return withStateMutationLock(draft.targetState, async () => {
    await recoverInterruptedTransactionsUnlocked(draft.targetState);
    const currentFingerprint = await fingerprintControlledState(draft.targetState);
    if (currentFingerprint !== draft.baselineFingerprint) {
      throw new Error(
        "The Odinn setup changed in another process while onboarding was open. Nothing was applied. Reopen onboarding to review the newer setup."
      );
    }

    await mkdir(draft.targetState, { recursive: true, mode: 0o700 });
    await chmod(draft.targetState, 0o700);
    const backupPath = await backupCurrentState(draft.targetState);
    const transaction = await prepareTransaction(draft);
    try {
      await applyPreparedTransaction(draft.targetState, transaction);
    } catch (error) {
      try {
        await rollbackTransaction(draft.targetState, transaction);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Onboarding could not apply the setup and automatic rollback also failed. Restore the timestamped onboarding backup before starting Odinn."
        );
      }
      throw error;
    }
    await rm(transaction, { recursive: true, force: true }).catch(() => undefined);
    return {
      configPath: join(draft.targetState, "config.json"),
      ...(backupPath ? { backupPath } : {})
    };
  });
}

export async function recoverInterruptedOnboardingTransactions(targetState: string): Promise<void> {
  await withStateMutationLock(targetState, async () => recoverInterruptedTransactionsUnlocked(targetState));
}

export async function discardOnboardingDraft(draft: OnboardingDraft): Promise<void> {
  await rm(draft.draftState, { recursive: true, force: true });
}

export async function atomicWrite(path: string, contents: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function prepareTransaction(draft: OnboardingDraft): Promise<string> {
  const transaction = await mkdtemp(join(draft.targetState, TRANSACTION_PREFIX));
  await chmod(transaction, 0o700);
  const targetConfig = join(draft.targetState, "config.json");
  if (await pathExists(targetConfig)) await copyIfPresent(targetConfig, join(transaction, "previous-config.json"));
  else await writeMarker(join(transaction, "previous-config-missing"));

  const targetOauth = join(draft.targetState, "oauth");
  if (await pathExists(targetOauth)) {
    await assertSafeDirectory(targetOauth);
    await writeMarker(join(transaction, "previous-oauth-present"));
  }
  await copyIfPresent(join(draft.draftState, "config.json"), join(transaction, "next-config.json"));
  await copyDirectoryIfPresent(join(draft.draftState, "oauth"), join(transaction, "next-oauth"));
  await secureTree(transaction);
  await atomicWrite(join(transaction, PHASE_FILE), "prepared\n", 0o600);
  return transaction;
}

async function applyPreparedTransaction(targetState: string, transaction: string): Promise<void> {
  const targetOauth = join(targetState, "oauth");
  const previousOauth = join(transaction, "previous-oauth");
  const nextOauth = join(transaction, "next-oauth");
  if (await pathExists(targetOauth)) await rename(targetOauth, previousOauth);
  if (await pathExists(nextOauth)) await rename(nextOauth, targetOauth);
  await atomicWrite(join(transaction, PHASE_FILE), "oauth-swapped\n", 0o600);
  await atomicWrite(join(targetState, "config.json"), await readFile(join(transaction, "next-config.json")), 0o600);
  await atomicWrite(join(transaction, PHASE_FILE), "committed\n", 0o600);
}

async function rollbackTransaction(targetState: string, transaction: string): Promise<void> {
  const previousConfig = join(transaction, "previous-config.json");
  if (await pathExists(previousConfig)) {
    await atomicWrite(join(targetState, "config.json"), await readFile(previousConfig), 0o600);
  } else if (await pathExists(join(transaction, "previous-config-missing"))) {
    await rm(join(targetState, "config.json"), { force: true });
  }

  const targetOauth = join(targetState, "oauth");
  const previousOauth = join(transaction, "previous-oauth");
  const previouslyPresent = await pathExists(join(transaction, "previous-oauth-present"));
  if (await pathExists(previousOauth)) {
    await rm(targetOauth, { recursive: true, force: true });
    await rename(previousOauth, targetOauth);
  } else if (!previouslyPresent) {
    await rm(targetOauth, { recursive: true, force: true });
  }
  await rm(transaction, { recursive: true, force: true });
}

async function recoverInterruptedTransactionsUnlocked(targetState: string): Promise<void> {
  let entries;
  try {
    const info = await lstat(targetState);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing unsafe Odinn state directory: ${targetState}`);
    entries = await readdir(targetState, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries.filter((item) => item.name.startsWith(TRANSACTION_PREFIX)).sort((a, b) => a.name.localeCompare(b.name))) {
    const transaction = join(targetState, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Refusing unsafe onboarding transaction: ${transaction}`);
    const phase = await readFile(join(transaction, PHASE_FILE), "utf8").catch((error: unknown) => {
      if (isMissing(error)) return "";
      throw error;
    });
    if (!phase.trim() || phase.trim() === "committed") await rm(transaction, { recursive: true, force: true });
    else await rollbackTransaction(targetState, transaction);
  }
}

async function fingerprintControlledState(targetState: string): Promise<string> {
  const hash = createHash("sha256");
  await fingerprintPath(join(targetState, "config.json"), "config.json", hash);
  await fingerprintPath(join(targetState, "oauth"), "oauth", hash);
  return hash.digest("hex");
}

async function fingerprintPath(path: string, relativePath: string, hash: ReturnType<typeof createHash>): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      hash.update(`missing\0${relativePath}\0`);
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link in onboarding state: ${path}`);
  hash.update(`${info.isDirectory() ? "directory" : info.isFile() ? "file" : "unsupported"}\0${relativePath}\0${info.mode & 0o777}\0`);
  if (info.isFile()) {
    if (info.nlink !== 1) throw new Error(`Refusing hard-linked onboarding file: ${path}`);
    const contents = await readFile(path);
    hash.update(`${contents.byteLength}\0`);
    hash.update(contents);
    return;
  }
  if (!info.isDirectory()) throw new Error(`Refusing unsupported onboarding state entry: ${path}`);
  const entries = await readdir(path);
  for (const entry of entries.sort()) await fingerprintPath(join(path, entry), `${relativePath}/${entry}`, hash);
}

async function backupCurrentState(targetState: string): Promise<string | undefined> {
  const config = join(targetState, "config.json");
  const oauth = join(targetState, "oauth");
  if (!await pathExists(config) && !await pathExists(oauth)) return undefined;
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backup = join(targetState, "backups", `onboarding-${timestamp}-${randomBytes(4).toString("hex")}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await chmod(backup, 0o700);
  await copyIfPresent(config, join(backup, "config.json"));
  await copyDirectoryIfPresent(oauth, join(backup, "oauth"));
  await secureTree(backup);
  return backup;
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  try {
    await assertSafeFile(source);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, 0o600);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
}

async function copyDirectoryIfPresent(source: string, target: string): Promise<void> {
  let entries;
  try {
    await assertSafeDirectory(source);
    entries = await readdir(source, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to copy symbolic link from onboarding state: ${sourcePath}`);
    if (entry.isDirectory()) await copyDirectoryIfPresent(sourcePath, targetPath);
    else if (entry.isFile()) await copyIfPresent(sourcePath, targetPath);
    else throw new Error(`Refusing unsupported onboarding state entry: ${sourcePath}`);
  }
}

async function assertSafeFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Refusing unsafe onboarding file: ${path}`);
}

async function assertSafeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing unsafe onboarding directory: ${path}`);
}

async function secureTree(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to secure symbolic link: ${path}`);
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) await secureTree(join(path, entry));
    } else if (info.isFile()) {
      await chmod(path, 0o600);
    } else {
      throw new Error(`Refusing unsupported onboarding state entry: ${path}`);
    }
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
}

async function writeMarker(path: string): Promise<void> {
  await writeFile(path, "yes\n", { mode: 0o600, flag: "wx" });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
