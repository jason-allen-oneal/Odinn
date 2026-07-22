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

test("local package operations have conservative resource limits", async () => {
  const npmrc = await read(".npmrc");
  assert.match(npmrc, /^child-concurrency=1$/m);
  assert.match(npmrc, /^workspace-concurrency=1$/m);
  assert.match(npmrc, /^node-options=--max-old-space-size=1536$/m);

  const runner = await read("scripts/ci/run.ts");
  assert.match(runner, /ODINN_WORKSPACE_CONCURRENCY/);
  assert.match(runner, /ODINN_NODE_MAX_OLD_SPACE_MB/);
  assert.match(runner, /--workspace-concurrency=\$\{workspaceConcurrency\}/);
});

test("required CI/CD workflows exist", async () => {
  for (const workflow of ["ci.yml", "security.yml", "release-please.yml", "release.yml", "nightly.yml"]) {
    const content = await read(`.github/workflows/${workflow}`);
    assert.match(content, /^name:/m);
    assert.match(content, /^permissions:/m);
  }
});

test("Release Please hands token-created tags to the protected release workflow", async () => {
  const releasePlease = await read(".github/workflows/release-please.yml");
  const release = await read(".github/workflows/release.yml");
  const config = JSON.parse(await read("release-please-config.json"));

  assert.match(releasePlease, /release_created:\s*\$\{\{ steps\.release\.outputs\.release_created \}\}/);
  assert.match(releasePlease, /uses:\s*\.\/\.github\/workflows\/release\.yml/);
  assert.match(releasePlease, /tag:\s*\$\{\{ needs\.release_please\.outputs\.tag_name \}\}/);
  assert.match(releasePlease, /if:\s*steps\.release\.outputs\.prs_created == 'true'/);
  for (const workflow of ["ci.yml", "package-integrity.yml", "workflow-lint.yml", "security.yml", "pr-title.yml"]) {
    assert.match(releasePlease, new RegExp(`gh workflow run ${workflow.replace(".", "\\.")} --repo "\\$GITHUB_REPOSITORY"`));
  }
  assert.match(release, /^\s{2}workflow_call:/m);
  assert.match(release, /\*-\*\) prerelease=\(--prerelease\)/);
  assert.equal(config.packages["."].versioning, "prerelease");
  assert.equal(config.packages["."]["prerelease-type"], "beta");
  assert.equal(config.packages["."].prerelease, true);
});

test("dispatched release pull requests receive dependency and title checks", async () => {
  const security = await read(".github/workflows/security.yml");
  const title = await read(".github/workflows/pr-title.yml");
  assert.match(security, /inputs\.base_sha != '' && inputs\.head_sha != ''/);
  assert.match(security, /github\.event\.pull_request\.base\.sha \|\| inputs\.base_sha/);
  assert.match(
    security,
    /github\.event_name != 'workflow_dispatch' \|\| github\.ref_name == github\.event\.repository\.default_branch/,
  );
  assert.match(title, /github\.event\.pull_request\.title \|\| inputs\.pr_title/);
});

test("public beta support and reporting surfaces ship in the release tree", async () => {
  for (const path of [
    "docs/public-beta.md",
    "docs/BETA-4-STABLE-EXIT.md",
    "docs/BETA-3-SURFACE-MATRIX.md",
    ".github/ISSUE_TEMPLATE/bug-report.yml",
    ".github/ISSUE_TEMPLATE/feature-request.yml",
    ".github/ISSUE_TEMPLATE/config.yml"
  ]) {
    assert.ok((await read(path)).trim().length > 0, `${path} must not be empty`);
  }
  const betaGuide = await read("docs/public-beta.md");
  assert.doesNotMatch(betaGuide, /v\d+\.\d+\.\d+-beta\.\d+/);
  assert.match(betaGuide, /registration and discovery do not execute or activate/u);
  assert.doesNotMatch(betaGuide, /attachments sent to their configured API/u);
  const stableExit = await read("docs/BETA-4-STABLE-EXIT.md");
  assert.match(stableExit, /No unresolved production CodeQL alerts/u);
  assert.match(stableExit, /Linux[\s\S]*macOS[\s\S]*Windows/u);
  assert.match(stableExit, /one cloud OAuth path, one API-key path, and one local Ollama path/u);
  const matrix = await read("docs/BETA-3-SURFACE-MATRIX.md");
  for (const label of [
    "verified local behavior",
    "experimental and disabled by default",
    "provider- or platform-dependent",
    "explicitly unsupported"
  ]) assert.match(matrix, new RegExp(label, "i"));
  assert.match(matrix, /forked workers are crash containment, not a security sandbox/i);
  assert.match(matrix, /remote hosting is application-level tenant isolation, not hostile-user OS isolation/i);
  assert.match(matrix, /external effects and nondeterministic provider behavior are outside full replay\/rollback guarantees/i);
});

test("release packaging removes stale assets before creating a version", async () => {
  const packaging = await read("scripts/release/package.ts");
  assert.match(packaging, /rm\(output, \{ recursive: true, force: true \}\)/);
  assert.ok(packaging.indexOf("rm(output") < packaging.indexOf("mkdir(output"));
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
