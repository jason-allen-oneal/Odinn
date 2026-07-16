import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("native installer upgrades by atomic pointer and rolls back to the previous application", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "odinn-native-install-"));
  run(["install", "--source", root, "--prefix", prefix, "--version", "0.1.0", "--skip-deps"]);
  const first = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  run(["upgrade", "--source", root, "--prefix", prefix, "--version", "0.1.1", "--skip-deps"]);
  const upgraded = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  assert.notEqual(upgraded.current, first.current);
  assert.equal(upgraded.previous, first.current);
  run(["rollback", "--prefix", prefix]);
  const rolledBack = JSON.parse(await readFile(join(prefix, "install-state.json"), "utf8"));
  assert.equal(rolledBack.current, first.current);
  assert.equal(rolledBack.previous, upgraded.current);
});

function run(args: any) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "install.ts"), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
