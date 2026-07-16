import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedRoot = `odinn-v${pkg.version}`;
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command: any, args: any, cwd: any) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  return result.stdout;
}

for (const extension of ["zip", "tar.gz"]) {
  const archive = join(releaseDir, `${expectedRoot}.${extension}`);
  const destination = await mkdtemp(join(tmpdir(), "odinn-install-smoke-"));
  try {
    if (extension === "zip") {
      if (process.platform === "win32") {
        const escapedArchive = archive.replaceAll("'", "''");
        const escapedDestination = destination.replaceAll("'", "''");
        run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`], root);
      } else {
        run("unzip", ["-q", archive, "-d", destination], root);
      }
    } else {
      run("tar", ["-xzf", archive, "-C", destination], root);
    }
    const packageRoot = join(destination, expectedRoot);
    run(packageManager, ["install", "--frozen-lockfile", "--ignore-scripts"], packageRoot);
    const state = join(destination, "state");
    const inputFile = join(packageRoot, "install-smoke-input.json");
    await writeFile(inputFile, `${JSON.stringify({ text: "ODINN_INSTALL_OK" })}\n`);
    run(packageManager, ["odinn", "onboard", "--state", state], packageRoot);
    const output = run(packageManager, ["odinn", "run", "--tool", "text.echo", "--input-file", inputFile, "--state", state], packageRoot);
    if (!output.includes("ODINN_INSTALL_OK")) throw new Error(`installed ${basename(archive)} did not execute the CLI smoke: ${output}`);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

console.log(`verified clean-tree install and CLI execution for both Odinn Forge ${pkg.version} source archives`);
