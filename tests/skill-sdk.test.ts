import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SkillPackageStore, validateSkillPackage } from "../packages/kernel/src/index.ts";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    sdkVersion: "0.1",
    id: "web-research",
    version: "1.0.0",
    name: "Web Research",
    description: "Researches public sources with a bounded evidence workflow.",
    instructions: "Search approved public sources, compare the evidence, and return a concise cited summary.",
    requestedTools: ["web.search", "web.fetch", "web.search", ""],
    requestedCapabilities: ["web.read"],
    requestedSecrets: [],
    network: { default: "deny", allow: ["example.com", "*.example.org"] },
    tests: [{ name: "returns cited evidence" }],
    ...overrides
  };
}

async function fixture(t: test.TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-skill-sdk-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, store: new SkillPackageStore(stateDir) };
}

test("skill package validation normalizes the manifest and binds its generated content to integrity", () => {
  const validated = validateSkillPackage(manifest());

  assert.equal(validated.manifest.sdkVersion, "0.1");
  assert.deepEqual(validated.manifest.requestedTools, ["web.search", "web.fetch"]);
  assert.deepEqual(validated.manifest.network, { default: "deny", allow: ["example.com", "*.example.org"] });
  assert.match(validated.skillContent, /^---\nname: "web-research"/u);
  assert.match(validated.skillContent, /# Web Research/u);
  assert.match(validated.fileIntegrity["SKILL.md"], /^[a-f0-9]{64}$/u);
  assert.match(validated.integrity, /^[a-f0-9]{64}$/u);
  assert.equal(validated.validation.valid, true);

  assert.throws(
    () => validateSkillPackage({ ...manifest(), integrity: "0".repeat(64) }),
    /skill package integrity mismatch/u
  );
});

test("skill package validation rejects traversal identifiers, traversal versions, and invalid network domains", () => {
  assert.throws(() => validateSkillPackage(manifest({ id: "../escape" })), /skill id must be/u);
  assert.throws(() => validateSkillPackage(manifest({ version: "1.0.0/../../escape" })), /skill version must be semantic/u);
  assert.throws(
    () => validateSkillPackage(manifest({ network: { default: "deny", allow: ["example..com"] } })),
    /invalid skill network domain: example\.\.com/u
  );
  assert.throws(
    () => validateSkillPackage(manifest({ network: { default: "deny", allow: ["https:\/\/example.com"] } })),
    /invalid skill network domain/u
  );
});

test("skill packages install disabled and untrusted, verify cleanly, and require an explicit enable", async (t) => {
  const { stateDir, store } = await fixture(t);
  const installed = await store.install(manifest());

  assert.equal(installed.status, "disabled");
  assert.equal(installed.trusted, false);
  assert.equal(installed.previousVersion, undefined);
  assert.equal(installed.packagePath, resolve(stateDir, "skills", "packages", "web-research", "1.0.0"));
  assert.deepEqual(installed.verification, { valid: true, failures: [] });
  assert.equal((await store.verify("web-research")).valid, true);

  const persistedManifest = JSON.parse(await readFile(join(installed.packagePath, "skill.json"), "utf8"));
  assert.equal(persistedManifest.integrity, installed.integrity);
  assert.deepEqual(persistedManifest.fileIntegrity, installed.fileIntegrity);

  const enabled = await store.transition("web-research", "enable");
  assert.equal(enabled.status, "enabled");
  assert.equal(enabled.trusted, true);
  assert.equal(enabled.verification.valid, true);

  const [listed] = await store.list();
  assert.equal(listed.status, "enabled");
  assert.equal(listed.trusted, true);
  assert.equal(listed.verification.valid, true);
});

test("modified managed skill content fails verification and is persistently quarantined", async (t) => {
  const { stateDir, store } = await fixture(t);
  const installed = await store.install(manifest());
  await store.transition("web-research", "enable");
  await writeFile(join(installed.packagePath, "SKILL.md"), "tampered instructions\n", "utf8");

  const verification = await store.verify("web-research");
  assert.equal(verification.valid, false);
  assert.ok(verification.failures.includes("SKILL.md digest mismatch"));
  await assert.rejects(() => store.transition("web-research", "enable"), /failed integrity verification/u);

  const persistedAfterRejection = JSON.parse(await readFile(join(stateDir, "skills", "registry.json"), "utf8"));
  assert.equal(persistedAfterRejection.packages[0].status, "quarantined");
  assert.equal(persistedAfterRejection.packages[0].trusted, false);

  const [quarantined] = await store.list();
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.trusted, false);
  assert.equal(quarantined.verification.valid, false);

  const registry = JSON.parse(await readFile(join(stateDir, "skills", "registry.json"), "utf8"));
  assert.equal(registry.packages[0].status, "quarantined");
  assert.equal(registry.packages[0].trusted, false);
});

test("modified managed skill metadata fails verification and is quarantined", async (t) => {
  const { store } = await fixture(t);
  const installed = await store.install(manifest());
  const metadataPath = join(installed.packagePath, "skill.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.requestedCapabilities = ["credential.read"];
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const verification = await store.verify("web-research");
  assert.equal(verification.valid, false);
  assert.ok(verification.failures.includes("skill.json metadata mismatch"));
  const [quarantined] = await store.list();
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.trusted, false);
});

test("registry package path traversal is detected and quarantined", async (t) => {
  const { stateDir, store } = await fixture(t);
  await store.install(manifest());
  const registryPath = join(stateDir, "skills", "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.packages[0].packagePath = join(stateDir, "..", "escaped-skill");
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const verification = await store.verify("web-research");
  assert.equal(verification.valid, false);
  assert.ok(verification.failures.includes("package path escaped managed storage"));

  const [quarantined] = await store.list();
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.trusted, false);
});

test("installing a new skill version records the previous version and resets trust", async (t) => {
  const { store } = await fixture(t);
  await store.install(manifest());
  await store.transition("web-research", "enable");

  const updated = await store.install(manifest({ version: "1.1.0" }));
  assert.equal(updated.version, "1.1.0");
  assert.equal(updated.previousVersion, "1.0.0");
  assert.equal(updated.status, "disabled");
  assert.equal(updated.trusted, false);
  assert.equal((await store.verify("web-research")).valid, true);

  const packages = await store.list();
  assert.equal(packages.length, 1);
  assert.equal(packages[0].version, "1.1.0");
  assert.equal(packages[0].previousVersion, "1.0.0");
});

test("separate Skill SDK store instances serialize registry mutations without losing packages", async (t) => {
  const { stateDir } = await fixture(t);
  const firstStore = new SkillPackageStore(stateDir);
  const secondStore = new SkillPackageStore(stateDir);
  await Promise.all([
    firstStore.install(manifest({ id: "concurrent-first", name: "Concurrent First" })),
    secondStore.install(manifest({ id: "concurrent-second", name: "Concurrent Second" }))
  ]);
  const packages = await firstStore.list();
  assert.deepEqual(new Set(packages.map((entry) => entry.id)), new Set(["concurrent-first", "concurrent-second"]));
  assert.ok(packages.every((entry) => entry.status === "disabled" && entry.trusted === false && entry.verification.valid === true));
});
