import assert from "node:assert/strict";
import test from "node:test";
import { runInferenceProtocolSmoke } from "../scripts/ci/inference-smoke.mjs";

test("OpenAI-compatible inference protocol round trip", async () => {
  const payload = await runInferenceProtocolSmoke();
  assert.equal(payload.choices[0].message.content, "ODINN_INFERENCE_PROTOCOL_OK");
  assert.equal(payload.usage.total_tokens, 8);
});
