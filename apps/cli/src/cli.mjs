#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access, copyFile, cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createAuditStore, createBuiltInRegistry, createOAuthAuthorizationRequest, exchangeOAuthCode, ExtensionExecutor, ExtensionRegistry, listConfiguredModels, listProviderPresets, normalizeModelConfig, oauthTokenPath, PROVIDER_PRESETS, runPlan, runTask, saveOAuthToken } from "@odinn/kernel";
import { createDefaultPolicy } from "@odinn/policy";

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();
const [command, ...args] = rawArgs;

async function main() {
  switch (command) {
    case "init":
      await init(args);
      break;
    case "onboard":
    case "onboarding":
      await onboard(args);
      break;
    case "config":
      await configCommand(args);
      break;
    case "auth":
      await authCommand(args);
      break;
    case "import":
      await importCommand(args);
      break;
    case "state":
      await stateCommand(args);
      break;
    case "extension":
    case "extensions":
    case "tool":
      await extensionCommand(args);
      break;
    case "doctor":
    case "status":
      await printJson(await status(args));
      break;
    case "tui":
      await tui(args);
      break;
    case "run":
      await run(args);
      break;
    case "plan":
      await plan(args);
      break;
    case "audit":
      await audit(args);
      break;
    case "runs":
      await runs(args);
      break;
    case "show":
      await show(args);
      break;
    case "memory":
      await memory(args);
      break;
    case "session":
    case "sessions":
      await session(args);
      break;
    case "goal":
    case "goals":
      await goal(args);
      break;
    case "improve":
    case "improvements":
      await improve(args);
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

function usage() {
  console.log(`Usage:
  odinn init [--state .odinn]
  odinn onboard [--provider <name>] [--auth api-key|oauth|device|cli] [--state .odinn]
  odinn config provider add <name> [--auth api-key|oauth|device|cli] [--base-url <url>] [--model <model[,model]>] [--api-key-env <ENV>] [--authorization-url <url>] [--token-url <url>] [--client-id <id>] [--scope <scope[,scope]>] [--state .odinn]
  odinn config provider list [--state .odinn]
  odinn config provider catalog
  odinn config provider remove <name> [--state .odinn]
  odinn config security show [--state .odinn]
  odinn config security set --surface web|browser [--enabled true|false] [--allow-private-network true|false] [--allowed-domains a,b] [--blocked-domains a,b] [--require-approval true|false] [--state .odinn]
  odinn auth import openclaw [--provider openai] [--profile <id-or-email>] [--source <path>] [--state .odinn]
  odinn import openclaw|hermes [--source <path>] [--auth-only|--skills-only] [--dry-run] [--state .odinn]
  odinn state backup --output <directory> [--state .odinn]
  odinn state restore --input <directory> --confirm [--state .odinn]
  odinn extension install --manifest <manifest.json> [--state .odinn]
  odinn extension list [--state .odinn]
  odinn extension enable --id <id> --grant <capability[,capability]> [--trust] [--allow-unsafe-sandbox] [--state .odinn]
  odinn extension disable --id <id> [--reason <text>] [--state .odinn]
  odinn extension rollback --id <id> [--state .odinn]
  odinn extension run --id <id> --input-json <json> [--capability <capability>] [--state .odinn]
  odinn config model default <provider:model> [--state .odinn]
  odinn config model list [--state .odinn]
  odinn status [--state .odinn]
  odinn tui [--state .odinn] [--watch]
  odinn run --tool <tool> [--input-json <json>] [--state .odinn]
  odinn plan --file <plan.json> [--state .odinn]
  odinn audit [--state .odinn]
  odinn runs [--limit 20] [--state .odinn]
  odinn show --run <run-id> [--state .odinn]
  odinn memory remember --text <text> [--kind project] [--subject general] [--namespace path] [--tier l0|l1|l2] [--tags a,b] [--state .odinn]
  odinn memory search [--query <text>] [--kind <kind>] [--subject <text>] [--state .odinn]
  odinn memory recall --query <text> [--namespace <path>] [--limit 8] [--state .odinn]
  odinn memory browse [--namespace <path>] [--limit 50] [--state .odinn]
  odinn memory open --id <memory-id> [--state .odinn]
  odinn memory compact --session <session-id> [--state .odinn]
  odinn memory correct --target <memory-id> --text <text> [--state .odinn]
  odinn memory curate [--state .odinn]
  odinn session create [--title <title>] [--state .odinn]
  odinn session message --session <session-id> --role user --content <text> [--state .odinn]
  odinn session rename --session <session-id> --title <title> [--state .odinn]
  odinn session delete --session <session-id> [--state .odinn]
  odinn session list [--state .odinn]
  odinn session read --session <session-id> [--state .odinn]
  odinn goal create --title <title> [--description <text>] [--state .odinn]
  odinn goal update --goal <goal-id> --status active|completed|blocked|paused|cancelled [--note <text>] [--state .odinn]
  odinn goal list [--state .odinn]
  odinn improve propose --title <title> --rationale <text> [--target runtime] [--state .odinn]
  odinn improve decide --improvement <id> --decision approved|rejected|applied [--note <text>] [--state .odinn]
  odinn improve list [--state .odinn]

Built-in tools:
  job.healthcheck
  text.echo
  workspace.readText
  model.chat
  memory.remember
  memory.search
  memory.recall
  memory.browse
  memory.open
  memory.compact
  memory.correct
  memory.curate
  session.create
  session.message
  session.list
  session.read
  goal.create
  goal.update
  goal.list
  improve.propose
  improve.list
  improve.decide`);
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function invocationRoot() {
  return resolve(process.env.INIT_CWD ?? process.cwd());
}

function resolveInvocationPath(path) {
  return resolve(invocationRoot(), path);
}

function stateDir(args) {
  return resolveInvocationPath(option(args, "--state", ".odinn"));
}

async function init(args) {
  const state = stateDir(args);
  const configPath = await ensureConfig(state);
  await printJson({ ok: true, state, configPath });
}

async function onboard(args) {
  const state = stateDir(args);
  const configPath = await ensureConfig(state);
  const provider = option(args, "--provider", "");
  if (provider) {
    await addProvider(state, args, provider);
    const configured = normalizeModelConfig(await readConfig(state)).providers[provider];
    if (configured?.auth.mode === "oauth") await connectOAuth(state, provider, args);
    if (configured?.auth.mode === "device") await connectDeviceAuth(state, provider, args);
    if (configured?.auth.mode === "cli") await connectCliAuth(provider);
  }
  const current = await status(args);
  const store = createAuditStore(join(state, current.auditLog ?? "audit.jsonl"));
  const runs = await store.readRuns();
  console.log(renderOnboarding({ ...current, configPath, runs }));
}

async function status(args) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const models = listConfiguredModels(normalizeModelConfig(config));
  return {
    ok: true,
    state,
    workspaceRoot: invocationRoot(),
    auditLog: config.auditLog ?? "audit.jsonl",
    tools: Array.from(createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config }).keys()),
    allowedCapabilities: config.policy.allowedCapabilities,
    security: createDefaultPolicy(config.policy).security,
    defaultModel: normalizeModelConfig(config).defaultModel,
    models,
    providers: await summarizeProviders(config, state)
  };
}

async function configCommand(args) {
  const [section, subcommand, ...rest] = args;
  if (!["provider", "model", "security"].includes(section)) {
    throw new Error("config requires provider, model, or security");
  }
  const state = stateDir(rest);
  const config = await readConfig(state);
  if (section === "security") {
    await configSecurityCommand(state, config, subcommand, rest);
    return;
  }
  if (section === "provider") {
    if (subcommand === "catalog") {
      await printJson(listProviderPresets());
      return;
    }
    if (subcommand === "add") {
      const provider = rest[0];
      if (!provider) throw new Error("config provider add requires a provider name");
      await addProvider(state, rest.slice(1), provider, config);
      await printJson({ ok: true, provider, models: listConfiguredModels(normalizeModelConfig(await readConfig(state))) });
      return;
    }
    if (subcommand === "list") {
      await printJson(await summarizeProviders(config, state));
      return;
    }
    if (subcommand === "remove") {
      const provider = rest[0];
      if (!provider) throw new Error("config provider remove requires a provider name");
      if (!config.providers?.[provider]) throw new Error(`provider not found: ${provider}`);
      delete config.providers[provider];
      if (config.defaultModel?.startsWith(`${provider}:`)) delete config.defaultModel;
      await saveConfig(state, config);
      await printJson({ ok: true, removed: provider });
      return;
    }
    throw new Error("config provider requires add, list, or remove");
  }
  if (subcommand === "default") {
    const model = rest[0];
    if (!model) throw new Error("config model default requires provider:model");
    const normalized = normalizeModelConfig(config);
    if (!listConfiguredModels(normalized).some((entry) => entry.id === model)) throw new Error(`model is not configured: ${model}`);
    config.defaultModel = model;
    await saveConfig(state, config);
    await printJson({ ok: true, defaultModel: model });
    return;
  }
  if (subcommand === "list") {
    await printJson({ defaultModel: normalizeModelConfig(config).defaultModel, models: listConfiguredModels(normalizeModelConfig(config)) });
    return;
  }
  throw new Error("config model requires default or list");
}

async function configSecurityCommand(state, config, subcommand, args) {
  const policy = createDefaultPolicy(config.policy);
  if (subcommand === "show" || !subcommand) {
    await printJson(policy.security);
    return;
  }
  if (subcommand !== "set") throw new Error("config security requires show or set");
  const surface = option(args, "--surface", "");
  if (!['web', 'browser'].includes(surface)) throw new Error("config security set requires --surface web|browser");
  const current = { ...policy.security[surface] };
  for (const field of ["enabled", "allowPrivateNetwork", "requireApproval"]) {
    if (field === "requireApproval" && surface !== "browser") continue;
    const value = option(args, `--${kebabCase(field)}`, "");
    if (value !== "") current[field] = parseBoolean(value, `--${kebabCase(field)}`);
  }
  for (const field of ["allowedDomains", "blockedDomains"]) {
    const value = option(args, `--${kebabCase(field)}`, "");
    if (value !== "") current[field] = splitCsv(value);
  }
  config.policy = {
    ...config.policy,
    security: {
      ...policy.security,
      [surface]: current
    }
  };
  await saveConfig(state, config);
  await printJson({ ok: true, surface, security: createDefaultPolicy(config.policy).security });
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function parseBoolean(value, flag) {
  if (["true", "1", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error(`${flag} requires true or false`);
}

async function authCommand(args) {
  const [operation, source, ...rest] = args;
  if (operation !== "import" || source !== "openclaw") {
    throw new Error("auth requires import openclaw");
  }
  await importOpenClawOAuth(rest);
}

async function importOpenClawOAuth(args) {
  const state = stateDir(args);
  await ensureConfig(state);
  const providerName = option(args, "--provider", "openai");
  const requestedProfile = option(args, "--profile", "");
  const source = await readOpenClawAuthSource(args);
  const profile = selectOpenClawProfile(source.profiles, source.state, providerName, requestedProfile);
  const providerArgs = ["--auth", "oauth"];
  const requestedModel = option(args, "--model", "");
  if (requestedModel) providerArgs.push("--model", requestedModel);
  await addProvider(state, providerArgs, providerName);

  const config = await readConfig(state);
  const configured = normalizeModelConfig(config).providers[providerName];
  if (!configured) throw new Error(`provider could not be configured: ${providerName}`);
  const saved = await saveOAuthToken(configured, state, {
    access_token: profile.access,
    refresh_token: profile.refresh,
    expires_at: profile.expires,
    ...(profile.tokenEndpoint ? { tokenEndpoint: profile.tokenEndpoint } : {})
  });
  if (!hasFlag(args, "--keep-default")) {
    config.defaultModel = `${providerName}:${configured.models[0]}`;
    await saveConfig(state, config);
  }
  await printJson({
    ok: true,
    provider: providerName,
    profile: profile.id,
    source: source.path,
    tokenPath: saved.path,
    defaultModel: hasFlag(args, "--keep-default") ? normalizeModelConfig(config).defaultModel : config.defaultModel
  });
}

async function readOpenClawAuthSource(args) {
  const explicit = option(args, "--source", "");
  const candidates = explicit
    ? [resolveInvocationPath(explicit)]
    : [
        process.env.OPENCLAW_AUTH_PROFILES,
        process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "agent", "openclaw-agent.sqlite") : "",
        process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "agent", "auth-profiles.json") : "",
        join(homedir(), ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite"),
        join(homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json")
      ].filter(Boolean).map((candidate) => resolve(candidate));
  const uniqueCandidates = Array.from(new Set(candidates));
  for (const path of uniqueCandidates) {
    try {
      await access(path);
      if (/\.sqlite(?:3)?$/i.test(path)) return readOpenClawSqliteSource(path);
      return readOpenClawJsonSource(path);
    } catch (error) {
      if (explicit || error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("OpenClaw auth store not found; pass --source <auth-profiles.json|openclaw-agent.sqlite>");
}

async function readOpenClawJsonSource(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  const auth = value?.profiles ? value : value?.auth;
  if (!auth?.profiles || typeof auth.profiles !== "object") throw new Error(`OpenClaw auth source has no profiles: ${path}`);
  return { path, profiles: auth.profiles, state: {} };
}

async function readOpenClawSqliteSource(path) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("this Node runtime cannot read OpenClaw SQLite auth; pass --source auth-profiles.json instead");
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const store = database.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary");
    if (!store?.store_json) throw new Error(`OpenClaw auth SQLite store has no primary profile store: ${path}`);
    const state = database.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?").get("primary");
    const parsedStore = JSON.parse(store.store_json);
    return {
      path,
      profiles: parsedStore.profiles,
      state: state?.state_json ? JSON.parse(state.state_json) : {}
    };
  } finally {
    database.close();
  }
}

function selectOpenClawProfile(profiles, state, providerName, requestedProfile) {
  const entries = Object.entries(profiles ?? {})
    .map(([id, profile]) => ({ id, ...(profile ?? {}) }))
    .filter((profile) => (profile.provider ?? profile.id.split(":", 1)[0]) === providerName)
    .filter((profile) => profile.type === "oauth" && (profile.access || profile.refresh));
  if (!entries.length) throw new Error(`OpenClaw has no usable OAuth profile for ${providerName}`);
  if (requestedProfile) {
    const match = entries.find((profile) => profile.id === requestedProfile || profile.email === requestedProfile || profile.id.endsWith(`:${requestedProfile}`));
    if (!match) throw new Error(`OpenClaw OAuth profile not found: ${requestedProfile}`);
    return match;
  }
  const preferred = [
    state?.lastGood?.[providerName],
    ...(Array.isArray(state?.order?.[providerName]) ? state.order[providerName] : []),
    `${providerName}:default`
  ].find((id) => entries.some((profile) => profile.id === id));
  if (preferred) return entries.find((profile) => profile.id === preferred);
  if (entries.length === 1) return entries[0];
  throw new Error(`OpenClaw has multiple ${providerName} OAuth profiles; pass --profile ${entries.map((profile) => profile.id).join(" or ")}`);
}

async function importCommand(args) {
  const [framework, ...rest] = args;
  if (!["openclaw", "hermes"].includes(framework)) throw new Error("import requires openclaw or hermes");
  const state = stateDir(rest);
  await ensureConfig(state);
  const root = resolveInvocationPath(option(rest, "--source", framework === "openclaw" ? join(homedir(), ".openclaw") : join(homedir(), ".hermes")));
  const dryRun = hasFlag(rest, "--dry-run");
  const includeAuth = !hasFlag(rest, "--skills-only");
  const includeSkills = !hasFlag(rest, "--auth-only");
  const includeSupportFiles = !hasFlag(rest, "--auth-only");
  const result = {
    ok: true,
    framework,
    source: root,
    state,
    dryRun,
    auth: includeAuth ? await importFrameworkAuth(framework, root, state, rest, dryRun) : { skipped: true },
    skills: includeSkills ? await importFrameworkSkills(framework, root, state, dryRun) : { skipped: true },
    supportFiles: includeSupportFiles ? await importFrameworkSupportFiles(framework, root, state, dryRun) : { skipped: true }
  };
  if (!dryRun) {
    await mkdir(join(state, "imports", framework), { recursive: true });
    await writeFile(join(state, "imports", framework, "manifest.json"), `${JSON.stringify({
      version: 1,
      framework,
      source: root,
      importedAt: new Date().toISOString(),
      auth: result.auth,
      skills: result.skills,
      supportFiles: result.supportFiles
    }, null, 2)}\n`);
  }
  await printJson(result);
}

async function importFrameworkAuth(framework, root, state, args, dryRun) {
  const source = await readFrameworkAuth(framework, root);
  if (framework === "hermes") {
    const tokens = source.value?.providers?.["openai-codex"]?.tokens;
    if (!tokens?.access_token && !tokens?.refresh_token) return { source: source.path, imported: [], skipped: ["no OpenAI Codex OAuth token"] };
    if (dryRun) return { source: source.path, imported: [{ provider: "openai", profile: "openai-codex" }], skipped: [] };
    await addProvider(state, ["--auth", "oauth"], "openai");
    const config = await readConfig(state);
    const provider = normalizeModelConfig(config).providers.openai;
    const saved = await saveOAuthToken(provider, state, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      accountId: tokens.account_id
    });
    if (!hasFlag(args, "--keep-default")) {
      config.defaultModel = `openai:${provider.models[0]}`;
      await saveConfig(state, config);
    }
    return { source: source.path, imported: [{ provider: "openai", profile: "openai-codex", tokenPath: saved.path }], skipped: [] };
  }

  const imported = [];
  const skipped = [];
  const profiles = source.profiles ?? source.value?.profiles ?? {};
  const sourceState = source.state ?? source.value?.state ?? {};
  for (const providerMap of [{ source: "openai", target: "openai" }]) {
    let profile;
    try {
      profile = selectOpenClawProfile(profiles, sourceState, providerMap.source, "");
    } catch (error) {
      skipped.push(`${providerMap.source}: ${error.message}`);
      continue;
    }
    if (dryRun) {
      imported.push({ provider: providerMap.target, profile: profile.id });
      continue;
    }
    await addProvider(state, ["--auth", "oauth"], providerMap.target);
    const config = await readConfig(state);
    const provider = normalizeModelConfig(config).providers[providerMap.target];
    const saved = await saveOAuthToken(provider, state, {
      access_token: profile.access,
      refresh_token: profile.refresh,
      expires_at: profile.expires
    });
    if (!hasFlag(args, "--keep-default")) {
      config.defaultModel = `${providerMap.target}:${provider.models[0]}`;
      await saveConfig(state, config);
    }
    imported.push({ provider: providerMap.target, profile: profile.id, tokenPath: saved.path });
  }
  return { source: source.path, imported, skipped };
}

async function readFrameworkAuth(framework, root) {
  if (framework === "hermes") {
    const path = root.endsWith("auth.json") ? root : join(root, "auth.json");
    return { path, value: JSON.parse(await readFile(path, "utf8")) };
  }
  const candidates = /\.sqlite(?:3)?$|auth-profiles\.json$/i.test(root)
    ? [root]
    : [join(root, "agents", "main", "agent", "openclaw-agent.sqlite"), join(root, "agents", "main", "agent", "auth-profiles.json")];
  for (const path of candidates) {
    try {
      await access(path);
      return /\.sqlite(?:3)?$/i.test(path) ? readOpenClawSqliteSource(path) : readOpenClawJsonSource(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`OpenClaw auth store not found under ${root}`);
}

async function importFrameworkSkills(framework, root, state, dryRun) {
  const directories = framework === "hermes"
    ? [{ label: "global", path: join(root, "skills") }]
    : [
        { label: "global", path: join(root, "skills") },
        { label: "main-agent", path: join(root, "agents", "main", "skills") }
      ];
  const copied = [];
  for (const directory of directories) {
    const files = await listImportFiles(directory.path);
    if (!files.length) continue;
    const targetRoot = join(state, "skills", "imported", framework, directory.label);
    for (const file of files) {
      const relativePath = relative(directory.path, file);
      const target = join(targetRoot, relativePath);
      if (!dryRun) {
        await mkdir(resolve(target, ".."), { recursive: true });
        await copyFile(file, target);
      }
      copied.push({ source: file, path: join("skills", "imported", framework, directory.label, relativePath).replaceAll("\\", "/") });
    }
  }
  return {
    directories: directories.map((directory) => directory.path),
    skillCount: copied.filter((file) => file.source.endsWith("/SKILL.md")).length,
    fileCount: copied.length
  };
}

async function listImportFiles(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory()) return [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) files.push(...await listImportFiles(path));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

async function importFrameworkSupportFiles(framework, root, state, dryRun) {
  const candidates = framework === "hermes"
    ? ["SOUL.md", "memories/MEMORY.md", "memories/USER.md"]
    : ["workspace/SOUL.md", "workspace/USER.md", "workspace/AGENTS.md"];
  const copied = [];
  for (const relativePath of candidates) {
    const source = join(root, relativePath);
    try {
      const info = await lstat(source);
      if (!info.isFile()) continue;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const targetRelativePath = join("imports", framework, "support", relativePath).replaceAll("\\", "/");
    if (!dryRun) {
      const target = join(state, targetRelativePath);
      await mkdir(resolve(target, ".."), { recursive: true });
      await copyFile(source, target);
    }
    copied.push({ source, path: targetRelativePath });
  }
  return copied;
}

async function addProvider(state, args, name, existingConfig) {
  const config = existingConfig ?? await readConfig(state);
  const preset = PROVIDER_PRESETS[name] ?? { type: "openai-compatible", baseUrl: "", apiKeyEnv: "", models: [] };
  const existing = config.providers?.[name];
  const authMode = option(args, "--auth", existing?.auth?.mode ?? preset.defaultAuth ?? preset.auth?.mode ?? "api-key");
  const authPreset = ["oauth", "device", "cli"].includes(authMode)
    ? (authMode === "oauth" ? (preset.oauth ?? {}) : (preset.auth ?? {}))
    : preset;
  const authDefaults = authPreset.auth ?? authPreset;
  const sameAuthMode = existing && (existing.auth?.mode ?? "api-key") === authMode;
  const baseUrl = option(args, "--base-url", (sameAuthMode ? existing?.baseUrl : undefined) ?? authPreset.baseUrl ?? preset.baseUrl);
  if (!baseUrl && preset.type !== "cli") throw new Error("provider requires --base-url when no preset exists");
  const models = splitCsv(option(args, "--model", ((sameAuthMode ? existing?.models : undefined) ?? authPreset.models ?? preset.models ?? []).join(",")));
  if (!models.length) throw new Error("provider requires at least one --model");
  const apiKeyEnv = authMode === "api-key" ? option(args, "--api-key-env", existing?.apiKeyEnv ?? preset.apiKeyEnv) : "";
  config.providers ??= {};
  const provider = { type: preset.type, baseUrl, apiKeyEnv, models };
  if (authPreset.transport ?? preset.transport ?? (sameAuthMode ? existing?.transport : undefined)) provider.transport = authPreset.transport ?? preset.transport ?? existing?.transport;
  if (["oauth", "device", "cli"].includes(authMode)) {
    const previous = sameAuthMode ? existing?.auth ?? {} : authDefaults;
    const scopes = splitCsv(option(args, "--scope", (previous.scopes ?? []).join(",")));
    const auth = {
      mode: authMode,
      flow: previous.flow ?? authPreset.flow ?? "generic-pkce",
      authorizationUrl: option(args, "--authorization-url", previous.authorizationUrl ?? authDefaults.authorizationUrl ?? ""),
      tokenUrl: option(args, "--token-url", previous.tokenUrl ?? authDefaults.tokenUrl ?? ""),
      clientId: option(args, "--client-id", previous.clientId ?? authDefaults.clientId ?? ""),
      clientIdEnv: previous.clientIdEnv ?? authDefaults.clientIdEnv ?? "",
      clientSecretEnv: option(args, "--client-secret-env", previous.clientSecretEnv ?? authDefaults.clientSecretEnv ?? ""),
      scopes,
      redirectUri: option(args, "--redirect-uri", previous.redirectUri ?? authDefaults.redirectUri ?? ""),
      authorizationParams: previous.authorizationParams ?? authDefaults.authorizationParams ?? {},
      commandEnv: previous.commandEnv ?? authDefaults.commandEnv ?? "",
      tokenFile: previous.tokenFile ?? join("oauth", `${name}.json`)
    };
    if (authMode === "oauth" && auth.flow !== "openrouter-pkce" && (!auth.authorizationUrl || !auth.tokenUrl || (!auth.clientId && !auth.clientIdEnv))) {
      throw new Error("OAuth provider requires --authorization-url, --token-url, and --client-id or --client-id-env");
    }
    provider.auth = auth;
  }
  config.providers[name] = provider;
  config.policy ??= createDefaultPolicy();
  config.policy.allowedCapabilities = Array.from(new Set([...(config.policy.allowedCapabilities ?? []), "model.chat"]));
  if (!config.defaultModel || !listConfiguredModels(normalizeModelConfig(config)).some((entry) => entry.id === config.defaultModel)) {
    config.defaultModel = `${name}:${models[0]}`;
  }
  await saveConfig(state, config);
}

async function summarizeProviders(config, state) {
  return Promise.all(Object.entries(config.providers ?? {}).map(async ([name, provider]) => ({
    name,
    type: provider.type ?? "openai-compatible",
    baseUrl: provider.baseUrl,
    authMode: provider.auth?.mode ?? "api-key",
    apiKeyEnv: provider.apiKeyEnv ?? "",
    models: provider.models ?? [],
    configured: ["oauth", "device"].includes(provider.auth?.mode)
      ? await oauthTokenExists(provider, state)
      : provider.auth?.mode === "cli"
        ? Boolean(process.env[provider.auth.commandEnv || "ODINN_ANTIGRAVITY_CLI"] || "agy")
      : !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv])
  })));
}

async function oauthTokenExists(provider, state) {
  try {
    await access(oauthTokenPath(provider, state));
    return true;
  } catch {
    return false;
  }
}

async function connectOAuth(state, name, args) {
  const config = await readConfig(state);
  const provider = normalizeModelConfig(config).providers[name];
  if (!provider || provider.auth.mode !== "oauth") throw new Error(`OAuth provider not found: ${name}`);
  if (provider.auth.flow === "openrouter-pkce") {
    await connectOpenRouterOAuth(state, name, provider, args);
    return;
  }
  const configuredRedirect = provider.auth.redirectUri ? new URL(provider.auth.redirectUri) : null;
  const server = createServer();
  const callback = new Promise((resolveCallback, rejectCallback) => {
    server.on("request", (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const expectedPath = configuredRedirect?.pathname || "/oauth/callback";
        if (url.pathname !== expectedPath) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        if (url.searchParams.get("error")) {
          rejectCallback(new Error(`OAuth authorization failed: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`));
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end("OAuth authorization failed. You can close this tab.");
          return;
        }
        if (url.searchParams.get("state") !== authRequest.state) {
          rejectCallback(new Error("OAuth callback state did not match"));
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end("OAuth state mismatch. You can close this tab.");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) throw new Error("OAuth callback did not contain an authorization code");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>Odinn connected</h1><p>You can close this tab.</p>");
        resolveCallback({ code });
      } catch (error) {
        rejectCallback(error);
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error.message);
      }
    });
  });
  const requestedPort = configuredRedirect?.port
    ? Number.parseInt(configuredRedirect.port, 10)
    : Number.parseInt(option(args, "--oauth-port", "0"), 10);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(Number.isFinite(requestedPort) ? requestedPort : 0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  const redirectUri = provider.auth.redirectUri || `http://127.0.0.1:${port}/oauth/callback`;
  const authRequest = createOAuthAuthorizationRequest(provider, { redirectUri });
  const timeoutMs = Number.parseInt(option(args, "--oauth-timeout-ms", "120000"), 10);
  console.log(`Open this URL to connect ${name}:\n\n${authRequest.authorizationUrl}\n`);
  if (!hasFlag(args, "--no-open")) openAuthorizationUrl(authRequest.authorizationUrl);
  try {
    const result = await withTimeout(callback, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000, "OAuth authorization timed out");
    const token = await exchangeOAuthCode(provider, {
      code: result.code,
      codeVerifier: authRequest.codeVerifier,
      redirectUri
    });
    const saved = await saveOAuthToken(provider, state, token);
    console.log(`OAuth connected for ${name}. Token stored at ${saved.path}.`);
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
}

async function connectOpenRouterOAuth(state, name, provider, args) {
  const port = Number.parseInt(option(args, "--oauth-port", "3000"), 10);
  const callbackPort = Number.isFinite(port) && port > 0 ? port : 3000;
  const callbackPath = "/openrouter-oauth/callback";
  const redirectBase = `http://localhost:${callbackPort}${callbackPath}`;
  const stateValue = randomBytes(24).toString("hex");
  const codeVerifier = randomBytes(32).toString("hex");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const callbackUrl = new URL(redirectBase);
  callbackUrl.searchParams.set("state", stateValue);
  const authorizationUrl = new URL("https://openrouter.ai/auth");
  authorizationUrl.searchParams.set("callback_url", callbackUrl.toString());
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  const server = createServer();
  const callback = new Promise((resolveCallback, rejectCallback) => {
    server.on("request", (request, response) => {
      try {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${callbackPort}`);
        if (url.pathname !== callbackPath) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        if (url.searchParams.get("error")) throw new Error(url.searchParams.get("error_description") || url.searchParams.get("error"));
        if (url.searchParams.get("state") !== stateValue) throw new Error("OpenRouter OAuth state did not match");
        const code = url.searchParams.get("code");
        if (!code) throw new Error("OpenRouter OAuth callback did not contain a code");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>Odinn connected</h1><p>You can close this tab.</p>");
        resolveCallback(code);
      } catch (error) {
        rejectCallback(error);
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error.message);
      }
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(callbackPort, "localhost", resolveListen);
  });
  console.log(`Open this URL to connect ${name}:\n\n${authorizationUrl}\n`);
  if (!hasFlag(args, "--no-open")) openAuthorizationUrl(authorizationUrl.toString());
  try {
    const code = await withTimeout(callback, oauthTimeout(args), "OpenRouter OAuth authorization timed out");
    const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier, code_challenge_method: "S256" })
    });
    const payload = await readJsonResponse(response);
    if (!response.ok || !payload.key) throw new Error(`OpenRouter OAuth key exchange returned ${response.status}: ${oauthErrorMessage(payload)}`);
    const saved = await saveOAuthToken(provider, state, { access_token: payload.key });
    console.log(`OAuth connected for ${name}. Token stored at ${saved.path}.`);
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
}

async function connectDeviceAuth(state, name, args) {
  const config = await readConfig(state);
  const provider = normalizeModelConfig(config).providers[name];
  if (!provider || provider.auth.mode !== "device") throw new Error(`device provider not found: ${name}`);
  if (provider.auth.flow === "github-copilot-device") {
    await connectGitHubCopilot(state, provider, args);
    return;
  }
  if (provider.auth.flow === "xai-device") {
    await connectXaiDevice(state, provider, args);
    return;
  }
  throw new Error(`unsupported device auth flow for ${name}`);
}

async function connectGitHubCopilot(state, provider, args) {
  const clientId = "Iv1.b507a08c87ecfe98";
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "GitHubCopilotChat/0.35.0" },
    body: new URLSearchParams({ client_id: clientId, scope: "read:user" })
  });
  const device = await readJsonResponse(response);
  if (!response.ok || !device.device_code || !device.user_code || !device.verification_uri) {
    throw new Error(`GitHub device authorization failed: ${oauthErrorMessage(device)}`);
  }
  console.log(`Open ${device.verification_uri} and enter code ${device.user_code}.`);
  if (!hasFlag(args, "--no-open")) openAuthorizationUrl(device.verification_uri);
  const githubToken = await pollGitHubDeviceToken(device, clientId, args);
  const tokenResponse = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubToken}`,
      "user-agent": "GitHubCopilotChat/0.35.0",
      "editor-version": "vscode/1.107.0",
      "editor-plugin-version": "copilot-chat/0.35.0",
      "copilot-integration-id": "vscode-chat"
    }
  });
  const copilot = await readJsonResponse(tokenResponse);
  if (!tokenResponse.ok || !copilot.token) throw new Error(`GitHub Copilot token exchange failed: ${oauthErrorMessage(copilot)}`);
  const baseUrl = copilot.token.match(/proxy-ep=([^;]+)/)?.[1];
  const saved = await saveOAuthToken(provider, state, {
    access_token: copilot.token,
    refresh_token: githubToken,
    expires_at: Number(copilot.expires_at) * 1000,
    ...(baseUrl ? { baseUrl: `https://${baseUrl.replace(/^proxy\./, "api.")}` } : {})
  });
  console.log(`GitHub Copilot connected. Token stored at ${saved.path}.`);
}

async function pollGitHubDeviceToken(device, clientId, args) {
  const deadline = Date.now() + (Number.parseInt(option(args, "--oauth-timeout-ms", "300000"), 10) || 300000);
  let interval = Math.max(1000, Number(device.interval || 5) * 1000);
  while (Date.now() < deadline) {
    await delay(interval);
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "GitHubCopilotChat/0.35.0" },
      body: new URLSearchParams({ client_id: clientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
    });
    const payload = await readJsonResponse(response);
    if (payload.access_token) return payload.access_token;
    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`GitHub device authorization failed: ${oauthErrorMessage(payload)}`);
  }
  throw new Error("GitHub device authorization timed out");
}

async function connectXaiDevice(state, provider, args) {
  const discoveryResponse = await fetch("https://auth.x.ai/.well-known/openid-configuration", { headers: { accept: "application/json" } });
  const discovery = await readJsonResponse(discoveryResponse);
  if (!discoveryResponse.ok || !isTrustedXaiUrl(discovery.device_authorization_endpoint) || !isTrustedXaiUrl(discovery.token_endpoint)) {
    throw new Error(`xAI OAuth discovery failed: ${oauthErrorMessage(discovery)}`);
  }
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
  const deviceResponse = await fetch(discovery.device_authorization_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: "openid profile email offline_access grok-cli:access api:access" })
  });
  const device = await readJsonResponse(deviceResponse);
  if (!deviceResponse.ok || !device.device_code || !device.user_code || !device.verification_uri) throw new Error(`xAI device authorization failed: ${oauthErrorMessage(device)}`);
  const verification = device.verification_uri_complete || device.verification_uri;
  console.log(`Open ${verification} and enter code ${device.user_code}.`);
  if (!hasFlag(args, "--no-open")) openAuthorizationUrl(verification);
  const token = await pollXaiDeviceToken(device, discovery.token_endpoint, clientId, args);
  const saved = await saveOAuthToken(provider, state, { ...token, tokenEndpoint: discovery.token_endpoint });
  console.log(`xAI OAuth connected. Token stored at ${saved.path}.`);
}

async function pollXaiDeviceToken(device, tokenEndpoint, clientId, args) {
  const deadline = Date.now() + (Number.parseInt(option(args, "--oauth-timeout-ms", "300000"), 10) || 300000);
  let interval = Math.max(1000, Number(device.interval || 5) * 1000);
  while (Date.now() < deadline) {
    await delay(interval);
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: device.device_code })
    });
    const payload = await readJsonResponse(response);
    if (response.ok && payload.access_token) return payload;
    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`xAI device authorization failed: ${oauthErrorMessage(payload)}`);
  }
  throw new Error("xAI device authorization timed out");
}

async function connectCliAuth(provider) {
  const command = process.env[provider.auth.commandEnv || "ODINN_ANTIGRAVITY_CLI"] || "agy";
  console.log(`Starting ${command}. Complete sign-in in the CLI, then exit it to finish onboarding.`);
  await new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, [], { stdio: "inherit" });
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => code === 0 ? resolveExit() : rejectExit(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

async function readJsonResponse(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { error: raw.slice(0, 500) };
  }
}

function oauthErrorMessage(payload) {
  return payload?.error_description || payload?.message || payload?.error || "request failed";
}

function isTrustedXaiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"));
  } catch {
    return false;
  }
}

function oauthTimeout(args) {
  const timeout = Number.parseInt(option(args, "--oauth-timeout-ms", "300000"), 10);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 300000;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function openAuthorizationUrl(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("OAuth authorization URL must use http or https");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const commandArgs = process.platform === "win32" ? ["/c", "start", "", parsed.href] : [parsed.href];
  // lgtm[js/command-line-injection] - shell execution is disabled and the URL is restricted to HTTP(S).
  const child = spawn(command, commandArgs, { detached: true, stdio: "ignore", shell: false });
  child.unref();
}

async function tui(args) {
  const render = async () => {
    const current = await status(args);
    const store = createAuditStore(join(current.state, current.auditLog ?? "audit.jsonl"));
    return renderTui({ ...current, runs: await store.readRuns() });
  };
  if (!hasFlag(args, "--watch")) {
    console.log(await render());
    return;
  }
  const intervalMs = Number.parseInt(option(args, "--interval-ms", "2000"), 10);
  const delay = Number.isFinite(intervalMs) && intervalMs >= 250 ? intervalMs : 2000;
  while (true) {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(await render());
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function run(args) {
  const state = stateDir(args);
  const tool = option(args, "--tool");
  if (!tool) throw new Error("run requires --tool");
  const inputRaw = option(args, "--input-json", "{}");
  const input = JSON.parse(inputRaw);
  const config = await readConfig(state);
  const result = await runTask({
    task: { tool, input, actor: "cli" },
    auditStore: createAuditStore(join(state, config.auditLog ?? "audit.jsonl")),
    policy: createDefaultPolicy(config.policy),
    registry: createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config })
  });
  await printJson(result);
}

async function plan(args) {
  const state = stateDir(args);
  const file = option(args, "--file");
  if (!file) throw new Error("plan requires --file");
  const config = await readConfig(state);
  const result = await runPlan({
    plan: JSON.parse(await readFile(resolveInvocationPath(file), "utf8")),
    auditStore: createAuditStore(join(state, config.auditLog ?? "audit.jsonl")),
    policy: createDefaultPolicy(config.policy),
    registry: createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config }),
    actor: "cli"
  });
  await printJson(result);
}

async function memory(args) {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "remember":
      await runMemoryTool(rest, "memory.remember", {
        kind: option(rest, "--kind", "project"),
        subject: option(rest, "--subject", "general"),
        namespace: option(rest, "--namespace", ""),
        tier: option(rest, "--tier", "l1"),
        summary: option(rest, "--summary", ""),
        expiresAt: option(rest, "--expires-at", ""),
        text: option(rest, "--text"),
        tags: splitCsv(option(rest, "--tags", "")),
        source: option(rest, "--source", "cli"),
        authority: option(rest, "--authority", "user-reviewed"),
        safeToAct: option(rest, "--safe-to-act", ""),
        avoid: option(rest, "--avoid", "")
      });
      break;
    case "search":
      await runMemoryTool(rest, "memory.search", {
        query: option(rest, "--query", ""),
        kind: option(rest, "--kind", ""),
        subject: option(rest, "--subject", ""),
        limit: Number.parseInt(option(rest, "--limit", "20"), 10)
      });
      break;
    case "recall":
      await runMemoryTool(rest, "memory.recall", {
        query: option(rest, "--query"),
        namespace: option(rest, "--namespace", ""),
        kind: option(rest, "--kind", ""),
        limit: Number.parseInt(option(rest, "--limit", "8"), 10)
      });
      break;
    case "browse":
      await runMemoryTool(rest, "memory.browse", {
        namespace: option(rest, "--namespace", ""),
        limit: Number.parseInt(option(rest, "--limit", "50"), 10)
      });
      break;
    case "open":
      await runMemoryTool(rest, "memory.open", { id: option(rest, "--id") });
      break;
    case "compact":
      await runMemoryTool(rest, "memory.compact", { sessionId: option(rest, "--session") });
      break;
    case "correct":
      await runMemoryTool(rest, "memory.correct", {
        targetId: option(rest, "--target"),
        text: option(rest, "--text"),
        reason: option(rest, "--reason", "correction"),
        source: option(rest, "--source", "cli"),
        authority: option(rest, "--authority", "user-correction")
      });
      break;
    case "curate":
      await runMemoryTool(rest, "memory.curate", {
        limit: Number.parseInt(option(rest, "--limit", "100"), 10)
      });
      break;
    default:
      throw new Error("memory requires subcommand: remember, search, recall, browse, open, compact, correct, or curate");
  }
}

async function extensionCommand(args) {
  const [subcommand, ...rest] = args;
  const registry = new ExtensionRegistry(join(stateDir(rest), "extensions.json"));
  switch (subcommand ?? "list") {
    case "install":
      await printJson(await registry.install(JSON.parse(await readFile(resolveInvocationPath(option(rest, "--manifest")), "utf8")), {
        source: option(rest, "--source", "local-manifest"),
        provenance: option(rest, "--provenance", "user-reviewed")
      }));
      break;
    case "list":
      await printJson({ extensions: await registry.list() });
      break;
    case "enable":
      await printJson(await registry.enable(option(rest, "--id"), {
        grants: splitCsv(option(rest, "--grant", "")),
        trust: hasFlag(rest, "--trust"),
        allowUnsafeSandbox: hasFlag(rest, "--allow-unsafe-sandbox")
      }));
      break;
    case "disable":
      await printJson(await registry.disable(option(rest, "--id"), option(rest, "--reason", "operator disabled")));
      break;
    case "rollback":
      await printJson(await registry.rollback(option(rest, "--id")));
      break;
    case "run": {
      const id = option(rest, "--id");
      if (!id) throw new Error("extension run requires --id <id>");
      const input = JSON.parse(option(rest, "--input-json", "{}"));
      const executor = new ExtensionExecutor(registry, { workspaceRoot: invocationRoot() });
      await printJson(await executor.invoke(id, input, { capability: option(rest, "--capability", "") }));
      break;
    }
    default:
      throw new Error("extension requires subcommand: install, list, enable, disable, rollback, or run");
  }
}

async function stateCommand(args) {
  const [subcommand, ...rest] = args;
  const state = stateDir(rest);
  if (subcommand === "backup" || subcommand === "export") {
    const output = option(rest, "--output");
    if (!output) throw new Error("state backup requires --output <directory>");
    const destination = resolveInvocationPath(output);
    if (destination === state || destination.startsWith(`${state}/`) || destination.startsWith(`${state}\\`)) {
      throw new Error("state backup destination must not be inside the active state directory");
    }
    await cp(state, destination, { recursive: true, force: false, errorOnExist: true });
    await writeFile(join(destination, "backup-manifest.json"), `${JSON.stringify({ schemaVersion: 1, source: state, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
    await printJson({ ok: true, operation: "backup", source: state, destination });
    return;
  }
  if (subcommand === "restore" || subcommand === "import") {
    if (!hasFlag(rest, "--confirm")) throw new Error("state restore is destructive; pass --confirm after reviewing the backup");
    const input = option(rest, "--input");
    if (!input) throw new Error("state restore requires --input <directory>");
    const source = resolveInvocationPath(input);
    await access(source);
    const backup = `${state}.before-restore-${Date.now()}`;
    await cp(state, backup, { recursive: true, force: false, errorOnExist: true }).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await mkdir(state, { recursive: true });
    await cp(source, state, { recursive: true, force: true });
    await printJson({ ok: true, operation: "restore", source, destination: state, preRestoreBackup: backup });
    return;
  }
  throw new Error("state requires subcommand: backup or restore");
}

async function session(args) {
  const [subcommand, ...rest] = args;
  switch (subcommand ?? "list") {
    case "create":
      await runRecordTool(rest, "session.create", {
        title: option(rest, "--title", "Untitled session"),
        tags: splitCsv(option(rest, "--tags", "")),
        source: option(rest, "--source", "cli")
      });
      break;
    case "message":
      await runRecordTool(rest, "session.message", {
        sessionId: option(rest, "--session"),
        role: option(rest, "--role", "user"),
        content: option(rest, "--content"),
        source: option(rest, "--source", "cli")
      });
      break;
    case "rename":
      await runRecordTool(rest, "session.rename", {
        sessionId: option(rest, "--session"),
        title: option(rest, "--title"),
        source: option(rest, "--source", "cli")
      });
      break;
    case "delete":
      await runRecordTool(rest, "session.delete", {
        sessionId: option(rest, "--session"),
        source: option(rest, "--source", "cli")
      });
      break;
    case "list":
      await runRecordTool(rest, "session.list", {
        limit: Number.parseInt(option(rest, "--limit", "20"), 10)
      });
      break;
    case "read":
      await runRecordTool(rest, "session.read", {
        sessionId: option(rest, "--session")
      });
      break;
    default:
      throw new Error("session requires subcommand: create, message, rename, delete, list, or read");
  }
}

async function goal(args) {
  const [subcommand, ...rest] = args;
  switch (subcommand ?? "list") {
    case "create":
      await runRecordTool(rest, "goal.create", {
        title: option(rest, "--title"),
        description: option(rest, "--description", ""),
        tags: splitCsv(option(rest, "--tags", "")),
        source: option(rest, "--source", "cli")
      });
      break;
    case "update":
      await runRecordTool(rest, "goal.update", {
        goalId: option(rest, "--goal"),
        status: option(rest, "--status", "active"),
        note: option(rest, "--note", ""),
        source: option(rest, "--source", "cli")
      });
      break;
    case "list":
      await runRecordTool(rest, "goal.list", {
        limit: Number.parseInt(option(rest, "--limit", "20"), 10)
      });
      break;
    default:
      throw new Error("goal requires subcommand: create, update, or list");
  }
}

async function improve(args) {
  const [subcommand, ...rest] = args;
  switch (subcommand ?? "list") {
    case "propose":
      await runRecordTool(rest, "improve.propose", {
        title: option(rest, "--title"),
        rationale: option(rest, "--rationale"),
        target: option(rest, "--target", "runtime"),
        priority: option(rest, "--priority", "normal"),
        evidence: splitCsv(option(rest, "--evidence", "")),
        source: option(rest, "--source", "cli")
      });
      break;
    case "decide":
      await runRecordTool(rest, "improve.decide", {
        improvementId: option(rest, "--improvement"),
        decision: option(rest, "--decision"),
        note: option(rest, "--note", ""),
        source: option(rest, "--source", "cli")
      });
      break;
    case "list":
      await runRecordTool(rest, "improve.list", {
        limit: Number.parseInt(option(rest, "--limit", "20"), 10)
      });
      break;
    default:
      throw new Error("improve requires subcommand: propose, decide, or list");
  }
}

async function runMemoryTool(args, tool, input) {
  await runRecordTool(args, tool, input);
}

async function runRecordTool(args, tool, input) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const result = await runTask({
    task: { tool, input, actor: "cli" },
    auditStore: createAuditStore(join(state, config.auditLog ?? "audit.jsonl")),
    policy: createDefaultPolicy(config.policy),
    registry: createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config })
  });
  await printJson(result.output);
}

async function audit(args) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const store = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  await printJson(await store.readAll());
}

async function runs(args) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const limit = Number.parseInt(option(args, "--limit", "20"), 10);
  const store = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  await printJson((await store.readRuns()).slice(0, Number.isFinite(limit) ? limit : 20));
}

async function show(args) {
  const state = stateDir(args);
  const runId = option(args, "--run");
  if (!runId) throw new Error("show requires --run");
  const config = await readConfig(state);
  const store = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  const run = await store.readRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  await printJson(run);
}

async function readConfig(state) {
  const path = join(state, "config.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, policy: createDefaultPolicy(), auditLog: "audit.jsonl", providers: {}, defaultModel: "" };
  }
}

async function ensureConfig(state) {
  const configPath = join(state, "config.json");
  await mkdir(state, { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    policy: createDefaultPolicy(),
    auditLog: "audit.jsonl",
    providers: {},
    defaultModel: ""
  }, null, 2)}\n`, { flag: "wx" }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  return configPath;
}

async function saveConfig(state, config) {
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "config.json"), `${JSON.stringify({
    version: config.version ?? 1,
    policy: config.policy ?? createDefaultPolicy(),
    auditLog: config.auditLog ?? "audit.jsonl",
    providers: config.providers ?? {},
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {})
  }, null, 2)}\n`);
}

function renderOnboarding({ state, workspaceRoot, configPath, tools, allowedCapabilities, providers, defaultModel, runs }) {
  const providerLines = providers.length
    ? providers.map((provider) => `  - ${provider.name} [${provider.authMode}]: ${provider.models.join(", ")} (${provider.baseUrl})${provider.configured ? "" : provider.authMode === "oauth" ? " [not connected]" : provider.apiKeyEnv ? " [credential missing]" : ""}`)
    : ["  - none"];
  return [
    "Odinn local onboarding",
    "",
    `State: ${state}`,
    `Config: ${configPath}`,
    `Workspace: ${workspaceRoot}`,
    "",
    "Available tools:",
    ...tools.map((tool) => `  - ${tool}`),
    "",
    "Allowed capabilities:",
    ...allowedCapabilities.map((capability) => `  - ${capability}`),
    "",
    "Configured providers:",
    ...providerLines,
    `Default model: ${defaultModel || "(none)"}`,
    "",
    `Provider presets: ${listProviderPresets().map((provider) => provider.name).join(", ")}`,
    "Use a preset without passing URLs:",
    "  pnpm odinn onboard --provider <preset> --state .odinn",
    "  pnpm odinn config provider catalog",
    "",
    `Recorded runs: ${runs.length}`,
    "",
    "Try next:",
    "  pnpm odinn onboard --provider ollama --state .odinn",
    "  pnpm odinn onboard --provider openai --state .odinn",
    "  pnpm odinn onboard --provider openai --auth api-key --model gpt-4.1-mini --state .odinn",
    "  pnpm odinn config model default <provider:model> --state .odinn",
    "  pnpm --filter @odinn/cli start -- run --tool text.echo --input-json '{\"text\":\"Hello, Odinn\"}'",
    "  pnpm --filter @odinn/cli start -- plan --file examples/local-smoke.plan.json",
    "  pnpm odinn memory remember --kind preference --subject cli --text 'Prefer exact commands.'",
    "  pnpm --filter @odinn/cli start -- tui",
    "  pnpm --filter @odinn/gateway start",
    "",
    "Open the GUI after starting the gateway:",
    "  http://127.0.0.1:18790/"
  ].join("\n");
}

function renderTui({ state, workspaceRoot, tools, allowedCapabilities, runs }) {
  const recent = runs.slice(0, 8);
  return [
    "Odinn TUI",
    "=========",
    `Workspace : ${workspaceRoot}`,
    `State     : ${state}`,
    `Tools     : ${tools.join(", ") || "(none)"}`,
    `Policy    : ${allowedCapabilities.join(", ") || "(none)"}`,
    "",
    "Recent runs",
    "-----------",
    recent.length
      ? recent.map((run) => `${run.status.padEnd(9)} ${run.id} ${run.tool ?? ""} ${run.message ?? ""}`.trimEnd()).join("\n")
      : "No runs recorded yet.",
    "",
    "Commands",
    "--------",
    "Run smoke : pnpm --filter @odinn/cli start -- plan --file examples/local-smoke.plan.json",
    "Remember  : pnpm odinn memory remember --text 'A useful fact.'",
    "Watch TUI : pnpm --filter @odinn/cli start -- tui --watch",
    "GUI       : pnpm --filter @odinn/gateway start"
  ].join("\n");
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function printJson(value) {
  console.log(JSON.stringify(redactOutput(value), null, 2));
}

function redactOutput(value) {
  if (Array.isArray(value)) return value.map((item) => redactOutput(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(?:api.?key(?!env)|access.?token|refresh.?token|client.?secret(?!env)|password|authorization)/i.test(key)
      ? "[redacted]"
      : redactOutput(item)
  ]));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
