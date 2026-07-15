import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobSupervisor } from "../packages/kernel/src/jobs.mjs";
import { FileJobStore } from "../packages/store-file/src/index.mjs";

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for job state");
}

test("job supervisor persists completion and replays recovered work", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  const supervisor = new JobSupervisor({
    store,
    execute: async (payload) => ({ echoed: payload.value })
  });
  await supervisor.start();
  const submitted = await supervisor.submit({ value: "ODINN_JOB_OK" }, { id: "job_persisted" });
  assert.equal(submitted.status, "queued");
  const completed = await waitFor(async () => (await supervisor.get("job_persisted"))?.status === "completed" ? supervisor.get("job_persisted") : undefined);
  assert.equal(completed.result.echoed, "ODINN_JOB_OK");
  await supervisor.shutdown();

  const recoveredStore = new FileJobStore(join(root, "jobs-recovered.json"));
  await recoveredStore.create({ id: "job_crashed", status: "running", payload: { value: "recovered" }, attempts: 0 });
  const recovered = new JobSupervisor({ store: recoveredStore, execute: async (payload) => payload });
  await recovered.start();
  const recoveredJob = await waitFor(async () => (await recovered.get("job_crashed"))?.status === "completed" ? recovered.get("job_crashed") : undefined);
  assert.equal(recoveredJob.result.value, "recovered");
  await recovered.shutdown();
});

test("job supervisor supports cancellation and timeout recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-control-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  const supervisor = new JobSupervisor({
    store,
    maxAttempts: 1,
    execute: async (_payload, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  await supervisor.start();
  await supervisor.submit({ action: "cancel" }, { id: "job_cancel" });
  await supervisor.cancel("job_cancel");
  assert.equal((await waitFor(async () => (await supervisor.get("job_cancel"))?.status === "cancelled" ? supervisor.get("job_cancel") : undefined)).status, "cancelled");

  await supervisor.submit({ action: "timeout" }, { id: "job_timeout", timeoutMs: 10 });
  const failed = await waitFor(async () => (await supervisor.get("job_timeout"))?.status === "failed" ? supervisor.get("job_timeout") : undefined);
  assert.match(failed.error, /timed out|aborted/);
  await supervisor.shutdown();
});

test("file stores expose explicit corruption recovery without hiding the damaged source", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-store-recovery-"));
  const path = join(root, "jobs.json");
  await writeFile(path, "{not-json}\n");
  const store = new FileJobStore(path);
  await assert.rejects(() => store.list(), /store is corrupted/);
  const recovered = await store.recoverCorruption();
  assert.equal(recovered.recovered, true);
  assert.deepEqual(await store.list(), []);
});
