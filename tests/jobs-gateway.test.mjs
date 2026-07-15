process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../apps/gateway/src/server.mjs";

test("gateway exposes durable jobs with idempotent submission", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-jobs-"));
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job_gateway_idempotent" },
      body: JSON.stringify({ task: { tool: "text.echo", input: { text: "ODINN_GATEWAY_JOB_OK" } } })
    });
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    assert.equal(firstBody.job.id, "job_gateway_idempotent");

    const replay = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job_gateway_idempotent" },
      body: JSON.stringify({ task: { tool: "text.echo", input: { text: "different payload" } } })
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);

    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await (await fetch(`${base}/jobs/job_gateway_idempotent`)).json();
      if (job.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "completed");
    assert.equal(job.result.output.text, "ODINN_GATEWAY_JOB_OK");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
