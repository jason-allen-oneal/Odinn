import assert from "node:assert/strict";
import test from "node:test";
import { collectPackageVersions, matchingAdvisories } from "../scripts/ci/audit.ts";

test("bulk advisory inventory collects unique transitive package versions", () => {
  const inventory = collectPackageVersions([{ devDependencies: {
    eslint: { from: "eslint", version: "10.7.0", dependencies: { acorn: { from: "acorn", version: "8.17.0" } } },
    duplicate: { from: "acorn", version: "8.17.0" }
  } }]);
  assert.deepEqual(inventory, { acorn: ["8.17.0"], eslint: ["10.7.0"] });
});

test("bulk advisory evaluation enforces the requested severity threshold", () => {
  const payload = {
    alpha: [{ id: 1, title: "moderate issue", severity: "moderate" }],
    beta: [{ id: 2, title: "critical issue", severity: "critical" }]
  };
  assert.deepEqual(matchingAdvisories(payload, "high").map((item) => item.package), ["beta"]);
  assert.throws(() => matchingAdvisories({ alpha: [{ severity: "mystery" }] }, "high"), /unknown severity/);
});
