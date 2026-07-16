import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const level = process.argv[2] || "high";

try {
  const result = await execFile("pnpm", ["audit", "--audit-level", level], {
    maxBuffer: 8 * 1024 * 1024,
    env: process.env
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
} catch (error: any) {
  const output = `${error.stdout || ""}\n${error.stderr || ""}`;
  process.stdout.write(output);
  if (/ERR_PNPM_AUDIT_BAD_RESPONSE|endpoint is being retired|\bHTTP\s*410\b/i.test(output)) {
    console.warn("pnpm audit service is unavailable; dependency review is deferred to the repository security scanners.");
    process.exit(0);
  }
  process.exit(error.code || 1);
}
