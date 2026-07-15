import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAuditStore, FileJobStore, FileRecordStore } from "../../packages/store-file/src/index.mjs";

const root = await mkdtemp(join(tmpdir(), "odinn-storage-drill-"));
const state = join(root, "state");
const backup = join(root, "backup");
const restored = join(root, "restored");
try {
  const audit = new FileAuditStore(join(state, "audit.jsonl"));
  const records = new FileRecordStore(join(state, "records.jsonl"));
  const jobs = new FileJobStore(join(state, "jobs.json"));
  await audit.append({ runId: "storage-drill", type: "task.completed", actor: "ci", tool: "text.echo", data: { marker: "ODINN_STORAGE_DRILL_OK" } });
  await records.append({ type: "memory", text: "storage drill record" });
  await jobs.create({ id: "storage-drill-job", payload: { marker: true }, status: "queued" });
  await cp(state, backup, { recursive: true });
  await cp(backup, restored, { recursive: true });
  const restoredAudit = new FileAuditStore(join(restored, "audit.jsonl"));
  const restoredRecords = new FileRecordStore(join(restored, "records.jsonl"));
  const restoredJobs = new FileJobStore(join(restored, "jobs.json"));
  if ((await restoredAudit.readAll()).length !== 1 || (await restoredRecords.readAll()).length !== 1 || !(await restoredJobs.get("storage-drill-job"))) {
    throw new Error("backup restore did not preserve all store records");
  }
  await writeFile(join(restored, "audit.jsonl"), `${await readFile(join(restored, "audit.jsonl"), "utf8")}not-json\n`);
  const recovered = await restoredAudit.recover();
  if (!recovered.recovered || recovered.retained !== 1 || recovered.discarded !== 1) throw new Error("audit corruption recovery drill failed");
  console.log("ODINN_STORAGE_DRILL_OK");
} finally {
  await rm(root, { recursive: true, force: true });
}
