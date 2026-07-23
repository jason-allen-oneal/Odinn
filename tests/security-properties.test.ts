import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { SkillPackageStore, validateSkillPackage } from "../packages/kernel/src/index.ts";
import { createDefaultPolicy, evaluateTaskPolicy, type PolicyDecision } from "../packages/policy/src/index.ts";
import { normalizeAuditEvent, normalizeTaskRequest, ProtocolError } from "../packages/protocol/src/index.ts";
import { redact } from "../packages/store-sqlite/src/index.ts";

const ASCII_IDENTIFIER_CHARACTERS = [..."abcdefghijklmnopqrstuvwxyz0123456789._-"];
const TOKEN_CHARACTERS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"];

const identifierArbitrary = fc.array(fc.constantFrom(...ASCII_IDENTIFIER_CHARACTERS), {
  minLength: 1,
  maxLength: 32
}).map((characters) => characters.join(""));

const jsonRecordArbitrary = fc.dictionary(
  fc.string({ maxLength: 24 }),
  fc.jsonValue(),
  { maxKeys: 12 }
);

function propertyOptions(seed: number) {
  return { seed, numRuns: 200, verbose: true } as const;
}

function assertDenied(decision: PolicyDecision, code: string) {
  if (decision.allowed) assert.fail(`expected policy denial, received ${decision.decision}`);
  assert.equal(decision.details.code, code);
}

function skillManifest(overrides: Record<string, unknown> = {}) {
  return {
    sdkVersion: "0.1",
    id: "property-skill",
    version: "1.0.0",
    name: "Property Skill",
    description: "Exercises managed package validation with generated identifiers.",
    instructions: "Inspect the generated input, enforce every validation boundary, and report the result.",
    requestedTools: [],
    requestedCapabilities: [],
    requestedSecrets: [],
    network: { default: "deny", allow: [] },
    tests: [],
    ...overrides
  };
}

test("property: malformed protocol inputs cannot bypass required-field validation", () => {
  const malformedTopLevel = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(fc.jsonValue(), { maxLength: 8 })
  );
  const malformedRequiredString = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.array(fc.jsonValue(), { maxLength: 4 }),
    jsonRecordArbitrary,
    fc.stringMatching(/^\s*$/u)
  );

  fc.assert(
    fc.property(malformedTopLevel, (input) => {
      assert.throws(() => normalizeTaskRequest(input), ProtocolError);
      assert.throws(() => normalizeAuditEvent(input), ProtocolError);
    }),
    propertyOptions(0x0d110001)
  );

  fc.assert(
    fc.property(malformedRequiredString, fc.constantFrom("runId", "type"), (invalid, field) => {
      assert.throws(
        () => normalizeTaskRequest({ tool: invalid, input: {}, actor: "property-test" }),
        ProtocolError
      );
      assert.throws(
        () => normalizeAuditEvent({
          runId: "run_property",
          type: "property.checked",
          [field]: invalid
        }),
        ProtocolError
      );
    }),
    propertyOptions(0x0d110002)
  );
});

test("property: nested secret keys and credential values are always redacted", () => {
  const secretKey = fc.constantFrom(
    "apiKey",
    "access-token",
    "refresh_token",
    "capabilityToken",
    "authorization",
    "cookie",
    "credential",
    "password",
    "secret",
    "privateKey"
  );
  const token = fc.array(fc.constantFrom(...TOKEN_CHARACTERS), {
    minLength: 16,
    maxLength: 48
  }).map((characters) => characters.join(""));
  const wrappers = fc.array(fc.constantFrom("array", "object"), { maxLength: 6 });

  fc.assert(
    fc.property(secretKey, token, wrappers, (key, opaque, nesting) => {
      let payload: unknown = {
        [key]: `odinn-${opaque}`,
        public: "visible",
        nestedCredentialValue: `sk-${opaque}`
      };
      for (const [index, wrapper] of nesting.entries()) {
        payload = wrapper === "array" ? [payload] : { [`level${index}`]: payload };
      }

      const serialized = JSON.stringify(redact(payload));
      assert.equal(serialized.includes(opaque), false);
      assert.match(serialized, /\[redacted\]/u);
    }),
    propertyOptions(0x0d110003)
  );
});

test("property: request input cannot broaden an explicit policy denial", () => {
  fc.assert(
    fc.property(identifierArbitrary, identifierArbitrary, jsonRecordArbitrary, (toolName, capability, generatedInput) => {
      const input = {
        ...generatedInput,
        allowedCapabilities: [capability],
        deniedTools: [],
        policy: {
          allowedCapabilities: [capability],
          deniedTools: []
        }
      };
      const explicitlyDenied = evaluateTaskPolicy({
        policy: createDefaultPolicy({
          deniedTools: [toolName],
          allowedCapabilities: [capability],
          maxInputBytes: 1_000_000
        }),
        request: { tool: toolName, input },
        tool: { capability }
      });
      assertDenied(explicitlyDenied, "TOOL_DENIED");

      const capabilityDenied = evaluateTaskPolicy({
        policy: createDefaultPolicy({
          deniedTools: [],
          allowedCapabilities: [],
          maxInputBytes: 1_000_000
        }),
        request: { tool: toolName, input },
        tool: { capability }
      });
      assertDenied(capabilityDenied, "CAPABILITY_DENIED");
    }),
    propertyOptions(0x0d110004)
  );
});

test("property: traversal-sensitive skill identifiers cannot escape managed package storage", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-security-properties-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new SkillPackageStore(stateDir);
  const safeCharacters = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), {
    maxLength: 16
  }).map((characters) => characters.join(""));
  const traversalFragment = fc.constantFrom("../", "..\\", "/", "\\", "%2f..%2f", "%5c..%5c");
  const traversalId = fc.tuple(safeCharacters, traversalFragment, safeCharacters)
    .map(([prefix, fragment, suffix]) => `${prefix}${fragment}${suffix}`);
  const traversalVersion = fc.tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    traversalFragment,
    safeCharacters
  ).map(([major, minor, patch, fragment, suffix]) => `${major}.${minor}.${patch}${fragment}${suffix}`);
  const traversalCandidate = fc.oneof(
    traversalId.map((value) => ({ field: "id" as const, value })),
    traversalVersion.map((value) => ({ field: "version" as const, value }))
  );

  await fc.assert(
    fc.asyncProperty(traversalCandidate, async ({ field, value }) => {
      await assert.rejects(
        store.install(skillManifest({ [field]: value })),
        field === "id" ? /skill id must be/u : /skill version must be semantic/u
      );
    }),
    propertyOptions(0x0d110005)
  );

  await assert.rejects(access(join(stateDir, "skills")), { code: "ENOENT" });

  fc.assert(
    fc.property(identifierArbitrary, (generatedId) => {
      const id = `s${generatedId.replaceAll(/[._]/gu, "-")}`.slice(0, 64);
      const validated = validateSkillPackage(skillManifest({ id }));
      const packagesRoot = resolve(stateDir, "skills", "packages");
      const target = resolve(packagesRoot, validated.manifest.id, validated.manifest.version);
      const pathFromRoot = relative(packagesRoot, target);
      assert.equal(pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot), false);
    }),
    propertyOptions(0x0d110006)
  );
});
