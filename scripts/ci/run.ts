import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mode = process.argv[2];
const ignored = new Set([".git", "node_modules", "dist", "coverage", ".pnpm-store"]);
const textExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".ts", ".mts",
  ".scss", ".sh", ".ts", ".tsx", ".yaml", ".yml"
]);

async function walk(directory: any): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else output.push(absolute);
  }
  return output;
}

async function textFiles() {
  return (await walk(root)).filter((file: any) => textExtensions.has(extname(file)));
}

function fail(messages: any) {
  for (const message of messages) console.error(message);
  process.exitCode = 1;
}

async function checkFormat() {
  const errors = [];
  for (const file of await textFiles()) {
    const content = await readFile(file, "utf8");
    const name = relative(root, file);
    if (content.length > 0 && !content.endsWith("\n")) errors.push(`${name}: missing final newline`);
    content.split("\n").forEach((line: any, index: any) => {
      if (/[ \t]+$/.test(line)) errors.push(`${name}:${index + 1}: trailing whitespace`);
    });
    if (extname(file) === ".json") {
      try { JSON.parse(content); } catch (error: any) { errors.push(`${name}: invalid JSON: ${error.message}`); }
    }
  }
  if (errors.length) fail(errors);
  else console.log("format contract passed");
}

async function lintRepository() {
  const errors = [];
  const forbidden = [/@othin\//gi, /OTHIN_[A-Z0-9_]+/g, /\.othin(?:[/\\]|$)/gi, /\bothin\.json\b/gi];
  for (const file of await textFiles()) {
    const content = await readFile(file, "utf8");
    const name = relative(root, file);
    for (const pattern of forbidden) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) errors.push(`${name}: contains obsolete Othin technical identifier (${pattern})`);
    }
    if ((extname(file) === ".yml" || extname(file) === ".yaml") && /^\t/m.test(content)) {
      errors.push(`${name}: YAML indentation must not use tabs`);
    }
  }
  if (errors.length) fail(errors);
  else console.log("repository lint passed");
}

async function workspacePackageCount() {
  let count = 0;
  for (const base of ["apps", "packages", "adapters"]) {
    const absolute = join(root, base);
    if (!existsSync(absolute)) continue;
    for (const file of await walk(absolute)) if (file.endsWith("package.json")) count += 1;
  }
  return count;
}

function runWorkspaceScript(script: any) {
  const result = spawnSync(
    "pnpm",
    ["--recursive", "--if-present", "--filter", "./apps/**", "--filter", "./packages/**", "--filter", "./adapters/**", "run", script],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" }
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function typecheck() {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (rootPackage.engines?.node !== ">=24.0.0") fail(["package.json: engines.node must remain >=24.0.0"]);
  if (await workspacePackageCount()) runWorkspaceScript("typecheck");
  for (const config of ["tsconfig.tools.json"]) {
    const tools = spawnSync("pnpm", ["exec", "tsc", "-p", config], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    if (tools.stdout) process.stdout.write(tools.stdout);
    if (tools.stderr) process.stderr.write(tools.stderr);
    if (tools.status !== 0) process.exit(tools.status ?? 1);
  }
  if (!process.exitCode) console.log("typecheck contract passed");
}

async function build() {
  if (await workspacePackageCount()) runWorkspaceScript("build");
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  if (result.status !== 0) throw new Error("git ls-files failed");
  const files = result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const entries = [];
  for (const name of files) {
    const absolute = join(root, name);
    if (!existsSync(absolute) || (await stat(absolute)).isDirectory()) continue;
    const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
    entries.push({ path: name.replaceAll("\\", "/"), sha256: digest });
  }
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "build-manifest.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), files: entries }, null, 2)}\n`);
  console.log(`build manifest contains ${entries.length} tracked files`);
}

switch (mode) {
  case "format": await checkFormat(); break;
  case "lint": await lintRepository(); break;
  case "typecheck": await typecheck(); break;
  case "build": await build(); break;
  default: throw new Error(`Unknown CI mode: ${mode ?? "(missing)"}`);
}
