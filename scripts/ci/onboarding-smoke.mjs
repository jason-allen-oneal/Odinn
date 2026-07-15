import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const state = await mkdtemp(join(tmpdir(), "odinn-onboarding-") );
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["apps/cli/src/cli.mjs", "onboard", "--state", state], {
    cwd: root,
    env: { ...process.env, ODINN_GATEWAY_AUTH: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});
assert.equal(result.code, 0, result.stderr || result.stdout);
assert.match(result.stdout, /Odinn local onboarding/);
assert.match(result.stdout, /State:/);
console.log("ODINN_ONBOARDING_OK");
