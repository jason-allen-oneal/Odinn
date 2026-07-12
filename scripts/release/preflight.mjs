import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const required = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "pnpm-lock.yaml",
  ".github/workflows/ci.yml",
  ".github/workflows/security.yml",
  ".github/workflows/release.yml"
];

for (const path of required) {
  if (!existsSync(join(root, path))) throw new Error(`release preflight: missing ${path}`);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error(`release preflight: invalid package version ${pkg.version}`);
}

const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
if (refType === "tag") {
  const expected = `v${pkg.version}`;
  if (refName !== expected) throw new Error(`release preflight: tag ${refName} does not match package version ${expected}`);
}

const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status !== 0) throw new Error("release preflight: git status failed");
const relevantChanges = status.stdout
  .split("\n")
  .filter(Boolean)
  .filter((line) => !/^(?:\?\?| M|M |A |D ) (?:dist|coverage|\.reports)(?:[/\\]|$)/.test(line));
if (process.env.CI !== "true" && relevantChanges.length > 0) {
  throw new Error(`release preflight: working tree is not clean:\n${relevantChanges.join("\n")}`);
}

console.log(JSON.stringify({ name: pkg.name, version: pkg.version, tag: `v${pkg.version}`, ready: true }, null, 2));
