process.env.ODINN_GATEWAY_AUTH = "off";
process.env.ODINN_BROWSER_HEADLESS = "1";

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { createGatewayServer } from "../apps/gateway/src/server.ts";

const workspaceRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function section(html: string, start: RegExp, end: RegExp) {
  const startMatch = start.exec(html);
  assert.ok(startMatch, `missing section start ${start}`);
  const tail = html.slice(startMatch.index);
  const endMatch = end.exec(tail.slice(startMatch[0].length));
  assert.ok(endMatch, `missing section end ${end}`);
  return tail.slice(0, startMatch[0].length + endMatch.index + endMatch[0].length);
}

function assertIds(html: string, ids: string[]) {
  for (const id of ids) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
}

test("console presents the consolidated, scoped product surfaces", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-console-product-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);
    assert.equal(inlineScripts.length, 1);
    assert.doesNotThrow(() => new Script(inlineScripts[0], { filename: "odinn-console.js" }));

    const navigation = section(html, /<nav class="nav"[^>]*>/, /<\/nav>/);
    assert.doesNotMatch(navigation, />\s*Activity\s*</i);
    assert.equal(navigation.match(/data-view="audit"/g)?.length ?? 0, 1, "Audit must have exactly one navigation target");
    assert.doesNotMatch(navigation, /data-view="(?:skill-workshop|workshop)"|>\s*Skill Workshop\s*</i);
    assert.match(navigation, /data-view="skills"[^>]*data-title="Skill SDK"/);
    assert.match(navigation, /data-view="projects"[^>]*data-title="Projects"/);

    const skills = section(html, /<section id="view-skills"[^>]*>/, /<\/section>/);
    assert.match(skills, /Skill SDK v0\.1/);
    assert.match(skills, /Package inspector/);
    assertIds(skills, ["new-skill", "skill-status-filter", "skill-enable", "skill-disable", "skill-verify", "skill-quarantine"]);
    assert.doesNotMatch(skills, /Skill Workshop|id="view-(?:skill-workshop|workshop)"/i);

    const audit = section(html, /<section id="view-audit"[^>]*>/, /<\/section>/);
    assertIds(audit, [
      "audit-query",
      "audit-type-filter",
      "audit-tool-filter",
      "audit-actor-filter",
      "audit-outcome-filter",
      "audit-from",
      "audit-to",
      "audit-reset",
      "audit-verify",
      "export-audit",
      "audit-page-size",
      "audit-prev",
      "audit-next",
      "audit-page-label"
    ]);
    assert.match(html, /api\("\/audit\/query\?/);

    const projects = section(html, /<section id="view-projects"[^>]*>/, /<\/section>/);
    assertIds(projects, ["new-project", "project-list", "project-detail", "project-open-sessions", "project-open-goals", "project-archive", "project-form"]);
    assert.match(projects, /Group related sessions/);

    const goals = section(html, /<section id="view-goals"[^>]*>/, /<\/section>/);
    assertIds(goals, ["goal-scope-type", "goal-scope-id", "goal-project-filter", "goal-description", "goal-list"]);
    assert.match(goals, /Every goal belongs to a project or one specific session/);

    const memory = section(html, /<section id="view-memory"[^>]*>/, /<\/section>/);
    assertIds(memory, [
      "memory-health",
      "memory-record-count",
      "memory-recall-status",
      "memory-query",
      "memory-kind-filter",
      "memory-scope-filter",
      "memory-list",
      "memory-detail",
      "memory-correct",
      "memory-recall-test",
      "memory-scope-type",
      "memory-scope-id",
      "memory-correction-form"
    ]);
    assert.match(memory, /Global, project, and session context stay separated/);

    const agents = section(html, /<section id="view-agents"[^>]*>/, /<\/section>/);
    assert.match(agents, /<label class="switch-label"><input type="checkbox" id="agent-advanced-toggle"> Edit full manifest JSON<\/label>/);
    assertIds(agents, ["manifest-fields", "agent-manifest", "agent-manifest-error"]);
    assert.match(html, /function readAgentManifestFields\s*\(/);
    assert.match(html, /function writeAgentManifestFields\s*\(/);
    assert.match(html, /function setAgentAdvanced\s*\(/);
    assert.match(html, /setAgentAdvanced\(event\.target\.checked\)/);
    assert.match(html, /agentManifestDraft/);
    assert.match(html, /state\.agentManifestDraft = JSON\.parse/);
    assert.match(html, /\.\.\.\(state\.agentManifestDraft \|\| \{\}\)/);

    const experiments = section(html, /<section id="view-experiments"[^>]*>/, /<section id="view-audit"[^>]*>/);
    assertIds(experiments, ["beta-boundary", "beta-boundary-title"]);
    assert.equal(experiments.match(/data-boundary-class=/g)?.length ?? 0, 4);
    assert.match(experiments, /Verified local behavior/);
    assert.match(experiments, /Experimental and disabled by default/);
    assert.match(experiments, /Provider- or platform-dependent/);
    assert.match(experiments, /Explicitly unsupported/);
    assert.match(experiments, /Forked workers are crash containment, not a security sandbox\./);
    assert.match(experiments, /Remote hosting is application-level tenant isolation, not hostile-user OS isolation\./);
    assert.match(experiments, /External effects and nondeterministic provider behavior are outside full replay\/rollback guarantees\./);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  }
});
