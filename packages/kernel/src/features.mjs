export const EXPERIMENTAL_FEATURES = Object.freeze([
  "proof",
  "rewind",
  "sentinel",
  "capsules",
  "darwin",
  "capabilities",
  "counterfactual"
]);

export function normalizeExperimentalFlags(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(EXPERIMENTAL_FEATURES.map((name) => [name, source[name] === true]));
}

export function experimentalFeatureWarning(flags = {}) {
  const enabled = EXPERIMENTAL_FEATURES.filter((name) => flags[name] === true);
  return enabled.length ? `experimental features enabled: ${enabled.join(", ")}` : "experimental features disabled";
}
