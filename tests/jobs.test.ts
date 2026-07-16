import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobSupervisor } from "../packages/kernel/src/jobs.ts";
import { FileAuditStore, FileJobStore } from "../packages/store-file/src/index.ts";

async function waitFor(check: any) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve: any) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for job state");
}

test("job supervisor persists completion and replays recovered work", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  const supervisor = new JobSupervisor({
    store,
    execute: async (payload: any) => ({ echoed: payload.value })
  });
  await supervisor.start();
  const submitted = await supervisor.submit({ value: "ODINN_JOB_OK" }, { id: "job_persisted" });
  assert.equal(submitted.status, "queued");
  const completed = await waitFor(async () => (await supervisor.get("job_persisted"))?.status === "completed" ? supervisor.get("job_persisted") : undefined);
  assert.equal(completed.result.echoed, "ODINN_JOB_OK");
  await supervisor.shutdown();

  const recoveredStore = new FileJobStore(join(root, "jobs-recovered.json"));
  await recoveredStore.create({ id: "job_crashed", status: "running", payload: { value: "recovered" }, attempts: 0 });
  const recovered = new JobSupervisor({ store: recoveredStore, execute: async (payload: any) => payload });
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
    execute: async (_payload: any, { signal }: any) => new Promise((resolve: any, reject: any) => {
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

test("job supervisor does not requeue or start work after shutdown begins", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-jobs-shutdown-"));
  const store = new FileJobStore(join(root, "jobs.json"));
  let executions = 0;
  const supervisor = new JobSupervisor({
    store,
    maxAttempts: 3,
    execute: async (_payload: any, { signal }: any) => {
      executions += 1;
      await new Promise((resolve: any, reject: any) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
  });
  await supervisor.start();
  await supervisor.submit({}, { id: "job_shutdown" });
  await supervisor.shutdown();
  await new Promise((resolve: any) => setTimeout(resolve, 50));
  assert.equal(executions, 1);
  assert.equal((await supervisor.get("job_shutdown")).status, "failed");
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

test("audit journals rotate keys and verify signed records across retired keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-audit-keys-"));
  const path = join(root, "audit.jsonl");
  const store = new FileAuditStore(path);
  await store.append({ runId: "run-a", type: "task.started", data: { message: "before rotation" } });
  const rotation = await store.rotateKey();
  await store.append({ runId: "run-b", type: "task.completed", data: { message: "after rotation" } });
  const verified = await store.verifyIntegrity({ allowUnsigned: false });
  assert.equal(verified.valid, true);
  assert.equal(verified.retiredKeyIds.length, 1);
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace("after rotation", "tampered"));
  const tampered = await store.verifyIntegrity({ allowUnsigned: false });
  assert.equal(tampered.valid, false);
  assert.equal(rotation.retiredKeyIds.length, 1);
});
