import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const read = (path: any) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("package metadata names Odinn Forge and pins the toolchain", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.name, "odinn");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.bin.odinn, "./apps/cli/src/cli.ts");
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

test("third-party workflow actions are pinned to immutable commit SHAs", async () => {
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  for (const file of await readdir(workflowRoot)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const content = await readFile(new URL(file, workflowRoot), "utf8");
    for (const match of content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/gm)) {
      const reference = match[1];
      if (reference.startsWith("./")) continue;
      if (reference.startsWith("docker://")) assert.match(reference, /@sha256:[a-f0-9]{64}$/, `${file} contains a movable container reference: ${reference}`);
      else assert.match(reference, /@[a-f0-9]{40}$/, `${file} contains a movable action reference: ${reference}`);
      assert.ok(match[2], `${file} must retain a readable version comment for ${reference}`);
    }
  }
});

test("workflow Node entrypoints exist after source migrations", async () => {
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  for (const file of await readdir(workflowRoot)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const content = await readFile(new URL(file, workflowRoot), "utf8");
    for (const match of content.matchAll(/\bnode\s+(scripts\/[A-Za-z0-9_./-]+\.[cm]?[jt]s)\b/g)) {
      await assert.doesNotReject(
        readFile(new URL(`../${match[1]}`, import.meta.url)),
        `${file} references missing Node entrypoint ${match[1]}`
      );
    }
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
