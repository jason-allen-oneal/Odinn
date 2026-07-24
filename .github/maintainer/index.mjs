import { appendFile, readFile } from "node:fs/promises";
import { buildSnapshot, GitHubApi, renderComment, resolveTarget, reviewWithOAuthModel, upsertComment } from "./core.mjs";

function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  return appendFile(path, `${name}=${String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`);
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) : {};
  const repository = process.env.GITHUB_REPOSITORY;
  const target = resolveTarget({ eventName, payload, manualNumber: process.env.ODINN_MAINTAINER_NUMBER });
  const api = new GitHubApi({ token: process.env.GITHUB_TOKEN, repository });
  const snapshot = await buildSnapshot(api, target);
  const model = process.env.ODINN_MAINTAINER_MODEL || "gpt-5.5";
  const review = await reviewWithOAuthModel(snapshot, {
    oauthJson: process.env.ODINN_OPENAI_OAUTH_JSON,
    model,
    tokenUrl: process.env.ODINN_OPENAI_OAUTH_TOKEN_URL || "https://auth.openai.com/oauth/token",
    clientId: process.env.ODINN_OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
    baseUrl: process.env.ODINN_OPENAI_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex",
    originator: process.env.ODINN_OPENAI_ORIGINATOR || "openclaw",
    clientVersion: process.env.ODINN_OPENAI_CLIENT_VERSION || "2026.6.11"
  });
  await upsertComment(api, snapshot, renderComment(snapshot, review, { model }));
  await output("decision", review.decision);
  await output("confidence", review.confidence);
  await output("number", snapshot.number);
  console.log(JSON.stringify({ ok: true, repository, number: snapshot.number, kind: snapshot.kind, decision: review.decision, confidence: review.confidence }));
}

main().catch((error) => {
  console.error(`Odinn Maintainer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
