#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const [command = "status", ...args] = process.argv.slice(2);
const prefix = resolve(option("--prefix", process.env.ODINN_INSTALL_PREFIX || join(homedir(), ".local", "share", "odinn")));
const statePath = join(prefix, "install-state.json");

if (command === "install" || command === "upgrade") await install(command);
else if (command === "rollback") await rollback();
else if (command === "status") console.log(JSON.stringify(await readState(), null, 2));
else throw new Error("usage: install.ts install|upgrade|rollback|status [--source DIR] [--prefix DIR] [--version VERSION] [--commit SHA] [--artifact-sha256 HASH] [--skip-deps]");

async function install(operation: any) {
  const source = resolve(option("--source", process.cwd()));
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (pkg.name !== "odinn") throw new Error("install source is not an Odinn Forge package");
  const version = option("--version", pkg.version);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("invalid Odinn Forge version");
  const lockfileSha256 = createHash("sha256").update(await readFile(join(source, "pnpm-lock.yaml"))).digest("hex");
  const releaseInfo = await readReleaseInfo(source);
  const commit = option("--commit", process.env.ODINN_RELEASE_COMMIT || releaseInfo.commit || pkg.odinnCommit || "unknown");
  const artifactSha256 = option("--artifact-sha256", process.env.ODINN_ARTIFACT_SHA256 || "unknown");
  const toolchain = { node: process.version, packageManager: pkg.packageManager || "unknown" };
  const toolchainSha256 = createHash("sha256").update(JSON.stringify(toolchain)).digest("hex");
  const identity = `${lockfileSha256.slice(0, 12)}-${String(commit).slice(0, 12)}-${toolchainSha256.slice(0, 12)}`;
  const versionId = `${version}-${identity}`;
  const versions = join(prefix, "versions");
  const destination = join(versions, versionId);
  const staging = join(versions, `.staging-${process.pid}-${Date.now()}`);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true, filter: (path: any) => !excluded(path, source) });
  if (!has("--skip-deps")) run(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "install", "--frozen-lockfile"], staging);
  const metadata = { schemaVersion: 1, version, commit, lockfileSha256, artifactSha256, toolchain, installedAt: new Date().toISOString() };
  await writeFile(join(staging, "install-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  const destinationExists = await access(destination).then(() => true).catch(() => false);
  if (destinationExists) {
    const existing = JSON.parse(await readFile(join(destination, "install-metadata.json"), "utf8"));
    if (existing.version !== metadata.version || existing.commit !== metadata.commit || existing.lockfileSha256 !== metadata.lockfileSha256 || existing.artifactSha256 !== metadata.artifactSha256 || JSON.stringify(existing.toolchain) !== JSON.stringify(metadata.toolchain)) {
      throw new Error(`immutable Odinn version directory already exists with different release identity: ${versionId}`);
    }
    await rm(staging, { recursive: true, force: true });
  } else {
    await rename(staging, destination);
  }
  const previous = await readState();
  const next = { schemaVersion: 1, current: versionId, currentVersion: version, currentCommit: commit, previous: previous.current && previous.current !== versionId ? previous.current : previous.previous ?? null, installedAt: new Date().toISOString(), operation };
  await writeState(next);
  await writeLaunchers();
  console.log(JSON.stringify({ ok: true, prefix, version, versionId, commit, previous: next.previous }, null, 2));
}

async function rollback() {
  const current = await readState();
  if (!current.previous) throw new Error("no previous Odinn Forge installation is available for rollback");
  const priorPath = join(prefix, "versions", current.previous, "package.json");
  await readFile(priorPath);
  const priorMetadata = JSON.parse(await readFile(join(prefix, "versions", current.previous, "install-metadata.json"), "utf8"));
  const next = { ...current, current: current.previous, currentVersion: priorMetadata.version, currentCommit: priorMetadata.commit, previous: current.current, rolledBackAt: new Date().toISOString(), operation: "rollback" };
  await writeState(next);
  console.log(JSON.stringify({ ok: true, prefix, current: next.current, previous: next.previous }, null, 2));
}

async function readState() {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch (error: any) { if (error?.code === "ENOENT") return { schemaVersion: 1, current: null, previous: null }; throw error; }
}

async function writeState(value: any) {
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600).catch(() => undefined);
}

async function readReleaseInfo(source: string) {
  try {
    const value = JSON.parse(await readFile(join(source, "release-info.json"), "utf8"));
    const commit = String(value?.commit ?? "");
    return { commit: commit.startsWith("$Format:") ? "" : commit };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { commit: "" };
    throw error;
  }
}

async function writeLaunchers() {
  const bin = join(prefix, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const unix = `#!/bin/sh\nset -eu\nPREFIX=${shellQuote(prefix)}\nCURRENT=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).current)' "$PREFIX/install-state.json")\nexec node "$PREFIX/versions/$CURRENT/apps/cli/src/cli.ts" "$@"\n`;
  const gateway = `#!/bin/sh\nset -eu\nPREFIX=${shellQuote(prefix)}\nCURRENT=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).current)' "$PREFIX/install-state.json")\nexec node "$PREFIX/versions/$CURRENT/apps/gateway/src/server.ts" "$@"\n`;
  await writeFile(join(bin, "odinn"), unix, { mode: 0o755 });
  await writeFile(join(bin, "odinn-gateway"), gateway, { mode: 0o755 });
  const cmd = `@echo off\r\nfor /f "usebackq delims=" %%i in (\`node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).current)" "${statePath}"\`) do set ODINN_CURRENT=%%i\r\nnode "${prefix}\\versions\\%ODINN_CURRENT%\\apps\\cli\\src\\cli.ts" %*\r\n`;
  await writeFile(join(bin, "odinn.cmd"), cmd);
}

function excluded(path: any, source: any) {
  const relative = path.slice(source.length).replaceAll("\\", "/");
  return /(^|\/)(\.git|\.odinn|node_modules|dist)(\/|$)/.test(relative);
}
function run(commandName: any, commandArgs: any, cwd: any) { const result = spawnSync(commandName, commandArgs, { cwd, stdio: "inherit", shell: false }); if (result.status !== 0) throw new Error(`${commandName} failed with exit code ${result.status}`); }
function option(name: any, fallback: any = "") { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }
function has(name: any) { return args.includes(name); }
function shellQuote(value: any) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
