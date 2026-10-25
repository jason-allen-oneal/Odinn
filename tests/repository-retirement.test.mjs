import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the relocated repository has no active sync bridge", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");

  assert.match(readme, /has moved/u);
  assert.match(readme, /BlueDot-IT\/Odinn-Forge/u);
  assert.equal(
    existsSync(join(root, ".github/workflows/sync-to-org.yml")),
    false,
    "the retired repository must not schedule mirror jobs"
  );
});
