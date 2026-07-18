import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = `odinn-v${pkg.version}`;
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

function archive(format: any, extension: any) {
  const destination = join(output, `${base}.${extension}`);
  const result = spawnSync(
    "git",
    ["archive", `--format=${format}`, `--prefix=${base}/`, `--output=${destination}`, "HEAD"],
    { cwd: root, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`git archive (${format}) failed: ${result.stderr || result.stdout}`);
  return destination;
}

function currentCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commandOutput(command: any, args: any[]) {
  const candidates = process.platform === "win32" && command === packageManager
    ? [["pnpm.cmd", args], ["corepack.cmd", ["pnpm", ...args]]]
    : [[command, args]];
  let failure = "";
  for (const [candidate, candidateArgs] of candidates) {
    const result = spawnSync(candidate as string, candidateArgs as string[], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32" && String(candidate).endsWith(".cmd")
    });
    if (result.status === 0) return result.stdout.trim();
    failure = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
  }
  throw new Error(`${command} ${args.join(" ")} failed: ${failure}`);
}

const commit = currentCommit();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw new Error(`release package commit mismatch: GITHUB_SHA=${process.env.GITHUB_SHA} HEAD=${commit}`);
const lockfile = await readFile(join(root, "pnpm-lock.yaml"));

const artifacts = [archive("zip", "zip"), archive("tar.gz", "tar.gz")];
const tracked = commandOutput("git", ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
const sbom = {
  spdxVersion: "SPDX-2.3",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${pkg.name}-${pkg.version}`,
  documentNamespace: `https://odinn.local/releases/${pkg.version}`,
  creationInfo: { created: new Date().toISOString(), creators: ["Tool: Odinn Forge release packager"] },
  packages: [{ SPDXID: "SPDXRef-Package", name: pkg.name, versionInfo: pkg.version, downloadLocation: "NOASSERTION", filesAnalyzed: true }],
  files: await Promise.all(tracked.map(async (path: string, index: number) => ({
    SPDXID: `SPDXRef-File-${index + 1}`,
    fileName: path.replaceAll("\\", "/"),
    checksums: [{ algorithm: "SHA256", checksumValue: createHash("sha256").update(await readFile(join(root, path))).digest("hex") }],
    licenseConcluded: "MIT",
    licenseInfoInFile: ["MIT"]
  })))
};
await writeFile(join(output, "odinn.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
const manifest = {
  name: pkg.name,
  version: pkg.version,
  commit,
  lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
  toolchain: { node: process.version, pnpm: commandOutput(packageManager, ["--version"]) },
  artifacts: artifacts.map((path: any) => path.slice(output.length + 1)),
  sbom: "odinn.spdx.json",
  provenance: "release-provenance.json",
  runtimeStateExcluded: [".odinn/", ".odinn/oauth/", "gateway.token", "audit*.keys.json", "browser profiles", "*.sqlite", "recovery journals"],
  createdAt: new Date().toISOString()
};
await writeFile(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(output, manifest.provenance), `${JSON.stringify({ schemaVersion: 1, subject: pkg.name, version: pkg.version, commit, toolchain: manifest.toolchain, archiveSha256: {}, generatedAt: manifest.createdAt }, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
