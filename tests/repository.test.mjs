import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("package metadata names Odinn and pins the toolchain", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.name, "odinn");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines.node, ">=24.0.0");
});

test("required CI/CD workflows exist", async () => {
  for (const workflow of ["ci.yml", "security.yml", "release-please.yml", "release.yml", "nightly.yml"]) {
    const content = await read(`.github/workflows/${workflow}`);
    assert.match(content, /^name:/m);
    assert.match(content, /^permissions:/m);
  }
});

test("obsolete technical identifiers are absent from canonical metadata", async () => {
  for (const file of ["package.json", "pnpm-workspace.yaml", "README.md"]) {
    const content = await read(file);
    assert.doesNotMatch(content, /@othin\//i);
    assert.doesNotMatch(content, /OTHIN_[A-Z0-9_]+/);
    assert.doesNotMatch(content, /\.othin(?:[/\\]|$)/i);
  }
});
