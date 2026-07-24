import assert from "node:assert/strict";
import test from "node:test";
import { renderComment, resolveTarget, reviewWithOAuthModel, validateReview } from "../.github/maintainer/core.mjs";

test("resolves pull request and issue events", () => {
  assert.deepEqual(resolveTarget({ eventName: "pull_request_target", payload: { pull_request: { number: 12, title: "Fix" } } }), { kind: "pull_request", number: 12, title: "Fix" });
  assert.deepEqual(resolveTarget({ eventName: "issues", payload: { issue: { number: 13, title: "Question" } } }), { kind: "issue", number: 13, title: "Question" });
  assert.deepEqual(resolveTarget({ eventName: "workflow_dispatch", payload: { inputs: { kind: "issue" } }, manualNumber: "14" }), { kind: "issue", number: 14, title: "manual review" });
});

test("review output is conservative and bounded", () => {
  assert.deepEqual(validateReview({ decision: "needs_human", confidence: "medium", summary: "Needs a maintainer.", reason: "The evidence is incomplete.", evidence: [{ source: "body", detail: "The request needs context." }], recommendedNextStep: "Ask for clarification." }), {
    decision: "needs_human",
    confidence: "medium",
    summary: "Needs a maintainer.",
    reason: "The evidence is incomplete.",
    evidence: [{ source: "body", detail: "The request needs context." }],
    recommendedNextStep: "Ask for clarification."
  });
  assert.throws(() => validateReview({ decision: "close", confidence: "high", evidence: [] }), /unsupported/);
});

test("comment is sticky and identifies the reviewed source", () => {
  const body = renderComment({ kind: "pull_request", number: 42, sourceSha: "abc123" }, { decision: "keep_open", confidence: "high", summary: "Looks useful.", reason: "The change is scoped.", evidence: [], recommendedNextStep: "Continue review." }, { model: "test-model" });
  assert.match(body, /<!-- odinn-maintainer -->/);
  assert.match(body, /PR #42/);
  assert.match(body, /test-model/);
});

test("review uses Odinn OAuth refresh and the ChatGPT Codex Responses transport", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "access-refreshed", refresh_token: "refresh-new", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer access-refreshed");
    const request = JSON.parse(String(init.body));
    assert.equal(request.model, "gpt-5.5");
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    return new Response([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"decision\\":\\"needs_human\\",\\"confidence\\":\\"medium\\",\\"summary\\":\\"Needs review.\\",\\"reason\\":\\"Evidence is incomplete.\\",\\"evidence\\":[],\\"recommendedNextStep\\":\\"Ask a maintainer.\\"}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test"}}\n\n'
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const review = await reviewWithOAuthModel({ kind: "issue", number: 9, sourceSha: "updated" }, {
    oauthJson: JSON.stringify({ refresh_token: "refresh-old", expires_at: Date.now() - 1 }),
    fetchImpl
  });
  assert.equal(review.decision, "needs_human");
  assert.equal(calls.length, 2);
  const refreshBody = new URLSearchParams(String(calls[0].init.body));
  assert.equal(refreshBody.get("grant_type"), "refresh_token");
  assert.equal(refreshBody.get("refresh_token"), "refresh-old");
  assert.ok(!calls.some(({ init }) => String(init.body).includes("OPENAI_API_KEY")));
});
