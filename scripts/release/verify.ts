import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedRoot = `odinn-v${pkg.version}`;
const manifest = JSON.parse(await readFile(join(releaseDir, "release-manifest.json"), "utf8"));
if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error("release manifest package metadata mismatch");
const lockDigest = createHash("sha256").update(await readFile(join(root, "pnpm-lock.yaml"))).digest("hex");
if (manifest.lockfileSha256 !== lockDigest) throw new Error("release manifest lockfile digest mismatch");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.status === 0 && manifest.commit !== head.stdout.trim()) throw new Error("release manifest commit does not match checked-out HEAD");
if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.includes(`${expectedRoot}.zip`) || !manifest.artifacts.includes(`${expectedRoot}.tar.gz`)) throw new Error("release manifest must name both source archives");
const sums = (await readFile(join(releaseDir, "SHA256SUMS.txt"), "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line: any) => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    return { digest: match[1], name: match[2] };
  });

for (const { digest, name } of sums) {
  const actual = createHash("sha256").update(await readFile(join(releaseDir, name))).digest("hex");
  if (actual !== digest) throw new Error(`checksum mismatch for ${name}`);
}

const releaseFiles = new Set((await readdir(releaseDir)).filter((name) => name !== "SHA256SUMS.txt"));
const checksumFiles = new Set(sums.map(({ name }) => name));
if (releaseFiles.size !== checksumFiles.size || [...releaseFiles].some((name) => !checksumFiles.has(name))) throw new Error("checksum file does not cover exactly the release artifacts");
for (const archiveName of manifest.artifacts) {
  const digest = createHash("sha256").update(await readFile(join(releaseDir, archiveName))).digest("hex");
  if (manifest.archiveSha256?.[archiveName] !== digest) throw new Error(`release manifest archive digest mismatch for ${archiveName}`);
}
const sbom = JSON.parse(await readFile(join(releaseDir, manifest.sbom ?? "odinn.spdx.json"), "utf8"));
if (sbom.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbom.files)) throw new Error("release SBOM is not a valid SPDX file");
const provenance = JSON.parse(await readFile(join(releaseDir, manifest.provenance ?? "release-provenance.json"), "utf8"));
if (provenance.commit !== manifest.commit || provenance.version !== manifest.version) throw new Error("release provenance does not match manifest");

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...await walk(join(directory, entry.name), name));
    else entries.push(name);
  }
  return entries;
}

function forbiddenArchivePath(name: string) {
  return /(^|\/)(\.odinn)(\/|$)|(^|\/)(gateway\.token|[^/]+\.sqlite(?:-(?:shm|wal))?|[^/]*\.keys\.json|browser-profiles?\/|[^/]*recovery[^/]*\.(?:json|jsonl|db)$)/i.test(name);
}

function run(command: any, args: any) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
}

for (const extension of ["zip", "tar.gz"]) {
  const archive = join(releaseDir, `${expectedRoot}.${extension}`);
  const destination = await mkdtemp(join(tmpdir(), "odinn-package-"));
  try {
    if (extension === "zip") {
      if (process.platform === "win32") {
        const escapedArchive = archive.replaceAll("'", "''");
        const escapedDestination = destination.replaceAll("'", "''");
        run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`]);
      } else {
        run("unzip", ["-q", archive, "-d", destination]);
      }
    } else {
      run("tar", ["-xzf", archive, "-C", destination]);
    }

    const packageRoot = join(destination, expectedRoot);
    const forbidden = (await walk(packageRoot)).filter(forbiddenArchivePath);
    if (forbidden.length) throw new Error(`archive contains runtime state: ${forbidden.join(", ")}`);
    for (const required of ["README.md", "LICENSE", "SECURITY.md", "package.json", "pnpm-lock.yaml", "release-info.json"]) {
      await readFile(join(packageRoot, required));
    }
    const archivedPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (archivedPackage.name !== "odinn" || archivedPackage.version !== pkg.version) {
      throw new Error(`archive metadata mismatch in ${basename(archive)}`);
    }
    const releaseInfo = JSON.parse(await readFile(join(packageRoot, "release-info.json"), "utf8"));
    if (releaseInfo.commit !== manifest.commit) {
      throw new Error(`archive commit metadata mismatch in ${basename(archive)}`);
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

console.log(`verified ${sums.length} checksums and both Odinn Forge ${pkg.version} source archives`);
