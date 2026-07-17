import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { withStateMutationLock } from "./state-mutation.ts";

type SkillManifest = {
  sdkVersion: string;
  id: string;
  version: string;
  name: string;
  description: string;
  instructions: string;
  requestedTools: string[];
  requestedCapabilities: string[];
  requestedSecrets: string[];
  network: { default: "deny"; allow: string[] };
  tests: unknown[];
};

type SkillRecord = SkillManifest & {
  status: "disabled" | "enabled" | "quarantined";
  trusted: boolean;
  installedAt: string;
  updatedAt?: string;
  packagePath: string;
  fileIntegrity: Record<string, string>;
  integrity: string;
  previousVersion?: string;
};

type RegistryState = { schemaVersion: 1; packages: SkillRecord[] };

const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function validateSkillPackage(input: any) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill package manifest must be an object");
  const manifest: SkillManifest = {
    sdkVersion: String(input.sdkVersion || "0.1"),
    id: String(input.id || input.name || "").trim(),
    version: String(input.version || "1.0.0").trim(),
    name: String(input.name || input.id || "").trim().slice(0, 120),
    description: String(input.description || "").trim(),
    instructions: String(input.instructions || "").trim(),
    requestedTools: stringList(input.requestedTools ?? input.tools),
    requestedCapabilities: stringList(input.requestedCapabilities ?? input.capabilities),
    requestedSecrets: stringList(input.requestedSecrets ?? input.secrets),
    network: {
      default: "deny",
      allow: stringList(input.network?.allow)
    },
    tests: Array.isArray(input.tests) ? input.tests : []
  };
  if (manifest.sdkVersion !== "0.1") throw new Error("skill sdkVersion must be 0.1");
  if (!SKILL_ID.test(manifest.id)) throw new Error("skill id must be 2-64 lowercase letters, digits, or hyphens");
  if (!SEMVER.test(manifest.version)) throw new Error("skill version must be semantic");
  if (manifest.name.length < 2) throw new Error("skill name is required");
  if (manifest.description.length < 12) throw new Error("skill description must explain when the skill applies");
  if (manifest.instructions.length < 40) throw new Error("skill instructions must contain an actionable workflow");
  for (const domain of manifest.network.allow) {
    if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(domain) || domain.includes("..")) throw new Error(`invalid skill network domain: ${domain}`);
  }
  const skillContent = renderSkillMarkdown(manifest);
  const fileIntegrity = { "SKILL.md": digest(skillContent) };
  const integrity = digest(stableJson({ manifest, fileIntegrity }));
  if (input.integrity && input.integrity !== integrity) throw new Error("skill package integrity mismatch");
  return {
    manifest,
    skillContent,
    fileIntegrity,
    integrity,
    validation: { valid: true, checkedAt: new Date().toISOString() }
  };
}

export class SkillPackageStore {
  readonly stateDir: string;
  readonly root: string;
  readonly registryPath: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.stateDir = resolve(stateDir);
    this.root = join(this.stateDir, "skills");
    this.registryPath = join(this.root, "registry.json");
  }

  async list() {
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      let changed = false;
      const packages = [];
      for (const record of state.packages) {
        const verification = await this.verifyRecord(record);
        if (!verification.valid && record.status !== "quarantined") {
          record.status = "quarantined";
          record.trusted = false;
          record.updatedAt = new Date().toISOString();
          changed = true;
        }
        packages.push({ ...record, verification });
      }
      if (changed) await this.write(state);
      return packages;
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async install(input: any) {
    const validated = validateSkillPackage(input);
    return this.mutate(async (state) => {
      const current = state.packages.find((entry) => entry.id === validated.manifest.id);
      const destination = this.safePackagePath(validated.manifest.id, validated.manifest.version);
      const staging = join(this.root, ".staging", randomUUID());
      await mkdir(staging, { recursive: true, mode: 0o700 });
      try {
        await writeFile(join(staging, "SKILL.md"), validated.skillContent, { mode: 0o600 });
        await writeFile(join(staging, "skill.json"), `${JSON.stringify(skillMetadata(validated), null, 2)}\n`, { mode: 0o600 });
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        try { await rename(staging, destination); }
        catch (error: any) {
          if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
          const existing = await this.verifyRecord({ ...validated.manifest, packagePath: destination, fileIntegrity: validated.fileIntegrity, integrity: validated.integrity } as unknown as SkillRecord);
          if (!existing.valid) throw new Error(`skill ${validated.manifest.id}@${validated.manifest.version} already exists with different content`);
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const record: SkillRecord = {
        ...validated.manifest,
        status: "disabled",
        trusted: false,
        installedAt: new Date().toISOString(),
        packagePath: destination,
        fileIntegrity: validated.fileIntegrity,
        integrity: validated.integrity,
        ...(current ? { previousVersion: current.version } : {})
      };
      const index = state.packages.findIndex((entry) => entry.id === record.id);
      if (index >= 0) state.packages[index] = record;
      else state.packages.push(record);
      return { ...record, verification: { valid: true, failures: [] } };
    });
  }

  async transition(id: string, action: string) {
    return this.mutate(async (state) => {
      const record = state.packages.find((entry) => entry.id === id);
      if (!record) throw new Error("skill package not found");
      if (!["enable", "disable", "quarantine"].includes(action)) throw new Error("unsupported skill lifecycle action");
      const verification = await this.verifyRecord(record);
      if (action === "enable" && !verification.valid) {
        record.status = "quarantined";
        record.trusted = false;
        record.updatedAt = new Date().toISOString();
        await this.write(state);
        throw new Error("skill package failed integrity verification and was quarantined");
      }
      record.status = action === "enable" ? "enabled" : action === "disable" ? "disabled" : "quarantined";
      record.trusted = action === "enable";
      record.updatedAt = new Date().toISOString();
      return { ...record, verification };
    });
  }

  async verify(id: string) {
    const record = (await this.read()).packages.find((entry) => entry.id === id);
    if (!record) throw new Error("skill package not found");
    return this.verifyRecord(record);
  }

  private async verifyRecord(record: SkillRecord) {
    const failures: string[] = [];
    const expectedPath = this.safePackagePath(record.id, record.version);
    if (resolve(record.packagePath) !== expectedPath) failures.push("package path escaped managed storage");
    try {
      const content = await readFile(join(expectedPath, "SKILL.md"), "utf8");
      if (digest(content) !== record.fileIntegrity?.["SKILL.md"]) failures.push("SKILL.md digest mismatch");
      const validated = validateSkillPackage(record);
      if (validated.integrity !== record.integrity) failures.push("manifest digest mismatch");
      const metadata = JSON.parse(await readFile(join(expectedPath, "skill.json"), "utf8"));
      if (stableJson(metadata) !== stableJson(skillMetadata(validated))) failures.push("skill.json metadata mismatch");
    } catch (error: any) {
      failures.push(error?.code === "ENOENT" ? "managed package file is missing" : error.message);
    }
    return { valid: failures.length === 0, failures, checkedAt: new Date().toISOString() };
  }

  private async read(): Promise<RegistryState> {
    try {
      const value = JSON.parse(await readFile(this.registryPath, "utf8"));
      return value?.schemaVersion === 1 && Array.isArray(value.packages) ? value : { schemaVersion: 1, packages: [] };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: 1, packages: [] };
      throw error;
    }
  }

  private async write(state: RegistryState) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.registryPath);
    await chmod(this.registryPath, 0o600);
  }

  private async mutate<T>(operation: (state: RegistryState) => Promise<T>) {
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      const result = await operation(state);
      await this.write(state);
      return result;
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  private safePackagePath(id: string, version: string) {
    const packagesRoot = resolve(join(this.root, "packages"));
    const target = resolve(packagesRoot, id, version);
    if (!target.startsWith(`${packagesRoot}${sep}`)) throw new Error("skill package path escaped managed storage");
    return target;
  }
}

function renderSkillMarkdown(manifest: SkillManifest) {
  return `---\nname: ${JSON.stringify(manifest.id)}\ndescription: ${JSON.stringify(manifest.description)}\n---\n\n# ${manifest.name}\n\n${manifest.instructions.trim()}\n`;
}

function skillMetadata(validated: ReturnType<typeof validateSkillPackage>) {
  return { ...validated.manifest, fileIntegrity: validated.fileIntegrity, integrity: validated.integrity };
}

function stringList(value: any) {
  return Array.isArray(value) ? Array.from(new Set(value.map((entry) => String(entry).trim()).filter(Boolean))) : [];
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
