import assert from "node:assert/strict";
import { delimiter, join, normalize } from "node:path";
import test from "node:test";

const supported = new Set(["linux", "darwin", "win32"]);

test("CI host is an Odinn Forge-supported operating system", () => {
  assert.ok(supported.has(process.platform), `unsupported CI platform: ${process.platform}`);
});

test("path construction uses the host path implementation", () => {
  const value = join("odinn", "state", "events.db");
  assert.equal(value, normalize(value));
  assert.ok(value.includes("odinn"));
});

test("PATH delimiter matches the current platform", () => {
  assert.equal(delimiter, process.platform === "win32" ? ";" : ":");
});
