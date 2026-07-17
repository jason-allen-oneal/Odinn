import { createDefaultPolicy, type RuntimePolicy } from "@odinn/policy";

export type AccessProfileId = "balanced" | "private" | "chat-only" | "custom";

export type AccessProfile = {
  id: Exclude<AccessProfileId, "custom">;
  label: string;
  hint: string;
  capabilities: string[];
  web: boolean;
  browser: boolean;
};

const PRIVATE_CAPABILITIES = [
  "job.healthcheck",
  "text.echo",
  "workspace.readText",
  "model.chat",
  "agent.run",
  "session.read",
  "session.write",
  "memory.read",
  "memory.write",
  "goal.read",
  "goal.write"
];

const CHAT_ONLY_CAPABILITIES = [
  "job.healthcheck",
  "text.echo",
  "model.chat",
  "session.read",
  "session.write"
];

export const ACCESS_PROFILES: AccessProfile[] = [
  {
    id: "balanced",
    label: "Everyday assistant",
    hint: "Memory, local files, and the public web. Browser actions still ask first.",
    capabilities: createDefaultPolicy().allowedCapabilities,
    web: true,
    browser: true
  },
  {
    id: "private",
    label: "Private workspace",
    hint: "Chat, memory, and local files. No web browsing or browser control.",
    capabilities: PRIVATE_CAPABILITIES,
    web: false,
    browser: false
  },
  {
    id: "chat-only",
    label: "Chat only",
    hint: "Conversation only. No memory, files, web, or browser control.",
    capabilities: CHAT_ONLY_CAPABILITIES,
    web: false,
    browser: false
  }
];

export function identifyAccessProfile(policyInput: unknown): AccessProfileId {
  const policy = createDefaultPolicy(isRecord(policyInput) ? policyInput : {});
  const match = ACCESS_PROFILES.find((profile) => {
    return sameStrings(policy.allowedCapabilities, profile.capabilities)
      && policy.security.web.enabled === profile.web
      && policy.security.browser.enabled === profile.browser
      && policy.security.web.allowPrivateNetwork === false
      && policy.security.browser.allowPrivateNetwork === false
      && policy.security.browser.requireApproval === true;
  });
  return match?.id ?? "custom";
}

export function applyAccessProfile(policyInput: unknown, profileId: Exclude<AccessProfileId, "custom">): RuntimePolicy {
  const profile = ACCESS_PROFILES.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Unknown access profile: ${profileId}`);
  const policy = createDefaultPolicy(isRecord(policyInput) ? policyInput : {});
  return {
    ...policy,
    allowedCapabilities: [...profile.capabilities],
    security: {
      web: {
        ...policy.security.web,
        enabled: profile.web,
        allowPrivateNetwork: false
      },
      browser: {
        ...policy.security.browser,
        enabled: profile.browser,
        allowPrivateNetwork: false,
        requireApproval: true
      }
    }
  };
}

export function accessProfileLabel(profileId: AccessProfileId): string {
  if (profileId === "custom") return "Custom — preserved exactly";
  return ACCESS_PROFILES.find((entry) => entry.id === profileId)?.label ?? "Custom — preserved exactly";
}

export function capabilityDelta(beforeInput: unknown, afterInput: unknown): { added: string[]; removed: string[] } {
  const before = createDefaultPolicy(isRecord(beforeInput) ? beforeInput : {}).allowedCapabilities;
  const after = createDefaultPolicy(isRecord(afterInput) ? afterInput : {}).allowedCapabilities;
  return {
    added: after.filter((capability) => !before.includes(capability)).sort(),
    removed: before.filter((capability) => !after.includes(capability)).sort()
  };
}

export function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
