export type SecuritySurface = {
  enabled: boolean;
  allowPrivateNetwork: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  requireApproval?: boolean;
  allowDownloads?: boolean;
  allowUploads?: boolean;
};

export interface RuntimePolicy {
  deniedTools: string[];
  allowedCapabilities: string[];
  maxInputBytes: number;
  security: { web: SecuritySurface; browser: SecuritySurface };
}

export interface PolicyTool { capability: string }
export interface PolicyRequest { tool: string; input: Record<string, unknown> }
export type PolicyDecision =
  | { allowed: true; decision: "allow"; capability: string }
  | { allowed: false; decision: "deny"; reason: string; details: Record<string, unknown> };

type PolicyOverrides = Partial<Omit<RuntimePolicy, "security">> & {
  security?: { web?: Partial<SecuritySurface>; browser?: Partial<SecuritySurface> };
};

export class PolicyError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PolicyError";
    this.details = details;
  }
}

export function createDefaultPolicy(overrides: PolicyOverrides = {}): RuntimePolicy {
  const defaultCapabilities = [
    "job.healthcheck",
    "text.echo",
    "workspace.readText",
    "model.chat",
    "agent.run",
    "web.read",
    "browser.read",
    "browser.act",
    "session.read",
    "session.write",
    "goal.read",
    "goal.write",
    "memory.read",
    "memory.write",
    "improve.read",
    "improve.write"
  ];
  const configuredCapabilities = Array.isArray(overrides.allowedCapabilities) ? overrides.allowedCapabilities : undefined;
  const allowedCapabilities = configuredCapabilities && sameCapabilities(configuredCapabilities, LEGACY_DEFAULT_CAPABILITIES)
    ? defaultCapabilities
    : configuredCapabilities ?? defaultCapabilities;
  const defaults = {
    deniedTools: [],
    maxInputBytes: 16_384,
    ...overrides,
    allowedCapabilities,
    security: {
      ...defaultsSecurity,
      ...(overrides.security ?? {}),
      web: { ...defaultsSecurity.web, ...(overrides.security?.web ?? {}) },
      browser: { ...defaultsSecurity.browser, ...(overrides.security?.browser ?? {}) }
    }
  };
  return defaults;
}

const LEGACY_DEFAULT_CAPABILITIES = [
  "job.healthcheck",
  "text.echo",
  "workspace.readText",
  "model.chat",
  "session.read",
  "session.write",
  "goal.read",
  "goal.write",
  "memory.read",
  "memory.write",
  "improve.read",
  "improve.write"
];

function sameCapabilities(left: string[], right: string[]) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

const defaultsSecurity = {
  web: {
    enabled: true,
    allowPrivateNetwork: false,
    allowedDomains: [],
    blockedDomains: []
  },
  browser: {
    enabled: true,
    allowPrivateNetwork: false,
    allowedDomains: [],
    blockedDomains: [],
    requireApproval: true,
    allowDownloads: false,
    allowUploads: false
  }
};

export function evaluateTaskPolicy({ policy = createDefaultPolicy(), request, tool }: { policy?: RuntimePolicy; request: PolicyRequest; tool?: PolicyTool }): PolicyDecision {
  if (!tool) {
    return deny(`unknown tool: ${request.tool}`, { code: "UNKNOWN_TOOL" });
  }
  if (policy.deniedTools?.includes(request.tool)) {
    return deny(`tool is denied by policy: ${request.tool}`, { code: "TOOL_DENIED" });
  }
  if (!policy.allowedCapabilities?.includes(tool.capability)) {
    return deny(`capability is not allowed: ${tool.capability}`, { code: "CAPABILITY_DENIED" });
  }
  if (["web.read", "browser.read", "browser.act"].includes(tool.capability)) {
    const surface = tool.capability.startsWith("web.") ? policy.security?.web : policy.security?.browser;
    if (surface?.enabled === false) return deny(`security policy disabled ${tool.capability}`, { code: "SECURITY_SURFACE_DISABLED" });
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(request.input), "utf8");
  if (inputBytes > (policy.maxInputBytes ?? 16_384)) {
    return deny(`input exceeds policy limit: ${inputBytes} bytes`, { code: "INPUT_TOO_LARGE", inputBytes });
  }
  return { allowed: true, decision: "allow", capability: tool.capability };
}

export function assertAllowed(result: PolicyDecision): asserts result is Extract<PolicyDecision, { allowed: true }> {
  if (!result.allowed) throw new PolicyError(result.reason, result.details);
}

function deny(reason: string, details: Record<string, unknown>): PolicyDecision {
  return { allowed: false, decision: "deny", reason, details };
}
