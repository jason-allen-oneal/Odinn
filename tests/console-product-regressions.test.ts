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

function openingTagById(html: string, id: string) {
  const match = new RegExp(`<[^>]+\\bid=["']${id}["'][^>]*>`, "iu").exec(html);
  assert.ok(match, `missing opening tag for #${id}`);
  return match[0];
}

function cssBlocks(source: string, header: RegExp) {
  const flags = header.flags.includes("g") ? header.flags : `${header.flags}g`;
  const matches = source.matchAll(new RegExp(header.source, flags));
  const blocks: string[] = [];
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    const openingBrace = source.indexOf("{", matchIndex);
    assert.notEqual(openingBrace, -1, `missing opening brace for ${header}`);
    let depth = 0;
    for (let index = openingBrace; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(matchIndex, index + 1));
        break;
      }
    }
  }
  return blocks;
}

test("console presents the human-first product surfaces and dedicated Labs pages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-console-product-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const statusResponse = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(statusResponse.status, 200);
    const runtimeStatus = await statusResponse.json();
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/giu)].map((match) => match[1]);
    assert.equal(inlineScripts.length, 1);
    assert.doesNotThrow(() => new Script(inlineScripts[0], { filename: "odinn-console.js" }));

    const navigation = section(html, /<nav class="nav"[^>]*>/, /<\/nav>/);
    assert.match(navigation, /data-view="overview"[\s\S]*data-view="sessions"/, "Sessions must sit directly below Chat");
    assert.match(navigation, /data-view="usage"[^>]*data-title="Activity"/);
    assert.doesNotMatch(navigation, /data-view="audit"/);
    assert.doesNotMatch(navigation, /data-view="experiments"/);
    assert.match(navigation, /<details class="nav-labs">/);
    assert.doesNotMatch(navigation, /data-view="(?:skill-workshop|workshop)"|>\s*Skill Workshop\s*</i);
    assert.match(navigation, /data-view="agents"[^>]*data-title="Agent SDK"/);
    assert.match(navigation, /data-view="skills"[^>]*data-title="Skills SDK"/);
    assert.match(navigation, /data-view="projects"[^>]*data-title="Projects"/);
    assert.match(navigation, /data-view="config"[^>]*data-title="Configuration"/);

    const viewMatches = [...html.matchAll(/<section\b[^>]*\bid=["']view-([^"']+)["'][^>]*>/giu)].map((match) => match[1]);
    const navigationMatches = [...navigation.matchAll(/\bdata-view=["']([^"']+)["']/giu)].map((match) => match[1]);
    const views = [...new Set(viewMatches)];
    const navigationTargets = [...new Set(navigationMatches)];
    assert.equal(views.length, 20, "the console must expose the product surface plus seven dedicated Labs pages");
    assert.equal(viewMatches.length, views.length, "console view ids must be unique");
    assert.equal(navigationMatches.length, navigationTargets.length, "console navigation targets must be unique");
    assert.deepEqual(
      [...navigationTargets].sort(),
      [...views].sort(),
      "every console view must have exactly one reachable navigation target"
    );
    assert.ok(navigationTargets.includes("capabilities"), "Web tools must be reachable from navigation");

    const skills = section(html, /<section id="view-skills"[^>]*>/, /<\/section>/);
    assert.match(skills, /<h1>Skills SDK<\/h1>/);
    assert.match(skills, /Build, review, and manage reusable instructions/);
    assert.match(skills, /Create (?:a )?skill/i);
    assertIds(skills, ["new-skill", "skill-status-filter", "skill-enable", "skill-disable", "skill-verify", "skill-quarantine"]);
    assert.doesNotMatch(skills, /Package ID|Network allowlist/);
    assert.doesNotMatch(skills, /Skill Workshop|id="view-(?:skill-workshop|workshop)"/i);

    const activity = section(html, /<section id="view-usage"[^>]*>/, /<section id="view-agents"[^>]*>/);
    assertIds(activity, [
      "activity-tab-overview",
      "activity-tab-history",
      "activity-overview",
      "activity-history",
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
    assert.match(activity, /Latest four conversations/);
    assert.match(html, /api\("\/audit\/query\?/);
    assert.match(html, /\.slice\(0,\s*4\)\.map\(renderRun\)/);

    const projects = section(html, /<section id="view-projects"[^>]*>/, /<\/section>/);
    assertIds(projects, ["new-project", "project-list", "project-detail", "project-open-sessions", "project-open-goals", "project-archive", "project-form"]);
    assert.match(projects, /Group related sessions/);

    const goals = section(html, /<section id="view-goals"[^>]*>/, /<\/section>/);
    assertIds(goals, ["new-goal", "goal-dialog", "goal-scope-type", "goal-scope-id", "goal-project-filter", "goal-status-filter", "goal-query", "goal-description", "goal-list"]);
    assert.match(goals, /update progress quickly/i);

    const config = section(html, /<section id="view-config"[^>]*>/, /<section id="view-automatic-improvements"[^>]*>/);
    assertIds(config, [
      "config-state", "config-error", "reload-config", "save-config", "config-restart", "config-form", "config-providers", "config-add-provider",
      "config-version", "config-audit-log", "config-default-model", "config-policy-max-input", "config-policy-id", "config-policy-version", "config-policy-allowed", "config-policy-denied",
      "config-web-allowed", "config-web-blocked", "config-browser-allowed", "config-browser-blocked", "config-invariants", "config-add-invariant",
      "config-self-mode", "config-self-interval", "config-self-max", "config-runtime-retries", "config-proof-commands", "config-add-command", "config-field-count"
    ]);
    assert.match(config, /Everything Ódinn can configure/);
    assert.match(config, /Model providers/);
    assert.match(config, /Sentinel invariants/);
    assert.match(config, /Proof command allowlist/);
    assert.match(config, /data-config-security="web\.requireApproval"/u);
    assert.match(config, /data-config-security="web\.allowDownloads"/u);
    assert.match(config, /data-config-security="web\.allowUploads"/u);
    assert.doesNotMatch(config, /<textarea[^>]+id=["']config-editor["']/i);
    assert.match(config, /\.odinn\/config\.json/);
    assert.match(config, /restart/i);

    const memory = section(html, /<section id="view-memory"[^>]*>/, /<\/section>/);
    assertIds(memory, [
      "memory-health",
      "memory-record-count",
      "memory-candidate-count",
      "memory-tab-suggestions",
      "memory-tab-saved",
      "memory-suggestions-panel",
      "memory-saved-panel",
      "memory-candidate-list",
      "memory-recall-status",
      "memory-query",
      "memory-kind-filter",
      "memory-scope-filter",
      "memory-list",
      "memory-detail",
      "memory-correct",
      "memory-forget",
      "memory-recall-test",
      "memory-recall-result",
      "memory-scope-type",
      "memory-scope-id",
      "memory-scope-target-field",
      "memory-dialog-close",
      "memory-correction-dialog-close",
      "memory-correction-form"
    ]);
    assert.match(memory, /Review what Ódinn has noticed/i);
    assert.match(memory, /Review suggestions/i);
    assert.match(memory, /Saved memories/i);
    assert.match(html, /Keep memory/i);
    assert.match(html, /Suggestion dismissed/i);
    assert.doesNotMatch(memory, /Select all|Accept selected|Reject selected|Keep suggested scope/i);
    assert.doesNotMatch(memory, />namespaces</i);
    assert.match(html, /function setMemoryTab\s*\(/);
    assert.match(html, /function decideMemoryCandidate\s*\(/);
    assert.match(html, /data-memory-candidate-destination/);

    const agents = section(html, /<section id="view-agents"[^>]*>/, /<\/section>/);
    assert.match(agents, /<h1>Agent SDK<\/h1>/);
    assert.match(agents, /<label class="switch-label"><input type="checkbox" id="agent-advanced-toggle"> Developer setup<\/label>/);
    assertIds(agents, ["manifest-fields", "agent-manifest", "agent-manifest-error"]);
    assert.doesNotMatch(agents, /Register Agent SDK manifest|Package ID|Network allowlist/);
    assert.match(html, /function readAgentManifestFields\s*\(/);
    assert.match(html, /function writeAgentManifestFields\s*\(/);
    assert.match(html, /function setAgentAdvanced\s*\(/);
    assert.match(html, /setAgentAdvanced\(event\.target\.checked\)/);
    assert.match(html, /agentManifestDraft/);
    assert.match(html, /state\.agentManifestDraft = JSON\.parse/);
    assert.match(html, /\.\.\.\(state\.agentManifestDraft \|\| \{\}\)/);

    const experiments = section(html, /<section id="view-automatic-improvements"[^>]*>/, /<section id="view-usage"[^>]*>/);
    assertIds(experiments, [
      "view-automatic-improvements",
      "view-lab-run-checks",
      "view-lab-safety-preview",
      "view-lab-temporary-access",
      "view-lab-restore-points",
      "view-lab-portable-runs",
      "view-lab-scenario-compare",
      "view-lab-model-routing"
    ]);
    assert.equal(experiments.match(/data-experimental-page=/g)?.length ?? 0, 7);
    assert.match(experiments, /Runs quietly in the background/);
    assert.match(experiments, /Experimental feature/);
    assert.doesNotMatch(experiments, /release blocker|release-blocker|review queue|content-addressed artifact store/i);
    assert.doesNotMatch(html, /id="view-experiments"/);

    const globalFeedback = openingTagById(html, "toast-region");
    assert.match(globalFeedback, /\baria-live=["'](?:polite|assertive)["']/iu);
    assert.doesNotMatch(globalFeedback, /\bhidden\b/iu, "the shared feedback region must remain perceivable");

    const styles = section(html, /<style>/iu, /<\/style>/iu);
    const mobileStyles = cssBlocks(styles, /@media\s*\(max-width:\s*980px\)/iu).join("\n");
    assert.ok(mobileStyles, "missing narrow-screen console styles");
    assertIds(html, ["mobile-scrim"]);
    assert.match(mobileStyles, /\.sidebar\s*\{[^}]*position:\s*fixed/isu, "mobile navigation must become an off-canvas layer");
    assert.match(mobileStyles, /\.sidebar\s*\{[^}]*transform:\s*translateX/isu, "mobile navigation must move off canvas when closed");
    assert.match(mobileStyles, /\.content\s*\{[^}]*overflow(?:-y)?:\s*auto/isu, "mobile page content must remain scrollable");
    assert.doesNotMatch(mobileStyles, /\.content\s*\{[^}]*overflow:\s*hidden/isu);
    assert.match(styles, /\.(?:table-panel|table-scroll)\s*\{[^}]*overflow-x:\s*auto/isu, "wide data tables need a containing horizontal scroll viewport");

    const script = inlineScripts[0];
    assert.match(script, /location\.hash/u, "view selection must be reflected in the URL hash");
    assert.match(script, /addEventListener\(["']hashchange["']/u, "browser Back and direct hashes must restore the selected view");
    assert.match(script, /api\(["']\/config["']\)/u, "the configuration page must load config.json");
    assert.match(script, /function readStructuredConfig\s*\(/u, "configuration saves must collect structured fields");
    assert.match(script, /data-provider-field/u, "provider configuration must use individual fields");
    assert.match(script, /data-provider-auth="commandEnv"/u, "CLI provider authentication must be configurable");
    assert.match(script, /method:\s*["']PUT["'][\s\S]{0,320}fingerprint/u, "configuration saves must use conflict protection");
    assert.match(script, /sidebar-settings["']\)\.addEventListener\(["']click["'],\s*\(\)\s*=>\s*switchView\(["']config["']\)/u);
    assert.match(
      script,
      /chat-input["']\)\.addEventListener\(["']keydown["'][\s\S]*event\.key === ["']Enter["'] && !event\.shiftKey && !event\.isComposing && event\.keyCode !== 229[\s\S]*send-chat["']\)\.click\(\)/u,
      "Enter must send chat while Shift+Enter remains available for a newline"
    );
    const sessionControls = section(script, /function sessionDisplayTitle\s*\(/u, /function renderChatMessages\s*\(/u);
    assert.match(sessionControls, /window\.prompt\("Rename chat", sessionDisplayTitle\(sessionId\)\)/u);
    assert.match(sessionControls, /const title = sessionDisplayTitle\(sessionId\);[\s\S]*window\.confirm/u);
    assert.doesNotMatch(
      sessionControls,
      /const detail = await api\("\/sessions\/"/u,
      "rename and delete confirmations must stay directly attached to the click gesture"
    );
    assert.match(html, /data-session-action="rename"[^>]*type="button"/u);
    assert.match(html, /data-session-action="delete"[^>]*type="button"/u);
    assert.doesNotMatch(
      script,
      /finally\s*\{[^}]*setBusy\(event\.currentTarget,\s*false\)/u,
      "async handlers must retain their button reference so busy controls are re-enabled"
    );

    assert.doesNotMatch(html, /<span class="sidebar-version">\s*v0\.1\s*<\/span>/iu);
    const renderedVersion = /<span\b(?=[^>]*\bid=["']product-version["'])[^>]*>\s*([^<]+?)\s*<\/span>/iu.exec(html)?.[1];
    assert.equal(renderedVersion, `v${runtimeStatus.version}`, "the sidebar version must match runtime status");
    const capabilities = section(html, /<section id="view-capabilities"[^>]*>/, /<\/section>/);
    assert.match(capabilities, /<h1>Web tools<\/h1>/);
    assert.match(capabilities, /Public web search/);
    assert.match(capabilities, /Signed-in browser/);
    assert.doesNotMatch(capabilities, /id=["']cap-(?:web|browser)-status["'][^>]*>\s*READY\s*</iu, "provider-dependent capabilities must not claim READY before status loads");
    assert.doesNotMatch(capabilities, /id=["']cap-approval-count["'][^>]*>\s*0\s*</iu, "approval totals must not claim zero before status loads");
    assert.match(script, /cap-security-mode[\s\S]{0,180}requireApproval|requireApproval[\s\S]{0,180}cap-security-mode/u, "approval posture copy must come from runtime status");

    assert.match(activity, /id=["']audit-verify["'][^>]*>\s*Check history integrity\s*</iu);
    assert.doesNotMatch(activity, />\s*Verify (?:Chain|Ledger)\s*</iu);
    assert.match(
      script,
      /agent-quarantine[\s\S]{0,1200}(?:confirmDangerousAction|window\.confirm)|(?:confirmDangerousAction|window\.confirm)[\s\S]{0,1200}agent-quarantine/iu,
      "quarantining an agent needs explicit confirmation"
    );
    assert.match(
      script,
      /skill-quarantine[\s\S]{0,1200}(?:confirmDangerousAction|window\.confirm)|(?:confirmDangerousAction|window\.confirm)[\s\S]{0,1200}skill-quarantine/iu,
      "quarantining a skill needs explicit confirmation"
    );

    assertIds(html, ["provider-cta"]);
    assert.match(script, /\$\(["']provider-cta["']\)/u);
    const providerCopy = section(script, /function renderChatMessages\s*\(/u, /async function createChat\s*\(/u);
    assert.match(script, /providers[\s\S]{0,240}configured/u, "Chat readiness must use configured provider state");
    assert.doesNotMatch(providerCopy, /const configured = state\.status\?\.models\?\.length/u);
    assert.doesNotMatch(html, /id="(?:health|copy-status|quick-smoke|chat-smoke)"/u);
    assertIds(html, ["task-page-size", "task-prev", "task-next", "task-select-page", "task-rerun-selected", "task-cancel-selected"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  }
});
