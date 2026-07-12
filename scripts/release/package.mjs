import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, "dist", "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = `odinn-v${pkg.version}`;
await mkdir(output, { recursive: true });

function archive(format, extension) {
  const destination = join(output, `${base}.${extension}`);
  const result = spawnSync(
    "git",
    ["archive", `--format=${format}`, `--prefix=${base}/`, `--output=${destination}`, "HEAD"],
    { cwd: root, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`git archive (${format}) failed: ${result.stderr || result.stdout}`);
  return destination;
}

const artifacts = [archive("zip", "zip"), archive("tar.gz", "tar.gz")];
const manifest = {
  name: pkg.name,
  version: pkg.version,
  commit: process.env.GITHUB_SHA ?? spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  artifacts: artifacts.map((path) => path.slice(output.length + 1)),
  createdAt: new Date().toISOString()
};
await writeFile(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
