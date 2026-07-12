import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = join(root, "dist", "release");
const files = (await readdir(directory))
  .filter((name) => name !== "SHA256SUMS.txt")
  .sort();

const lines = [];
for (const name of files) {
  const digest = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
  lines.push(`${digest}  ${name}`);
}

if (lines.length === 0) throw new Error("no release artifacts found for checksums");
await writeFile(join(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
