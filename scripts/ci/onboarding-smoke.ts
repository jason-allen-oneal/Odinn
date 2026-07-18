import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const parent = await mkdtemp(join(tmpdir(), "odinn-onboarding-"));
const state = join(parent, "state");
const result: any = await new Promise((resolve: any, reject: any) => {
  const child = spawn(process.execPath, ["apps/cli/src/cli.ts", "onboard", "--non-interactive", "--state", state], {
    cwd: root,
    env: { ...process.env, ODINN_GATEWAY_AUTH: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: any) => { stdout += chunk; });
  child.stderr.on("data", (chunk: any) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code: any) => resolve({ code, stdout, stderr }));
});
assert.equal(result.code, 0, result.stderr || result.stdout);
assert.match(result.stdout, /needs an AI connection|setup required/i);
assert.equal((await stat(state)).isDirectory(), true);
assert.equal((await stat(join(state, "config.json"))).isFile(), true);
if (process.platform !== "win32") {
  assert.equal((await stat(state)).mode & 0o777, 0o700);
  assert.equal((await stat(join(state, "config.json"))).mode & 0o777, 0o600);
}
const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
assert.deepEqual(config.providers, {});
assert.equal(config.policy.security.web.allowPrivateNetwork, false);
assert.equal(config.policy.security.browser.allowPrivateNetwork, false);
assert.equal(config.policy.security.browser.requireApproval, true);
console.log("ODINN_ONBOARDING_OK");
