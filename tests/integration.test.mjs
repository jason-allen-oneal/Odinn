import assert from "node:assert/strict";
import test from "node:test";
import { runInferenceProtocolSmoke } from "../scripts/ci/inference-smoke.mjs";

test("packaged gateway routes a configured provider and persists the response", async () => {
  const payload = await runInferenceProtocolSmoke();
  assert.equal(payload.content, "ODINN_PACKAGED_GATEWAY_OK");
  assert.equal(payload.usage.total_tokens, 8);
});
