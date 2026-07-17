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

    const overview = section(html, /<section id="view-overview"[^>]*>/, /<\/section>/);
    assertIds(overview, ["chat-recap", "chat-recap-meta", "chat-recap-body", "chat-recap-toggle"]);
    assert.match(overview, /id="chat-recap"[^>]*hidden[^>]*aria-label="Conversation recap"/);
    assert.match(overview, /id="chat-recap-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="chat-recap-body"/);
    assert.match(html, /function recapSnippet\s*\(/);
    assert.match(html, /function updateConversationRecap\s*\(/);
    assert.match(html, /\["user", "assistant"\]\.includes\(message\.role\)/);
    assert.match(html, /entries\.slice\(-6\)/);
    assert.match(html, /escapeHtml\(entry\.content\)/);
    assert.match(html, /panel\.classList\.toggle\("collapsed"\)/);
    assert.match(html, /No new model call was made/);
    assert.match(html, /updateConversationRecap\("chat-recap"/);
    assert.match(html, /updateConversationRecap\("session-recap"/);

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

    const sessions = section(html, /<section id="view-sessions"[^>]*>/, /<\/section>/);
    assertIds(sessions, ["session-recap", "session-recap-meta", "session-recap-body", "session-transcript"]);

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
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  }
});
