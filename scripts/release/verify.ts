import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedRoot = `odinn-v${pkg.version}`;
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
    for (const required of ["README.md", "LICENSE", "SECURITY.md", "package.json", "pnpm-lock.yaml"]) {
      await readFile(join(packageRoot, required));
    }
    const archivedPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (archivedPackage.name !== "odinn" || archivedPackage.version !== pkg.version) {
      throw new Error(`archive metadata mismatch in ${basename(archive)}`);
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

console.log(`verified ${sums.length} checksums and both Odinn Forge ${pkg.version} source archives`);
