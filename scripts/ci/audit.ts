import { execFile as execFileCallback } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BULK_ADVISORY_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const SEVERITY = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4]
]);

type DependencyNode = {
  from?: string;
  version?: string;
  dependencies?: Record<string, DependencyNode>;
  devDependencies?: Record<string, DependencyNode>;
  optionalDependencies?: Record<string, DependencyNode>;
};

type Advisory = {
  id?: number | string;
  title?: string;
  severity?: string;
  url?: string;
  vulnerable_versions?: string;
};

export function collectPackageVersions(listing: unknown) {
  const packages = new Map<string, Set<string>>();
  const seen = new WeakSet<object>();

  const visit = (value: unknown, fallbackName?: string) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as DependencyNode;
    const name = node.from || fallbackName;
    if (name && node.version && !node.version.startsWith("link:")) {
      const versions = packages.get(name) ?? new Set<string>();
      versions.add(node.version);
      packages.set(name, versions);
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [childName, child] of Object.entries(node[field] ?? {})) visit(child, childName);
    }
  };

  for (const workspace of Array.isArray(listing) ? listing : [listing]) visit(workspace);
  return Object.fromEntries([...packages].sort(([left], [right]) => left.localeCompare(right)).map(([name, versions]) => [name, [...versions].sort()]));
}

export function matchingAdvisories(payload: unknown, minimumSeverity: string) {
  const threshold = SEVERITY.get(minimumSeverity);
  if (threshold === undefined) throw new Error(`unsupported audit level: ${minimumSeverity}`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("bulk advisory response must be an object");
  const matches: Array<{ package: string; advisory: Advisory }> = [];
  for (const [name, advisories] of Object.entries(payload)) {
    if (!Array.isArray(advisories)) throw new Error(`bulk advisory response for ${name} must be an array`);
    for (const advisory of advisories as Advisory[]) {
      const severity = SEVERITY.get(String(advisory.severity ?? "").toLowerCase());
      if (severity === undefined) throw new Error(`bulk advisory for ${name} has an unknown severity`);
      if (severity >= threshold) matches.push({ package: name, advisory });
    }
  }
  return matches;
}

async function bulkAudit(level: string) {
  const listed = await execFile("pnpm", ["-r", "list", "--json", "--depth", "Infinity"], {
    maxBuffer: 32 * 1024 * 1024,
    env: process.env
  });
  const packages = collectPackageVersions(JSON.parse(listed.stdout));
  if (Object.keys(packages).length === 0) throw new Error("dependency inventory is empty");
  const response = await fetch(BULK_ADVISORY_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(packages),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`bulk advisory endpoint returned ${response.status} ${response.statusText}`);
  const matches = matchingAdvisories(await response.json(), level);
  if (matches.length === 0) {
    console.log(`bulk advisory audit passed (${Object.keys(packages).length} packages, level ${level})`);
    return;
  }
  for (const { package: name, advisory } of matches) {
    console.error(`${String(advisory.severity).toUpperCase()} ${name}: ${advisory.title ?? advisory.id ?? "security advisory"}${advisory.url ? ` (${advisory.url})` : ""}`);
  }
  throw new Error(`bulk advisory audit found ${matches.length} ${level}-or-higher finding(s)`);
}

export async function runAudit(level = "high") {
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
    if (!/ERR_PNPM_AUDIT_BAD_RESPONSE|endpoint is being retired|\bHTTP\s*410\b/i.test(output)) throw error;
    console.warn("pnpm audit endpoint is unavailable; querying the npm bulk advisory endpoint directly.");
    await bulkAudit(level);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAudit(process.argv[2] || "high").catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
