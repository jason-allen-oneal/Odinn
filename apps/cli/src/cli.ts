#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { access, chmod, copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { createAuditStore, createBuiltInRegistry, createDifferentiatedRuntime, createOAuthAuthorizationRequest, createRunLedger, exchangeOAuthCode, experimentalFeatureWarning, EXPERIMENTAL_FEATURES, ExtensionExecutor, ExtensionRegistry, listConfiguredModels, listProviderPresets, normalizeExperimentalFlags, normalizeModelConfig, normalizeSelfImprovementConfig, oauthTokenPath, parseStructuredDocument, ProofVerifier, PROVIDER_PRESETS, runPlan, runTask, saveOAuthToken, validateContract, validatePolicy, validateVerificationContract, withStateMutationLock } from "@odinn/kernel";
import { createDefaultPolicy } from "@odinn/policy";
import { atomicWrite, commitOnboardingDraft, createOnboardingDraft, discardOnboardingDraft, recoverInterruptedOnboardingTransactions } from "./onboarding/apply.ts";
import { isPromptCancelled, TerminalPrompter } from "./onboarding/prompts.ts";
import { decideGatewayAction, openBrowser, probeGateway } from "./onboarding/runtime.ts";
import { ACCESS_PROFILES, accessProfileLabel, applyAccessProfile, capabilityDelta, identifyAccessProfile } from "./onboarding/state.ts";

const rawArgs = process.argv.slice(2);
const configBaselines = new WeakMap<object, string | null>();
if (rawArgs[0] === "--") rawArgs.shift();
const [command, ...args] = rawArgs;

const EXPERIMENTAL_HOME = [
  {
    id: "proof",
    label: "Proof",
    configKey: "experimental.proof",
    description: "Verify a recorded run against operator-controlled file, HTTP, Git, or allowlisted command assertions.",
    safeActions: [
      "odinn experimental proof contract validate <contract.json|yml>",
      "odinn experimental proof show <run-id> [--state .odinn]"
    ],
    activeActions: ["odinn experimental proof run <run-id> --contract <contract.json|yml> [--state .odinn]"]
  },
  {
    id: "sentinel",
    label: "Sentinel",
    configKey: "experimental.sentinel",
    description: "Evaluate tool input against explicit runtime invariants before execution.",
    safeActions: ["odinn experimental sentinel validate <policy.json|yml>"],
    activeActions: ["odinn experimental sentinel test <policy.json|yml> --tool <tool> --input-json <json> [--state .odinn]"]
  },
  {
    id: "capabilities",
    label: "Capability Tokens",
    configKey: "experimental.capabilities",
    description: "Issue, consume, inspect, and revoke short-lived tokens scoped to one run and tool.",
    safeActions: [
      "odinn experimental capabilities list <run-id> [--state .odinn]",
      "odinn experimental capabilities revoke <capability-id> [--state .odinn]"
    ],
    activeActions: [
      "odinn experimental capabilities issue --run <run-id> --step <step-id> --tool <tool> [--show-token] [--state .odinn]",
      "odinn experimental capabilities use --token <token> --run <run-id> --tool <tool> [--state .odinn]"
    ]
  },
  {
    id: "rewind",
    label: "Rewind",
    configKey: "experimental.rewind",
    description: "Capture workspace checkpoints and preview or explicitly apply a restore plan.",
    safeActions: ["odinn experimental rewind restore <snapshot-id> [--state .odinn]"],
    activeActions: [
      "odinn experimental rewind checkpoint create <run-id> --path <path[,path]> [--state .odinn]",
      "odinn experimental rewind restore <snapshot-id> --apply [--state .odinn]"
    ]
  },
  {
    id: "capsules",
    label: "Capsules",
    configKey: "experimental.capsules",
    description: "Export, verify, inspect, and deliberately replay redacted content-addressed run archives.",
    safeActions: [
      "odinn experimental capsules inspect <run.odinn> [--state .odinn]",
      "odinn experimental capsules verify <run.odinn> [--state .odinn]"
    ],
    activeActions: [
      "odinn experimental capsules export <run-id> --output <run.odinn> [--state .odinn]",
      "odinn experimental capsules replay <run.odinn> [--mode verification-only|tool-mocked|full] [--state .odinn]"
    ]
  },
  {
    id: "counterfactual",
    label: "Counterfactuals",
    configKey: "experimental.counterfactual",
    description: "Create isolated candidate workspaces, compare their evidence, and preview selection before applying it.",
    safeActions: [
      "odinn experimental counterfactual compare <group-id> [--state .odinn]",
      "odinn experimental counterfactual select <group-id> --run <run-id> [--state .odinn]"
    ],
    activeActions: [
      "odinn experimental counterfactual run --source-run <run-id> --from <step-id> --plan-file <plan.json> [--execute] [--state .odinn]",
      "odinn experimental counterfactual select <group-id> --run <run-id> --apply [--state .odinn]"
    ]
  },
  {
    id: "darwin",
    label: "Darwin Routing",
    configKey: "experimental.darwin",
    description: "Record verified model outcomes and choose a route from measured reliability, speed, cost, and compliance.",
    safeActions: ["odinn experimental darwin stats [--task-class <class>] [--state .odinn]"],
    activeActions: [
      "odinn experimental darwin observe --run <run-id> --provider <id> --model <id> --verified true|false [--state .odinn]",
      "odinn experimental darwin choose --task-class <class> [--state .odinn]"
    ]
  },
  {
    id: "self-improvement",
    label: "Self-improvement",
    configKey: "selfImprovement",
    description: "Learn from recorded failures, create auditable proposals, and keep application review-gated unless auto mode is explicitly enabled.",
    safeActions: [
      "odinn experimental self-improvement list [--state .odinn]",
      "odinn experimental self-improvement propose --title <title> --rationale <text> [--state .odinn]"
    ],
    activeActions: [
      "odinn experimental self-improvement set --enabled true --mode propose|auto [--state .odinn]",
      "odinn experimental self-improvement learn [--state .odinn]",
      "odinn experimental self-improvement decide --improvement <id> --decision approved|rejected|applied [--state .odinn]",
      "odinn experimental self-improvement rollback --improvement <id> [--state .odinn]"
    ]
  }
] as const;

function betaBoundaryText() {
  return `Beta 3 boundary

  verified local behavior: the supported local operator path, audited runtime, and release/install workflows covered by the current gates
  experimental and disabled by default: Proof, Sentinel, Capability Tokens, Rewind, Capsules, Counterfactuals, Darwin, and self-improvement
  provider- or platform-dependent: live provider services, browser sites, external authentication, and operating-system/package behavior outside the local gates
  explicitly unsupported: hostile-code containment, public exposure of the single-user gateway, and deterministic rollback or replay of arbitrary remote effects

Hard limits:
  forked workers are crash containment, not a security sandbox;
  remote hosting is application-level tenant isolation, not hostile-user OS isolation;
  external effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

See docs/BETA-3-SURFACE-MATRIX.md for the operator-facing surface matrix.`;
}

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
    case "experimental":
    case "experiments":
      await experimentalCommand(args);
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
    case "start":
    case "serve":
    case "gateway":
      await startGateway(args);
      break;
    case "help":
    case "--help":
    case "-h":
      hasFlag(args, "--all") ? usage() : quickUsage();
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
    case "proof":
      await proof(args);
      break;
    case "policy":
      await policyCommand(args);
      break;
    case "capability":
    case "capabilities":
      await capabilityCommand(args);
      break;
    case "timeline":
      await timeline(args);
      break;
    case "checkpoint":
    case "rewind":
      await rewindCommand(command, args);
      break;
    case "branch":
    case "compare":
      await branchCommand(command, args);
      break;
    case "capsule":
      await capsuleCommand(args);
      break;
    case "counterfactual":
      await counterfactualCommand(args);
      break;
    case "routing":
      await routingCommand(args);
      break;
    default:
      quickUsage(command);
      process.exitCode = command ? 1 : 0;
  }
}

function quickUsage(unknownCommand: string | undefined = undefined) {
  if (unknownCommand) console.error(`Unknown command: ${unknownCommand}\n`);
  console.log(`Ódinn Forge — local-first agent runtime

Get started:
  odinn onboard                     Guided setup
  odinn start                       Open the local chat console

Common commands:
  odinn status                      Check configuration and runtime health
  odinn sessions                    List chats
  odinn runs                        Inspect recent work
  odinn doctor                      Diagnose the current setup

Help:
  odinn help --all                  Show every advanced command

${betaBoundaryText()}`);
}

function usage() {
  console.log(`${betaBoundaryText()}

Usage:
  odinn start [--state .odinn] [--port 18790] [--no-open]
  odinn init [--state .odinn]
  odinn onboard [--provider <name>] [--auth api-key|oauth|device|cli] [--verify] [--state <directory>]
  odinn config provider add <name> [--auth api-key|oauth|device|cli] [--base-url <url>] [--model <model[,model]>] [--api-key-env <ENV>] [--authorization-url <url>] [--token-url <url>] [--client-id <id>] [--scope <scope[,scope]>] [--state .odinn]
  odinn config provider list [--state .odinn]
  odinn config provider catalog
  odinn config provider remove <name> [--state .odinn]
  odinn config security show [--state .odinn]
  odinn config security set --surface web|browser [--enabled true|false] [--allow-private-network true|false] [--allowed-domains a,b] [--blocked-domains a,b] [--require-approval true|false] [--state .odinn]
  odinn config experimental show [--state .odinn]
  odinn config experimental enable|disable <feature> [--state .odinn]
  odinn experimental help [proof|sentinel|capabilities|rewind|capsules|counterfactual|darwin|self-improvement]
  odinn experimental list|status [feature] [--state .odinn]
  odinn experimental enable|disable <feature> [--state .odinn]
  odinn experimental <feature> <action> [options]
  odinn config self-improvement show [--state .odinn]
  odinn config self-improvement set [--enabled true|false] [--mode disabled|propose|auto] [--interval-ms <ms>] [--max-changes <count>] [--state .odinn]
  odinn auth import openclaw [--provider openai] [--profile <id-or-email>] [--source <path>] [--state .odinn]
  odinn import openclaw|hermes [--source <path>] [--auth-only|--skills-only] [--dry-run] [--state .odinn]
  odinn state backup --output <directory> [--state .odinn]
  odinn state restore --input <directory> --confirm [--state .odinn]
  odinn extension install --manifest <manifest.json> [--state .odinn]
  odinn extension list [--state .odinn]
  odinn extension enable --id <id> --grant <capability[,capability]> [--trust] [--allow-unsafe-sandbox] [--state .odinn]
  odinn extension disable --id <id> [--reason <text>] [--state .odinn]
  odinn extension rollback --id <id> [--state .odinn]
  odinn extension run --id <id> --input-json <json> [--capability <capability>] [--capability-token <token>] [--state .odinn]
  odinn config model default <provider:model> [--state .odinn]
  odinn config model list [--state .odinn]
  odinn status [--state .odinn]
  odinn audit [--state .odinn]
  odinn audit verify [--allow-unsigned] [--state .odinn]
  odinn audit rotate-key [--state .odinn]
  odinn tui [--state .odinn] [--watch]
  odinn run --tool <tool> [--input-json <json>] [--input-file <json-file>] [--state .odinn]
  odinn run show <run-id> [--state .odinn]
  odinn run events <run-id> [--state .odinn]
  odinn run verify <run-id> [--state .odinn]
  odinn proof run <run-id> --contract <contract.json|yml> [--state .odinn]
  odinn proof show <run-id> [--state .odinn]
  odinn proof contract validate <contract.json|yml>
  odinn policy validate <policy.json|yml>
  odinn policy test <policy.json|yml> --tool <tool> --input-json <json> [--state .odinn]
  odinn capability issue --run <run-id> --step <step-id> --tool <tool> [--scope a,b] [--constraints <json>] [--expires-ms <ms>] [--max-uses <count>] [--show-token] [--state .odinn]
  odinn capability use --token <token> --run <run-id> --tool <tool> [--resource <json>] [--state .odinn]
  odinn capability list <run-id> [--state .odinn]
  odinn capability revoke <capability-id> [--state .odinn]
  odinn timeline <run-id> [--state .odinn]
  odinn checkpoint create <run-id> --path <path[,path]> [--label <label>] [--state .odinn]
  odinn rewind <snapshot-id> [--apply] [--state .odinn]
  odinn branch <run-id> --from <step-id> --plan-file <plan.json> [--state .odinn]
  odinn compare <group-id> [--state .odinn]
  odinn capsule export <run-id> --output <run.odinn> [--state .odinn]
  odinn capsule inspect|verify <run.odinn> [--state .odinn]
  odinn capsule replay <run.odinn> [--mode verification-only|tool-mocked|full] [--workspace <directory>] [--approve-external] [--state .odinn]
  odinn counterfactual run --source-run <run-id> --from <step-id> --plan-file <plan.json> [--plan-file <plan.json>] [--execute] [--state .odinn]
  odinn counterfactual compare <group-id> [--state .odinn]
  odinn counterfactual select <group-id> --run <run-id> [--apply] [--state .odinn]
  odinn routing observe --run <run-id> --provider <id> --model <id> --task-class <class> --verified true|false [--partial true|false] [--duration-ms <ms>] [--cost-usd <amount>] [--tool-calls <count>] [--tool-errors <count>] [--retries <count>] [--policy-violations <count>] [--rolled-back] [--state .odinn]
  odinn routing stats [--task-class <class>] [--state .odinn]
  odinn routing choose --task-class <class> [--state .odinn]
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
  odinn improve learn [--limit 1000] [--state .odinn]
  odinn improve decide --improvement <id> --decision approved|rejected|applied [--note <text>] [--state .odinn]
  odinn improve rollback --improvement <id> [--state .odinn]
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

function option(args: any, name: any, fallback: any = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasFlag(args: any, name: any) {
  return args.includes(name);
}

function invocationRoot() {
  return resolve(process.env.INIT_CWD ?? process.cwd());
}

function resolveInvocationPath(path: any) {
  return resolve(invocationRoot(), path);
}

function stateDir(args: any) {
  const explicit = option(args, "--state", process.env.ODINN_STATE_DIR ?? "");
  if (explicit) return resolveInvocationPath(explicit);
  const projectState = resolveInvocationPath(".odinn");
  if (existsSync(join(projectState, "config.json"))) return projectState;
  return resolve(homedir(), ".odinn");
}

async function init(args: any) {
  const state = stateDir(args);
  const configPath = await ensureConfig(state);
  await printJson({ ok: true, state, configPath });
}

async function onboard(args: any) {
  const state = stateDir(args);
  await recoverInterruptedOnboardingTransactions(state);
  const provider = option(args, "--provider", "");
  if (!provider && shouldRunGuidedOnboarding(args)) {
    await guidedOnboard(args, state, join(state, "config.json"));
    return;
  }
  const configPath = await ensureConfig(state);
  if (hasFlag(args, "--verify")) {
    const result = await verifyConfiguredModel(state, await readConfig(state));
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
      return;
    }
    console.log(result.message);
    return;
  }
  if (provider) {
    await addProvider(state, args, provider);
    const configured = normalizeModelConfig(await readConfig(state)).providers[provider];
    if (configured?.auth.mode === "oauth") await connectOAuth(state, provider, args);
    if (configured?.auth.mode === "device") await connectDeviceAuth(state, provider, args);
    if (configured?.auth.mode === "cli") await connectCliAuth(configured);
  }
  const current = await status(args);
  const store = createAuditStore(join(state, current.auditLog ?? "audit.jsonl"));
  const runs = await store.readRuns();
  console.log(renderOnboardingSummary({ ...current, configPath, runs }));
}

function shouldRunGuidedOnboarding(args: any) {
  if (hasFlag(args, "--non-interactive")) return false;
  return hasFlag(args, "--interactive") || Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function guidedOnboard(args: any, state: any, configPath: any) {
  const prompts = new TerminalPrompter();
  let draft: any;
  let startNow = false;
  try {
    prompts.intro("Ódinn Forge", "Your private AI workspace, configured one clear choice at a time.");
    const existing = await readExistingOnboardingConfig(configPath, prompts);
    if (existing === null && await fileExists(configPath)) return;
    const discovery = await discoverOnboardingSources(args);

    if (existing && Object.keys(existing.providers ?? {}).length > 0) {
      while (true) {
        const current = await status(withStateArgs(args, state));
        const runtime = await probeGatewayForState(state, {
          host: option(args, "--host", "127.0.0.1"),
          port: Number.parseInt(option(args, "--port", "18790"), 10)
        });
        prompts.note(renderCurrentSetup({ ...current, runtime }), "Current setup");
        const action = await prompts.select({
          message: "What would you like to do?",
          options: [
            { value: "open", label: "Open Ódinn", hint: runtime.state === "healthy" ? "Already running" : "Start the local workspace" },
            { value: "repair", label: "Repair connection", hint: "Run a real AI response test and fix failures" },
            { value: "ai", label: "Change AI or model" },
            { value: "access", label: "Review capabilities", hint: "See exactly what Ódinn may access" },
            { value: "details", label: "Advanced settings", hint: "Paths, providers, and runtime details" },
            { value: "reset", label: "Start setup over", hint: "Creates a backup first; chats and workspace files stay" },
            { value: "exit", label: "Exit without changes" }
          ],
          initialValue: "open",
          defaultValue: "open"
        });

        if (action === "exit") {
          prompts.outro("No changes made.");
          return;
        }
        if (action === "details") {
          const store = createAuditStore(join(state, current.auditLog ?? "audit.jsonl"));
          prompts.note(renderOnboardingDetails({ ...current, configPath, runs: await store.readRuns() }), "Technical details");
          continue;
        }
        if (action === "open") {
          startNow = await openOrStartExisting(prompts, args, state, runtime);
          return;
        }
        if (action === "repair") {
          const repaired = await repairConnection(prompts, state, existing);
          if (repaired === "open") {
            startNow = await openOrStartExisting(prompts, args, state);
            return;
          }
          if (repaired === "change") {
            draft = await createPreparedDraft(state);
            const changed = await guidedProviderSetup(prompts, draft.draftState, args, current, discovery);
            if (!changed) { await discardOnboardingDraft(draft); draft = undefined; continue; }
            const committed = await reviewVerifyAndCommit(prompts, draft, state, true);
            draft = undefined;
            if (!committed) continue;
            startNow = await chooseFinishAction(prompts, args, state);
            return;
          }
          continue;
        }
        if (action === "ai" || action === "access") {
          draft = await createPreparedDraft(state);
          const draftCurrent = await status(withStateArgs(args, draft.draftState));
          const changed = action === "ai"
            ? await guidedProviderSetup(prompts, draft.draftState, args, draftCurrent, discovery)
            : await guidedAccessSetup(prompts, draft.draftState, draftCurrent.policy ?? existing.policy);
          if (!changed) { await discardOnboardingDraft(draft); draft = undefined; continue; }
          const committed = await reviewVerifyAndCommit(prompts, draft, state, action === "ai");
          draft = undefined;
          if (!committed) continue;
          startNow = await chooseFinishAction(prompts, args, state);
          return;
        }
        if (action === "reset") {
          const confirmed = await prompts.confirm({ message: "Back up the current setup and start again?", initialValue: false });
          if (!confirmed) continue;
          draft = await createPreparedDraft(state, true);
          const configured = await runFreshSetup(prompts, draft.draftState, args, discovery, "guided");
          if (!configured) { await discardOnboardingDraft(draft); draft = undefined; continue; }
          const committed = await reviewVerifyAndCommit(prompts, draft, state, true);
          draft = undefined;
          if (!committed) continue;
          startNow = await chooseFinishAction(prompts, args, state);
          return;
        }
      }
    }

    prompts.note(
      "Ódinn can read files, browse the public web, and use connected services when you allow it.\nYou remain in control, and risky browser actions require approval by default.",
      "Before we begin"
    );
    const accepted = await prompts.confirm({ message: "Continue with setup?", initialValue: true });
    if (!accepted) {
      prompts.outro("Setup cancelled. Nothing was changed.");
      return;
    }
    const mode = await selectFreshSetupMode(prompts, discovery);
    if (mode === "cancel") {
      prompts.outro("Setup cancelled. Nothing was changed.");
      return;
    }
    draft = await createPreparedDraft(state, mode === "blank");
    const configured = await runFreshSetup(prompts, draft.draftState, args, discovery, mode);
    if (!configured) {
      prompts.outro("Setup paused. Nothing was changed.");
      return;
    }
    const draftConfig = await readConfig(draft.draftState);
    const committed = await reviewVerifyAndCommit(prompts, draft, state, Boolean(draftConfig.defaultModel));
    draft = undefined;
    if (!committed) return;
    startNow = await chooseFinishAction(prompts, args, state);
  } catch (error: any) {
    if (isPromptCancelled(error)) {
      prompts.outro("Setup cancelled. Nothing was changed.");
      return;
    }
    throw error;
  } finally {
    if (draft) await discardOnboardingDraft(draft);
    prompts.close();
    if (startNow) await startGateway(withStateArgs(args, state));
  }
}

async function guidedProviderSetup(prompts: any, state: any, args: any, current: any = undefined, discovery: any = {}) {
  const currentProvider = current?.providers?.find((entry: any) => current.defaultModel?.startsWith(`${entry.name}:`)) ?? current?.providers?.[0];
  const options: any[] = [];
  if (currentProvider) options.push({
    value: "keep",
    label: `Keep ${friendlyProviderName(currentProvider.name)}`,
    hint: `Current model: ${friendlyModelName(current.defaultModel)}`
  });
  if (discovery.openclaw?.profiles?.length) options.push({
    value: "openclaw",
    label: "Use my OpenClaw ChatGPT sign-in",
    hint: `${discovery.openclaw.profiles.length} account${discovery.openclaw.profiles.length === 1 ? "" : "s"} found`
  });
  if (discovery.hermes) options.push({ value: "hermes", label: "Use my Hermes ChatGPT sign-in", hint: "Existing OAuth credentials found" });
  options.push(
    { value: "openai", label: "Sign in with ChatGPT", hint: "Opens your browser; Ódinn never sees your password" },
    { value: "ollama", label: "Use a model on this computer", hint: "Requires Ollama to be running" },
    { value: "more", label: "More AI providers", hint: "OpenRouter, Groq, Mistral, Copilot, and others" },
    { value: "back", label: currentProvider ? "Back" : "Cancel" }
  );
  const selected = await prompts.select({
    message: "Choose the AI behind Ódinn",
    options,
    initialValue: currentProvider ? "keep" : discovery.openclaw?.profiles?.length ? "openclaw" : "openai",
    defaultValue: currentProvider ? "keep" : discovery.openclaw?.profiles?.length ? "openclaw" : "openai"
  });
  if (selected === "back") return false;
  if (selected === "keep") return selectProviderModel(prompts, state, currentProvider.name);
  if (selected === "openclaw") {
    await importOpenClawProfileForOnboarding(prompts, state, discovery.openclaw);
    return selectProviderModel(prompts, state, "openai");
  }
  if (selected === "hermes") {
    await importFrameworkAuth("hermes", discovery.hermes.root, state, ["--keep-default"], false);
    return selectProviderModel(prompts, state, "openai");
  }
  if (selected === "openai") {
    prompts.note("Your browser will open for ChatGPT sign-in. Your password is handled by OpenAI, not Ódinn.");
    await addProvider(state, ["--auth", "oauth"], "openai");
    await connectOAuth(state, "openai", [...args, "--guided"]);
    return selectProviderModel(prompts, state, "openai");
  }
  if (selected === "ollama") {
    const progress = prompts.progress("Looking for local Ollama models…");
    const models = await discoverOllamaModels();
    if (!models.length) {
      progress.fail("Ollama is not ready.");
      prompts.note("Start Ollama and install at least one model, then choose this option again.", "Local model not found");
      return false;
    }
    progress.succeed(`Found ${models.length} local model${models.length === 1 ? "" : "s"}.`);
    const model = await prompts.select({
      message: "Which local model should Ódinn use?",
      options: models.map((name: any) => ({ value: name, label: name })),
      initialValue: models[0],
      defaultValue: models[0]
    });
    await addProvider(state, ["--model", model], "ollama");
    await selectProviderDefault(state, "ollama", model);
    return true;
  }
  return guidedAdvancedProviderSetup(prompts, state, args);
}

async function guidedAccessSetup(prompts: any, state: any, currentPolicy: any = undefined) {
  const config = await readConfig(state);
  const before = currentPolicy ?? config.policy;
  const currentId = identifyAccessProfile(before);
  const options = [
    { value: "keep", label: `Keep current — ${accessProfileLabel(currentId)}`, hint: currentId === "custom" ? "No capabilities will be added or removed" : undefined },
    ...ACCESS_PROFILES.map((profile: any) => ({ value: profile.id, label: profile.label, hint: profile.hint })),
    { value: "back", label: "Back" }
  ];
  const choice = await prompts.select({
    message: "What should Ódinn be allowed to access?",
    options,
    initialValue: "keep",
    defaultValue: "keep"
  });
  if (choice === "back") return false;
  if (choice === "keep") return true;
  const nextPolicy = applyAccessProfile(before, choice);
  const delta = capabilityDelta(before, nextPolicy);
  const changes = [
    delta.added.length ? `Adds: ${delta.added.join(", ")}` : "Adds: nothing",
    delta.removed.length ? `Removes: ${delta.removed.join(", ")}` : "Removes: nothing"
  ].join("\n");
  prompts.note(changes, "Capability changes");
  if (!await prompts.confirm({ message: "Apply these capability changes?", initialValue: false })) return false;
  config.policy = nextPolicy;
  await saveConfig(state, config);
  return true;
}

async function readExistingOnboardingConfig(configPath: any, prompts: any) {
  if (!await fileExists(configPath)) return undefined;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("configuration must be a JSON object");
    if (config.version !== 1) throw new Error(`unsupported configuration version: ${config.version ?? "missing"}`);
    createDefaultPolicy(config.policy);
    normalizeModelConfig(config);
    return config;
  } catch (error: any) {
    prompts.note(
      `${error.message}\n\nÓdinn left the file untouched. Run ${odinnCommand()} doctor after correcting or restoring the configuration.`,
      "This setup needs repair"
    );
    process.exitCode = 1;
    return null;
  }
}

async function discoverOnboardingSources(args: any) {
  const discovery: any = {};
  try {
    const source = await readOpenClawAuthSource(args.filter((value: any) => value !== "--interactive"));
    const profiles = listUsableOpenClawProfiles(source.profiles, "openai");
    if (profiles.length) discovery.openclaw = { ...source, profiles };
  } catch {
    // Detection is optional. Explicit import commands still surface source errors.
  }
  try {
    const root = process.env.HERMES_HOME ? resolve(process.env.HERMES_HOME) : join(homedir(), ".hermes");
    const source = await readFrameworkAuth("hermes", root);
    const tokens = source.value?.providers?.["openai-codex"]?.tokens;
    if (tokens?.access_token || tokens?.refresh_token) discovery.hermes = { root, source: source.path };
  } catch {
    // Hermes is optional.
  }
  return discovery;
}

function listUsableOpenClawProfiles(profiles: any, providerName: any) {
  return Object.entries(profiles ?? {})
    .map(([id, profile]: any) => ({ id, ...(profile ?? {}) }))
    .filter((profile: any) => (profile.provider ?? profile.id.split(":", 1)[0]) === providerName)
    .filter((profile: any) => profile.type === "oauth" && (profile.access || profile.refresh));
}

async function selectFreshSetupMode(prompts: any, discovery: any) {
  const options: any[] = [
    { value: "quick", label: "Quick setup", hint: "Recommended — connect an AI and use safe everyday capabilities" },
    { value: "guided", label: "Guided setup", hint: "Review the AI, model, and capabilities yourself" },
    { value: "blank", label: "Blank slate", hint: "Chat-only permissions and no AI connection yet" }
  ];
  if (discovery.openclaw) options.push({ value: "openclaw", label: "Import my OpenClaw sign-in", hint: "Copies credentials; OpenClaw stays untouched" });
  if (discovery.hermes) options.push({ value: "hermes", label: "Import my Hermes sign-in", hint: "Copies credentials; Hermes stays untouched" });
  options.push({ value: "cancel", label: "Cancel" });
  const mode = await prompts.select({
    message: "How would you like to set up Ódinn?",
    options,
    initialValue: discovery.openclaw ? "openclaw" : "quick",
    defaultValue: discovery.openclaw ? "openclaw" : "quick"
  });
  return mode;
}

async function runFreshSetup(prompts: any, state: any, args: any, discovery: any, mode: any) {
  if (mode === "blank") {
    const config = await readConfig(state);
    config.policy = applyAccessProfile(config.policy, "chat-only");
    await saveConfig(state, config);
    return true;
  }
  if (mode === "openclaw") {
    await importOpenClawProfileForOnboarding(prompts, state, discovery.openclaw);
    await selectProviderModel(prompts, state, "openai");
  } else if (mode === "hermes") {
    await importFrameworkAuth("hermes", discovery.hermes.root, state, ["--keep-default"], false);
    await selectProviderModel(prompts, state, "openai");
  } else {
    const connected = await guidedProviderSetup(prompts, state, args, undefined, discovery);
    if (!connected) return false;
  }
  if (mode === "quick") {
    const config = await readConfig(state);
    config.policy = applyAccessProfile(config.policy, "balanced");
    await saveConfig(state, config);
    return true;
  }
  return guidedAccessSetup(prompts, state, (await readConfig(state)).policy);
}

async function createPreparedDraft(state: any, reset = false) {
  const draft = await createOnboardingDraft(state);
  if (reset) {
    await rm(join(draft.draftState, "oauth"), { recursive: true, force: true });
    await writeFile(join(draft.draftState, ".remove-oauth"), "confirmed\n", { mode: 0o600 });
    await saveConfig(draft.draftState, initialConfig());
  } else {
    await ensureConfig(draft.draftState);
  }
  return draft;
}

async function importOpenClawProfileForOnboarding(prompts: any, state: any, source: any) {
  if (!source?.profiles?.length) throw new Error("No usable OpenClaw ChatGPT sign-in was found");
  const profile = source.profiles.length === 1
    ? source.profiles[0]
    : await prompts.select({
        message: "Which OpenClaw account should Ódinn use?",
        options: source.profiles.map((entry: any) => ({
          value: entry,
          label: entry.email || entry.id,
          hint: entry.email ? entry.id : undefined
        })),
        initialValue: source.profiles[0],
        defaultValue: source.profiles[0]
      });
  await addProvider(state, ["--auth", "oauth"], "openai");
  const config = await readConfig(state);
  const provider = normalizeModelConfig(config).providers.openai;
  await saveOAuthToken(provider, state, {
    access_token: profile.access,
    refresh_token: profile.refresh,
    expires_at: profile.expires,
    ...(profile.tokenEndpoint ? { tokenEndpoint: profile.tokenEndpoint } : {})
  });
  prompts.note(`Found ${profile.email || profile.id}. The original OpenClaw credentials were not changed.`, "Sign-in imported");
}

async function selectProviderModel(prompts: any, state: any, providerName: any) {
  const config = await readConfig(state);
  const provider = normalizeModelConfig(config).providers[providerName];
  if (!provider?.models?.length) throw new Error(`${friendlyProviderName(providerName)} has no configured models`);
  const current = config.defaultModel?.startsWith(`${providerName}:`)
    ? config.defaultModel.slice(providerName.length + 1)
    : provider.models[0];
  const model = await prompts.select({
    message: `Which ${friendlyProviderName(providerName)} model should be the default?`,
    options: provider.models.map((name: any, index: any) => ({
      value: name,
      label: name,
      hint: index === 0 ? "Recommended for this connection" : undefined
    })),
    initialValue: provider.models.includes(current) ? current : provider.models[0],
    defaultValue: provider.models.includes(current) ? current : provider.models[0]
  });
  await selectProviderDefault(state, providerName, model);
  return true;
}

async function guidedAdvancedProviderSetup(prompts: any, state: any, args: any) {
  const catalog: any[] = listProviderPresets().filter((entry: any) => !["openai", "ollama"].includes(entry.name));
  const provider = await prompts.select({
    message: "Choose another AI provider",
    options: [
      ...catalog.map((entry: any) => ({ value: entry, label: friendlyProviderName(entry.name), hint: entry.auth })),
      { value: null, label: "Back" }
    ],
    defaultValue: null
  });
  if (!provider) return false;
  let authMode = provider.auth.includes("device") ? "device" : provider.auth.includes("cli") ? "cli" : "api-key";
  if (provider.auth.includes("oauth") && !provider.auth.startsWith("device") && !provider.auth.startsWith("cli")) {
    authMode = await prompts.select({
      message: `How should ${friendlyProviderName(provider.name)} connect?`,
      options: [
        { value: "oauth", label: "Sign in with a browser" },
        { value: "api-key", label: "Use an existing API key environment variable", hint: provider.apiKeyEnv || "Provider-specific variable" },
        { value: "back", label: "Back" }
      ],
      initialValue: "oauth",
      defaultValue: "oauth"
    });
    if (authMode === "back") return false;
  }
  if (authMode === "api-key" && provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
    prompts.note(
      `Set ${provider.apiKeyEnv} in the environment, then run onboarding again. Ódinn will not store an API key in config.json.`,
      "API key required"
    );
    return false;
  }
  await addProvider(state, ["--auth", authMode], provider.name);
  if (authMode === "oauth") await connectOAuth(state, provider.name, [...args, "--guided"]);
  if (authMode === "device") await connectDeviceAuth(state, provider.name, args);
  if (authMode === "cli") await connectCliAuth(normalizeModelConfig(await readConfig(state)).providers[provider.name]);
  return selectProviderModel(prompts, state, provider.name);
}

async function reviewVerifyAndCommit(prompts: any, draft: any, targetState: any, shouldVerify: any) {
  const config = await readConfig(draft.draftState);
  const providerName = String(config.defaultModel ?? "").split(":", 1)[0];
  prompts.note([
    `AI: ${config.defaultModel ? `${friendlyProviderName(providerName)} · ${friendlyModelName(config.defaultModel)}` : "Not connected yet"}`,
    `Access: ${accessProfileLabel(identifyAccessProfile(config.policy))}`,
    `Workspace: ${invocationRoot()}`
  ].join("\n"), "Review your setup");

  if (shouldVerify) {
    while (true) {
      const progress = prompts.progress("Testing a real AI response…");
      const verification = await verifyConfiguredModel(draft.draftState, config);
      if (verification.ok) {
        progress.succeed(verification.message);
        break;
      }
      progress.fail(verification.message);
      prompts.note("detail" in verification ? verification.detail : verification.message, "Technical detail");
      const next = await prompts.select({
        message: "The connection is not ready. What next?",
        options: [
          { value: "retry", label: "Try the connection test again" },
          { value: "back", label: "Go back without applying changes" }
        ],
        initialValue: "retry",
        defaultValue: "retry"
      });
      if (next === "back") return false;
    }
  }

  if (!await prompts.confirm({ message: "Apply this setup?", initialValue: true })) return false;
  const progress = prompts.progress("Saving your setup safely…");
  const committed = await commitOnboardingDraft(draft);
  await discardOnboardingDraft(draft);
  progress.succeed("Setup saved.");
  if (committed.backupPath) prompts.note("Your previous setup was backed up and can be restored if needed.");
  prompts.outro("Ódinn is ready.");
  return true;
}

async function repairConnection(prompts: any, state: any, config: any) {
  while (true) {
    const progress = prompts.progress("Testing a real AI response…");
    const result = await verifyConfiguredModel(state, config);
    if (result.ok) {
      progress.succeed(result.message);
      const open = await prompts.confirm({ message: "Open Ódinn now?", initialValue: true });
      return open ? "open" : "back";
    }
    progress.fail(result.message);
    prompts.note("detail" in result ? result.detail : result.message, "Technical detail");
    const next = await prompts.select({
      message: "How should we repair it?",
      options: [
        { value: "retry", label: "Try again" },
        { value: "change", label: "Change AI or model" },
        { value: "back", label: "Back" }
      ],
      initialValue: "change",
      defaultValue: "change"
    });
    if (next !== "retry") return next;
  }
}

async function chooseFinishAction(prompts: any, args: any, state: any) {
  const runtime = await probeGatewayForState(state, {
    host: option(args, "--host", "127.0.0.1"),
    port: Number.parseInt(option(args, "--port", "18790"), 10)
  });
  const decision = decideGatewayAction(runtime);
  const options: any[] = [];
  if (decision.action === "open") options.push({ value: "open", label: "Open Ódinn in my browser", hint: "The local workspace is already running" });
  if (decision.action === "start") options.push({ value: "start", label: "Start Ódinn and open my browser" });
  options.push({ value: "later", label: "I’ll open it later", hint: `${odinnCommand()} start` });
  if (decision.action === "blocked") prompts.note(decision.detail, "Local workspace needs attention");
  const action = await prompts.select({
    message: "What would you like to do next?",
    options,
    initialValue: options[0].value,
    defaultValue: options[0].value
  });
  if (action === "open") {
    const opened = await openBrowser(runtime.url);
    prompts.note(opened.detail);
  }
  return action === "start";
}

async function openOrStartExisting(prompts: any, args: any, state: any, priorProbe: any = undefined) {
  const probe = priorProbe ?? await probeGatewayForState(state, {
    host: option(args, "--host", "127.0.0.1"),
    port: Number.parseInt(option(args, "--port", "18790"), 10)
  });
  const decision = decideGatewayAction(probe);
  if (decision.action === "open") {
    const opened = await openBrowser(probe.url);
    prompts.note(opened.detail);
    return false;
  }
  if (decision.action === "start") return prompts.confirm({ message: "Ódinn is stopped. Start it now?", initialValue: true });
  prompts.note(decision.detail, "Ódinn was not started");
  return false;
}

function withStateArgs(args: any, state: any) {
  const output = [...args];
  const index = output.indexOf("--state");
  if (index >= 0) output.splice(index, 2, "--state", state);
  else output.push("--state", state);
  return output;
}

function initialConfig() {
  return {
    version: 1,
    policy: createDefaultPolicy(),
    auditLog: "audit.jsonl",
    providers: {},
    defaultModel: "",
    experimental: normalizeExperimentalFlags(),
    selfImprovement: normalizeSelfImprovementConfig()
  };
}

async function fileExists(path: any) {
  try {
    await access(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function discoverOllamaModels() {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return [];
    const payload: any = await response.json();
    return (payload.models ?? []).map((model: any) => String(model.name ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function selectProviderDefault(state: any, providerName: any, requestedModel: any = "") {
  const config = await readConfig(state);
  const provider = normalizeModelConfig(config).providers[providerName];
  const model = requestedModel || provider?.models?.[0];
  if (model) config.defaultModel = `${providerName}:${model}`;
  await saveConfig(state, config);
}

function odinnCommand() {
  return process.env.npm_lifecycle_event === "odinn" ? "pnpm odinn" : "odinn";
}

async function startGateway(args: any) {
  const stateDir = stateDirForStart(args);
  await recoverInterruptedOnboardingTransactions(stateDir);
  const host = option(args, "--host", "127.0.0.1");
  const port = Number.parseInt(option(args, "--port", "18790"), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
  if (port > 0) {
    const existing = await probeGatewayForState(stateDir, { host, port });
    const decision = decideGatewayAction(existing);
    if (decision.action === "open") {
      console.log(`Ódinn Forge is already running at ${existing.url}`);
      if (!hasFlag(args, "--no-open")) console.log((await openBrowser(existing.url)).detail);
      return;
    }
    if (decision.action === "blocked") throw new Error(decision.detail);
  }
  const { createGatewayServer } = await import("@odinn/gateway");
  const server: any = await createGatewayServer({ stateDir, workspaceRoot: invocationRoot() });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  const actualPort = (server.address() as any).port;
  const url = `http://${host === "::1" ? "[::1]" : host}:${actualPort}/`;
  console.log(`Ódinn Forge is running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (!hasFlag(args, "--no-open")) console.log((await openBrowser(url)).detail);
  const shutdown = () => server.close((error: any) => {
    if (error) console.error(error.message);
    process.exitCode = error ? 1 : 0;
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function stateDirForStart(args: any) {
  return stateDir(args);
}

async function probeGatewayForState(state: any, options: any) {
  const probe: any = await probeGateway(options);
  if (probe.state !== "healthy" || resolve(probe.health.stateDir) === resolve(state)) return probe;
  return {
    state: "occupied",
    reason: "unhealthy-odinn",
    host: probe.host,
    port: probe.port,
    url: probe.url,
    statusCode: probe.statusCode,
    detail: `Another Ódinn workspace is already using ${probe.url}. Stop it or choose another port before starting this workspace.`
  };
}

async function status(args: any) {
  const state = stateDir(args);
  await recoverInterruptedOnboardingTransactions(state);
  const config = await readConfig(state);
  const models = listConfiguredModels(normalizeModelConfig(config));
  return {
    ok: true,
    state,
    workspaceRoot: invocationRoot(),
    auditLog: config.auditLog ?? "audit.jsonl",
    tools: Array.from(createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config }).keys()),
    allowedCapabilities: config.policy.allowedCapabilities,
    policy: createDefaultPolicy(config.policy),
    security: createDefaultPolicy(config.policy).security,
    experimental: {
      flags: normalizeExperimentalFlags(config.experimental),
      warning: experimentalFeatureWarning(config.experimental)
    },
    defaultModel: normalizeModelConfig(config).defaultModel,
    models,
    providers: await summarizeProviders(config, state)
  };
}

async function verifyConfiguredModel(state: any, config: any) {
  const normalized = normalizeModelConfig(config);
  if (!normalized.defaultModel) {
    return { ok: false, kind: "missing-model", message: "No AI model is selected. Choose an AI connection first." };
  }
  const auditStore = createAuditStore(join(state, "onboarding-verification.jsonl"));
  const policy = createDefaultPolicy({
    ...config.policy,
    allowedCapabilities: Array.from(new Set([...(config.policy?.allowedCapabilities ?? []), "model.chat"]))
  });
  try {
    const result: any = await runTask({
      task: {
        id: `onboarding_verify_${randomUUID()}`,
        tool: "model.chat",
        actor: "onboarding",
        reason: "verify the configured AI connection",
        input: {
          model: normalized.defaultModel,
          retries: 0,
          timeoutMs: 20_000,
          messages: [{ role: "user", content: "Reply with exactly ODINN_CAPABILITY_OK." }]
        }
      },
      auditStore,
      policy,
      registry: createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config, auditStore })
    });
    const content = String(result?.output?.content ?? "").trim();
    if (!content) throw new Error("AI provider returned an empty response");
    return {
      ok: true,
      kind: "ready",
      message: `AI connection verified with ${friendlyModelName(normalized.defaultModel)}.`,
      response: content
    };
  } catch (error: any) {
    const detail = String(error?.message ?? error);
    const classified = classifyConnectionFailure(detail);
    return { ok: false, ...classified, detail };
  }
}

function normalizeExperimentalHomeFeature(value: any) {
  const aliases: Record<string, string> = {
    proof: "proof",
    sentinel: "sentinel",
    policy: "sentinel",
    capability: "capabilities",
    capabilities: "capabilities",
    "capability-token": "capabilities",
    "capability-tokens": "capabilities",
    rewind: "rewind",
    checkpoint: "rewind",
    capsule: "capsules",
    capsules: "capsules",
    counterfactual: "counterfactual",
    counterfactuals: "counterfactual",
    darwin: "darwin",
    routing: "darwin",
    improve: "self-improvement",
    improvement: "self-improvement",
    "self-improvement": "self-improvement"
  };
  return aliases[String(value ?? "").trim().toLowerCase()];
}

function experimentalHomeEntry(value: any) {
  const id = normalizeExperimentalHomeFeature(value);
  return EXPERIMENTAL_HOME.find((entry) => entry.id === id);
}

function experimentalFeatureStatus(entry: any, config: any) {
  const flags = normalizeExperimentalFlags(config.experimental);
  const selfImprovement = normalizeSelfImprovementConfig(config.selfImprovement);
  const selfManaged = entry.id === "self-improvement";
  return {
    id: entry.id,
    label: entry.label,
    enabled: selfManaged ? selfImprovement.enabled : (flags as any)[entry.id],
    ...(selfManaged ? { mode: selfImprovement.mode, settings: selfImprovement } : {}),
    configKey: entry.configKey,
    entrypoint: `odinn experimental ${entry.id}`,
    description: entry.description,
    inspectionActions: [...entry.safeActions],
    enabledActions: [...entry.activeActions],
    guard: selfManaged
      ? "proposal and review commands remain available; autonomous application requires enabled=true and mode=auto"
      : entry.id === "capabilities"
        ? `token issuance and consumption reject requests until ${entry.configKey}=true; list and revoke remain available for inspection and emergency cleanup`
        : `active runtime actions reject requests until ${entry.configKey}=true`
  };
}

async function experimentalStatus(args: any, requestedFeature: any = undefined, concise = false) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const selected = requestedFeature ? experimentalHomeEntry(requestedFeature) : undefined;
  if (requestedFeature && !selected) throw new Error(`unknown experimental feature: ${requestedFeature}`);
  const features = (selected ? [selected] : EXPERIMENTAL_HOME).map((entry) => experimentalFeatureStatus(entry, config));
  const visible = concise
    ? features.map(({ id, label, enabled, mode, configKey, entrypoint }: any) => ({ id, label, enabled, ...(mode ? { mode } : {}), configKey, entrypoint }))
    : features;
  return {
    ok: true,
    state,
    configPath: join(state, "config.json"),
    configured: existsSync(join(state, "config.json")),
    warning: experimentalFeatureWarning(config.experimental),
    disabledByDefault: true,
    features: visible
  };
}

function experimentalUsage(requestedFeature: any = undefined) {
  if (requestedFeature) {
    const entry = experimentalHomeEntry(requestedFeature);
    if (!entry) throw new Error(`unknown experimental feature: ${requestedFeature}`);
    console.log(`${entry.label} — ${entry.description}

Configuration:
  ${entry.configKey}

Inspection and preview:
  ${entry.safeActions.join("\n  ")}

Enabled operations:
  ${entry.activeActions.join("\n  ")}

Status:
  odinn experimental status ${entry.id} [--state .odinn]`);
    return;
  }
  console.log(`Ódinn experimental systems

All feature flags and autonomous self-improvement are disabled by default. Validation,
inspection, proposals, and dry-run previews stay separate from mutating operations.

Commands:
  odinn experimental list [--state .odinn]
  odinn experimental status [feature] [--state .odinn]
  odinn experimental enable|disable <feature> [--state .odinn]
  odinn experimental help <feature>
  odinn experimental <feature> <action> [options]

Systems:
${EXPERIMENTAL_HOME.map((entry) => `  ${entry.id.padEnd(17)} ${entry.label}`).join("\n")}

Use \`odinn experimental help <feature>\` for the real runtime actions behind a system.`);
}

async function setExperimentalFeatureFlag(state: any, config: any, feature: any, enabled: boolean) {
  if (!EXPERIMENTAL_FEATURES.includes(feature)) throw new Error(`unknown experimental feature: ${feature}`);
  config.experimental = { ...normalizeExperimentalFlags(config.experimental), [feature]: enabled };
  await saveConfig(state, config);
  console.error(experimentalFeatureWarning(config.experimental));
  const behaviorWarning = feature === "capabilities" && enabled
    ? "capability enforcement is now active: direct tool runs require a scoped token; use `odinn capability issue` before manual runs"
    : undefined;
  if (behaviorWarning) console.error(behaviorWarning);
  await printJson({ ok: true, feature, enabled, warning: experimentalFeatureWarning(config.experimental), ...(behaviorWarning ? { behaviorWarning } : {}) });
}

async function toggleExperimentalFeature(requestedFeature: any, enabled: boolean, args: any) {
  const feature = normalizeExperimentalHomeFeature(requestedFeature);
  if (!feature) throw new Error(`unknown experimental feature: ${requestedFeature}`);
  if (feature === "self-improvement") {
    const state = stateDir(args);
    const config = await readConfig(state);
    const current = normalizeSelfImprovementConfig(config.selfImprovement);
    const modeArgs = enabled && current.mode === "disabled" && !hasFlag(args, "--mode") ? ["--mode", "propose"] : [];
    await configCommand(["self-improvement", "set", "--enabled", String(enabled), ...modeArgs, ...args]);
    return;
  }
  const state = stateDir(args);
  const config = await readConfig(state);
  await setExperimentalFeatureFlag(state, config, feature, enabled);
}

async function dispatchExperimentalFeature(feature: any, args: any) {
  switch (feature) {
    case "proof": {
      await proof(args);
      return;
    }
    case "sentinel":
      await policyCommand(args[0] === "policy" ? args.slice(1) : args);
      return;
    case "capabilities":
      await capabilityCommand(args);
      return;
    case "rewind": {
      const [action, ...rest] = args;
      if (action === "checkpoint") { await rewindCommand("checkpoint", rest); return; }
      if (action === "restore" || action === "preview") { await rewindCommand("rewind", rest); return; }
      throw new Error("experimental rewind requires checkpoint create or restore");
    }
    case "capsules":
      await capsuleCommand(args);
      return;
    case "counterfactual":
      await counterfactualCommand(args);
      return;
    case "darwin":
      await routingCommand(args);
      return;
    case "self-improvement":
      if (args[0] === "set") { await configCommand(["self-improvement", "set", ...args.slice(1)]); return; }
      if (args[0] === "config") { await configCommand(["self-improvement", "show", ...args.slice(1)]); return; }
      await improve(args);
      return;
    default:
      throw new Error(`unknown experimental feature: ${feature}`);
  }
}

async function experimentalCommand(args: any) {
  const [subcommand, ...rest] = args;
  if (!subcommand || ["help", "--help", "-h"].includes(subcommand)) {
    experimentalUsage(subcommand === "help" ? rest[0] : undefined);
    return;
  }
  if (["list", "status", "show"].includes(subcommand)) {
    const requested = rest[0] && !String(rest[0]).startsWith("--") ? rest[0] : undefined;
    await printJson(await experimentalStatus(args, requested, subcommand === "list"));
    return;
  }
  if (subcommand === "enable" || subcommand === "disable") {
    if (!rest[0] || String(rest[0]).startsWith("--")) throw new Error(`experimental ${subcommand} requires a feature`);
    await toggleExperimentalFeature(rest[0], subcommand === "enable", rest.slice(1));
    return;
  }
  const feature = normalizeExperimentalHomeFeature(subcommand);
  if (!feature) throw new Error(`unknown experimental feature: ${subcommand}`);
  if (!rest[0] || ["help", "--help", "-h"].includes(rest[0])) {
    experimentalUsage(feature);
    return;
  }
  if (rest[0] === "status" || rest[0] === "show") {
    await printJson(await experimentalStatus(rest.slice(1), feature));
    return;
  }
  if (rest[0] === "enable" || rest[0] === "disable") {
    await toggleExperimentalFeature(feature, rest[0] === "enable", rest.slice(1));
    return;
  }
  await dispatchExperimentalFeature(feature, rest);
}

function classifyConnectionFailure(detail: any) {
  const message = String(detail ?? "");
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[^\n]*(?:token|credential)|authentication failed/i.test(message)) {
    return { kind: "authentication", message: "The AI provider reports: sign-in rejected. Reconnect the account and try again." };
  }
  if (/\b429\b|usage limit|quota|rate.?limit|too many requests/i.test(message)) {
    return { kind: "usage-limit", message: "AI connection failed: usage limit reached. Use another account or wait for the limit to reset." };
  }
  if (/timed?\s*out|timeout|abort/i.test(message)) {
    return { kind: "timeout", message: "The AI provider did not respond in time. Check the connection and try again." };
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network|offline|socket/i.test(message)) {
    return { kind: "offline", message: "The AI provider could not be reached. Start the local model or check the internet connection." };
  }
  if (/\b404\b|model[^\n]*(?:not found|unavailable|does not exist)|unknown model/i.test(message)) {
    return { kind: "model-unavailable", message: "That AI model is not available for this account. Choose another model and try again." };
  }
  return { kind: "provider-error", message: `The AI connection test failed: ${message || "unknown provider error"}` };
}

async function configCommand(args: any) {
  const [section, subcommand, ...rest] = args;
  if (!["provider", "model", "security", "experimental", "self-improvement"].includes(section)) {
    throw new Error("config requires provider, model, security, experimental, or self-improvement");
  }
  const state = stateDir(rest);
  const config = await readConfig(state);
  if (section === "self-improvement") {
    if (subcommand === "show" || !subcommand) { await printJson(normalizeSelfImprovementConfig(config.selfImprovement)); return; }
    if (subcommand !== "set") throw new Error("config self-improvement requires show or set");
    const current = normalizeSelfImprovementConfig(config.selfImprovement);
    const enabled = option(rest, "--enabled", "");
    const mode = option(rest, "--mode", current.mode);
    if (!["disabled", "propose", "auto"].includes(mode)) throw new Error("--mode requires disabled, propose, or auto");
    config.selfImprovement = normalizeSelfImprovementConfig({
      ...current,
      mode,
      ...(enabled === "" ? {} : { enabled: parseBoolean(enabled, "--enabled") }),
      intervalMs: Number.parseInt(option(rest, "--interval-ms", String(current.intervalMs)), 10),
      maxChangesPerCycle: Number.parseInt(option(rest, "--max-changes", String(current.maxChangesPerCycle)), 10)
    });
    await saveConfig(state, config);
    await printJson({ ok: true, selfImprovement: config.selfImprovement });
    return;
  }
  if (section === "security") {
    await configSecurityCommand(state, config, subcommand, rest);
    return;
  }
  if (section === "experimental") {
    if (subcommand === "show" || !subcommand) { await printJson(normalizeExperimentalFlags(config.experimental)); return; }
    if (subcommand !== "enable" && subcommand !== "disable") throw new Error("config experimental requires show, enable, or disable");
    const feature = rest[0];
    await setExperimentalFeatureFlag(state, config, feature, subcommand === "enable");
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
    if (!listConfiguredModels(normalized).some((entry: any) => entry.id === model)) throw new Error(`model is not configured: ${model}`);
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

async function configSecurityCommand(state: any, config: any, subcommand: any, args: any) {
  const policy = createDefaultPolicy(config.policy);
  if (subcommand === "show" || !subcommand) {
    await printJson(policy.security);
    return;
  }
  if (subcommand !== "set") throw new Error("config security requires show or set");
  const surface = option(args, "--surface", "");
  if (!['web', 'browser'].includes(surface)) throw new Error("config security set requires --surface web|browser");
  const current: any = { ...(policy.security as any)[surface] };
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

function kebabCase(value: any) {
  return value.replace(/[A-Z]/g, (letter: any) => `-${letter.toLowerCase()}`);
}

function parseBoolean(value: any, flag: any) {
  if (["true", "1", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error(`${flag} requires true or false`);
}

async function authCommand(args: any) {
  const [operation, source, ...rest] = args;
  if (operation !== "import" || source !== "openclaw") {
    throw new Error("auth requires import openclaw");
  }
  await importOpenClawOAuth(rest);
}

async function importOpenClawOAuth(args: any) {
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

async function readOpenClawAuthSource(args: any) {
  const explicit = option(args, "--source", "");
  const candidates = explicit
    ? [resolveInvocationPath(explicit)]
    : [
        process.env.OPENCLAW_AUTH_PROFILES,
        process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "agent", "openclaw-agent.sqlite") : "",
        process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "agent", "auth-profiles.json") : "",
        join(homedir(), ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite"),
        join(homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json")
      ].filter(Boolean).map((candidate: any) => resolve(candidate));
  const uniqueCandidates = Array.from(new Set(candidates));
  for (const path of uniqueCandidates) {
    try {
      await access(path);
      if (/\.sqlite(?:3)?$/i.test(path)) return readOpenClawSqliteSource(path);
      return readOpenClawJsonSource(path);
    } catch (error: any) {
      if (explicit || error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("OpenClaw auth store not found; pass --source <auth-profiles.json|openclaw-agent.sqlite>");
}

async function readOpenClawJsonSource(path: any) {
  const value = JSON.parse(await readFile(path, "utf8"));
  const auth = value?.profiles ? value : value?.auth;
  if (!auth?.profiles || typeof auth.profiles !== "object") throw new Error(`OpenClaw auth source has no profiles: ${path}`);
  return { path, profiles: auth.profiles, state: {} };
}

async function readOpenClawSqliteSource(path: any) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("this Node runtime cannot read OpenClaw SQLite auth; pass --source auth-profiles.json instead");
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const store: any = database.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary");
    if (!store?.store_json) throw new Error(`OpenClaw auth SQLite store has no primary profile store: ${path}`);
    const state: any = database.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?").get("primary");
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

function selectOpenClawProfile(profiles: any, state: any, providerName: any, requestedProfile: any) {
  const entries = Object.entries(profiles ?? {})
    .map(([id, profile]: any) => ({ id, ...(profile ?? {}) }))
    .filter((profile: any) => (profile.provider ?? profile.id.split(":", 1)[0]) === providerName)
    .filter((profile: any) => profile.type === "oauth" && (profile.access || profile.refresh));
  if (!entries.length) throw new Error(`OpenClaw has no usable OAuth profile for ${providerName}`);
  if (requestedProfile) {
    const match = entries.find((profile: any) => profile.id === requestedProfile || profile.email === requestedProfile || profile.id.endsWith(`:${requestedProfile}`));
    if (!match) throw new Error(`OpenClaw OAuth profile not found: ${requestedProfile}`);
    return match;
  }
  const preferred = [
    state?.lastGood?.[providerName],
    ...(Array.isArray(state?.order?.[providerName]) ? state.order[providerName] : []),
    `${providerName}:default`
  ].find((id: any) => entries.some((profile: any) => profile.id === id));
  if (preferred) return entries.find((profile: any) => profile.id === preferred);
  if (entries.length === 1) return entries[0];
  throw new Error(`OpenClaw has multiple ${providerName} OAuth profiles; pass --profile ${entries.map((profile: any) => profile.id).join(" or ")}`);
}

async function importCommand(args: any) {
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

async function importFrameworkAuth(framework: any, root: any, state: any, args: any, dryRun: any) {
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
    } catch (error: any) {
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

async function readFrameworkAuth(framework: any, root: any): Promise<any> {
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
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`OpenClaw auth store not found under ${root}`);
}

async function importFrameworkSkills(framework: any, root: any, state: any, dryRun: any) {
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
    directories: directories.map((directory: any) => directory.path),
    skillCount: copied.filter((file: any) => file.source.endsWith("/SKILL.md")).length,
    fileCount: copied.length
  };
}

async function listImportFiles(directory: any): Promise<any[]> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory()) return [];
  } catch (error: any) {
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

async function importFrameworkSupportFiles(framework: any, root: any, state: any, dryRun: any) {
  const candidates = framework === "hermes"
    ? ["SOUL.md", "memories/MEMORY.md", "memories/USER.md"]
    : ["workspace/SOUL.md", "workspace/USER.md", "workspace/AGENTS.md"];
  const copied = [];
  for (const relativePath of candidates) {
    const source = join(root, relativePath);
    try {
      const info = await lstat(source);
      if (!info.isFile()) continue;
    } catch (error: any) {
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

async function addProvider(state: any, args: any, name: any, existingConfig: any = undefined) {
  const config = existingConfig ?? await readConfig(state);
  const preset: any = (PROVIDER_PRESETS as any)[name] ?? { type: "openai-compatible", baseUrl: "", apiKeyEnv: "", models: [] };
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
  const provider: any = { type: preset.type, baseUrl, apiKeyEnv, models };
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
  config.policy.allowedCapabilities = Array.from(new Set([
    ...(config.policy.allowedCapabilities ?? []),
    "model.chat",
    "agent.run"
  ]));
  if (!config.defaultModel || !listConfiguredModels(normalizeModelConfig(config)).some((entry: any) => entry.id === config.defaultModel)) {
    config.defaultModel = `${name}:${models[0]}`;
  }
  await saveConfig(state, config);
}

async function summarizeProviders(config: any, state: any) {
  return Promise.all(Object.entries(config.providers ?? {}).map(async ([name, provider]: any) => ({
    name,
    type: provider.type ?? "openai-compatible",
    baseUrl: provider.baseUrl,
    authMode: provider.auth?.mode ?? "api-key",
    apiKeyEnv: provider.apiKeyEnv ?? "",
    models: provider.models ?? [],
    configured: ["oauth", "device"].includes(provider.auth?.mode)
      ? await oauthTokenExists(provider, state)
      : provider.auth?.mode === "cli"
        ? commandAvailable(process.env[provider.auth.commandEnv || "ODINN_ANTIGRAVITY_CLI"] || "agy")
      : !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv])
  })));
}

async function oauthTokenExists(provider: any, state: any) {
  try {
    const token = JSON.parse(await readFile(oauthTokenPath(provider, state), "utf8"));
    return Boolean(token.refreshToken || (token.accessToken && (!token.expiresAt || token.expiresAt > Date.now() + 60_000)));
  } catch {
    return false;
  }
}

function commandAvailable(command: any) {
  const executable = String(command ?? "").trim().split(/\s+/u, 1)[0];
  if (!executable) return false;
  if (executable.includes("/") || executable.includes("\\")) return existsSync(executable);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return (process.env.PATH ?? "").split(delimiter).some((directory) => {
    return extensions.some((extension) => existsSync(join(directory, `${executable}${extension}`)));
  });
}

async function connectOAuth(state: any, name: any, args: any) {
  const config = await readConfig(state);
  const provider = normalizeModelConfig(config).providers[name];
  if (!provider || provider.auth.mode !== "oauth") throw new Error(`OAuth provider not found: ${name}`);
  if (provider.auth.flow === "openrouter-pkce") {
    await connectOpenRouterOAuth(state, name, provider, args);
    return;
  }
  const configuredRedirect = provider.auth.redirectUri ? new URL(provider.auth.redirectUri) : null;
  const server = createServer();
  const callback = new Promise((resolveCallback: any, rejectCallback: any) => {
    server.on("request", (request: any, response: any) => {
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
        response.end("<h1>Odinn Forge connected</h1><p>You can close this tab.</p>");
        resolveCallback({ code });
      } catch (error: any) {
        rejectCallback(error);
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error.message);
      }
    });
  });
  const requestedPort = configuredRedirect?.port
    ? Number.parseInt(configuredRedirect.port, 10)
    : Number.parseInt(option(args, "--oauth-port", "0"), 10);
  await new Promise((resolveListen: any, rejectListen: any) => {
    server.once("error", rejectListen);
    server.listen(Number.isFinite(requestedPort) ? requestedPort : 0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address() as any;
  const redirectUri = provider.auth.redirectUri || `http://127.0.0.1:${port}/oauth/callback`;
  const authRequest = createOAuthAuthorizationRequest(provider, { redirectUri });
  const timeoutMs = Number.parseInt(option(args, "--oauth-timeout-ms", "120000"), 10);
  if (hasFlag(args, "--guided")) console.log("Waiting for sign-in to finish…");
  else console.log(`Open this URL to connect ${name}:\n\n${authRequest.authorizationUrl}\n`);
  if (!hasFlag(args, "--no-open")) openAuthorizationUrl(authRequest.authorizationUrl);
  try {
    const result = await withTimeout(callback, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000, "OAuth authorization timed out");
    const token = await exchangeOAuthCode(provider, {
      code: result.code,
      codeVerifier: authRequest.codeVerifier,
      redirectUri
    });
    const saved = await saveOAuthToken(provider, state, token);
    console.log(hasFlag(args, "--guided") ? "Sign-in complete." : `OAuth connected for ${name}. Token stored at ${saved.path}.`);
  } finally {
    await new Promise((resolveClose: any) => server.close(() => resolveClose()));
  }
}

async function connectOpenRouterOAuth(state: any, name: any, provider: any, args: any) {
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
  const callback = new Promise((resolveCallback: any, rejectCallback: any) => {
    server.on("request", (request: any, response: any) => {
      try {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${callbackPort}`);
        if (url.pathname !== callbackPath) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        if (url.searchParams.get("error")) throw new Error(url.searchParams.get("error_description") || url.searchParams.get("error") || "OAuth error");
        if (url.searchParams.get("state") !== stateValue) throw new Error("OpenRouter OAuth state did not match");
        const code = url.searchParams.get("code");
        if (!code) throw new Error("OpenRouter OAuth callback did not contain a code");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>Odinn Forge connected</h1><p>You can close this tab.</p>");
        resolveCallback(code);
      } catch (error: any) {
        rejectCallback(error);
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error.message);
      }
    });
  });
  await new Promise((resolveListen: any, rejectListen: any) => {
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
    await new Promise((resolveClose: any) => server.close(() => resolveClose()));
  }
}

async function connectDeviceAuth(state: any, name: any, args: any) {
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

async function connectGitHubCopilot(state: any, provider: any, args: any) {
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

async function pollGitHubDeviceToken(device: any, clientId: any, args: any) {
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

async function connectXaiDevice(state: any, provider: any, args: any) {
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

async function pollXaiDeviceToken(device: any, tokenEndpoint: any, clientId: any, args: any) {
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

async function connectCliAuth(provider: any) {
  const command = process.env[provider.auth.commandEnv || "ODINN_ANTIGRAVITY_CLI"] || "agy";
  console.log(`Starting ${command}. Complete sign-in in the CLI, then exit it to finish onboarding.`);
  await new Promise((resolveExit: any, rejectExit: any) => {
    const child = spawn(command, [], { stdio: "inherit" });
    child.once("error", rejectExit);
    child.once("exit", (code: any, signal: any) => code === 0 ? resolveExit() : rejectExit(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

async function readJsonResponse(response: any) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { error: raw.slice(0, 500) };
  }
}

function oauthErrorMessage(payload: any) {
  return payload?.error_description || payload?.message || payload?.error || "request failed";
}

function isTrustedXaiUrl(value: any) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"));
  } catch {
    return false;
  }
}

function oauthTimeout(args: any) {
  const timeout = Number.parseInt(option(args, "--oauth-timeout-ms", "300000"), 10);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 300000;
}

function delay(ms: any) {
  return new Promise((resolveDelay: any) => setTimeout(resolveDelay, ms));
}

function withTimeout(promise: any, timeoutMs: any, message: any) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_: any, reject: any) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function openAuthorizationUrl(url: any) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("OAuth authorization URL must use http or https");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const commandArgs = process.platform === "win32" ? ["/c", "start", "", parsed.href] : [parsed.href];
  // lgtm[js/command-line-injection] - shell execution is disabled and the URL is restricted to HTTP(S).
  const child = spawn(command, commandArgs, { detached: true, stdio: "ignore", shell: false });
  child.unref();
}

async function tui(args: any) {
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
    await new Promise((resolve: any) => setTimeout(resolve, delay));
  }
}

async function run(args: any) {
  if (["show", "events", "verify"].includes(args[0])) {
    await inspectRun(args);
    return;
  }
  const state = stateDir(args);
  const tool = option(args, "--tool");
  if (!tool) throw new Error("run requires --tool");
  const inputFile = option(args, "--input-file", "");
  const inputRaw = inputFile ? await readFile(resolveInvocationPath(inputFile), "utf8") : option(args, "--input-json", "{}");
  const input = JSON.parse(inputRaw);
  const config = await readConfig(state);
  const runLedger = createRunLedger({ stateDir: state, workspaceRoot: invocationRoot(), featureFlags: normalizeExperimentalFlags(config.experimental) });
  try {
    const auditStore = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
    const result: any = await runTask({
      task: { tool, input, actor: "cli" },
      auditStore,
      policy: createDefaultPolicy(config.policy),
      registry: createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config, auditStore }),
      runLedger
    });
    const contractPath = option(args, "--contract", "");
    if (contractPath) {
      const contract = parseStructuredDocument(await readFile(resolveInvocationPath(contractPath), "utf8"), contractPath);
      const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: invocationRoot(), featureFlags: normalizeExperimentalFlags(config.experimental) });
      try { result.proof = await runtime.proof.run(result.id, contract, { workspaceRoot: invocationRoot() }); }
      finally { runtime.ledger.close(); }
    }
    await printJson(result);
  } finally {
    runLedger.close();
  }
}

async function plan(args: any) {
  const state = stateDir(args);
  const file = option(args, "--file");
  if (!file) throw new Error("plan requires --file");
  const config = await readConfig(state);
  const runLedger = createRunLedger({ stateDir: state, workspaceRoot: invocationRoot(), featureFlags: normalizeExperimentalFlags(config.experimental) });
  try {
    const result = await runPlan({
      plan: JSON.parse(await readFile(resolveInvocationPath(file), "utf8")),
      auditStore: createAuditStore(join(state, config.auditLog ?? "audit.jsonl")),
      policy: createDefaultPolicy(config.policy),
      registry: createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config }),
      actor: "cli",
      runLedger
    });
    await printJson(result);
  } finally {
    runLedger.close();
  }
}

async function inspectRun(args: any) {
  const operation = args[0];
  const rest = args.slice(1);
  const runId = option(rest, "--run", rest.find((value: any) => !value.startsWith("--")));
  if (!runId) throw new Error(`run ${operation} requires <run-id>`);
  const state = stateDir(rest);
  const config = await readConfig(state);
  const ledger = createRunLedger({ stateDir: state, workspaceRoot: invocationRoot(), featureFlags: normalizeExperimentalFlags(config.experimental) });
  try {
    const run = ledger.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (operation === "events") await printJson(run.events);
    else if (operation === "verify") await printJson(ledger.verify(runId));
    else await printJson(run);
  } finally {
    ledger.close();
  }
}

async function memory(args: any) {
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

async function extensionCommand(args: any) {
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
      const state = stateDir(rest);
      const config = await readConfig(state);
      const runtime = createDifferentiatedRuntime({ stateDir: state, workspaceRoot: invocationRoot(), featureFlags: normalizeExperimentalFlags(config.experimental) });
      const auditStore = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
      const executor = new ExtensionExecutor(registry, { workspaceRoot: invocationRoot() });
      try {
        await printJson(await executor.invoke(id, input, {
          capability: option(rest, "--capability", ""),
          capabilityToken: option(rest, "--capability-token", ""),
          runtime: { runLedger: runtime.ledger, auditStore, policy: createDefaultPolicy(config.policy), workspaceRoot: invocationRoot(), actor: "cli" }
        }));
      } finally {
        runtime.ledger.close();
      }
      break;
    }
    default:
      throw new Error("extension requires subcommand: install, list, enable, disable, rollback, or run");
  }
}

async function stateCommand(args: any) {
  const [subcommand, ...rest] = args;
  const state = stateDir(rest);
  if (subcommand === "backup" || subcommand === "export") {
    const output = option(rest, "--output");
    if (!output) throw new Error("state backup requires --output <directory>");
    const destination = resolveInvocationPath(output);
    if (destination === state || destination.startsWith(`${state}/`) || destination.startsWith(`${state}\\`)) {
      throw new Error("state backup destination must not be inside the active state directory");
    }
    await validateStateBackupTree(state, { requireManifest: false });
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
    await validateStateBackupTree(source, { requireManifest: true });
    const parent = resolve(state, "..");
    const staging = join(parent, `.${state.split(/[\\/]/).pop()}-restore-${process.pid}-${Date.now()}`);
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    const configPath = join(staging, "config.json");
    try {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.json must contain an object");
      await validateStateBackupTree(staging, { requireManifest: true });
    } catch (error: any) { await rm(staging, { recursive: true, force: true }); throw new Error(`state restore source is invalid: ${error.message}`); }
    const currentBackup = `${state}.before-restore-${Date.now()}`;
    try {
      await rename(state, currentBackup);
      await rename(staging, state);
      await secureStateTree(state);
    } catch (error: any) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      try { await access(state); } catch { await rename(currentBackup, state).catch(() => undefined); }
      throw error;
    }
    await printJson({ ok: true, operation: "restore", source, destination: state, preRestoreBackup: currentBackup });
    return;
  }
  throw new Error("state requires subcommand: backup or restore");
}

async function validateStateBackupTree(root: string, { requireManifest }: { requireManifest: boolean }) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("state backup root must be a physical directory");
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`state backup contains a symbolic link: ${relative(root, path)}`);
      if (metadata.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!metadata.isFile()) throw new Error(`state backup contains an unsupported file type: ${relative(root, path)}`);
      if (metadata.nlink !== 1) throw new Error(`state backup contains a hard-linked file: ${relative(root, path)}`);
    }
  };
  await walk(root);
  if (requireManifest) {
    const manifest = JSON.parse(await readFile(join(root, "backup-manifest.json"), "utf8"));
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.createdAt !== "string") throw new Error("backup-manifest.json is invalid or unsupported");
  }
}

async function secureStateTree(root: any) {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await secureStateTree(path);
    } else if (entry.isFile()) {
      await chmod(path, 0o600);
    }
  }
}

async function session(args: any) {
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

async function goal(args: any) {
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

async function improve(args: any) {
  const [subcommand, ...rest] = args;
  switch (subcommand ?? "list") {
    case "learn":
      await runRecordTool(rest, "improve.learn", {
        limit: Number.parseInt(option(rest, "--limit", "1000"), 10)
      });
      break;
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
    case "rollback":
      await runRecordTool(rest, "improve.rollback", {
        improvementId: option(rest, "--improvement"),
        source: option(rest, "--source", "cli")
      });
      break;
    case "list":
      await runRecordTool(rest, "improve.list", {
        limit: Number.parseInt(option(rest, "--limit", "20"), 10)
      });
      break;
    default:
      throw new Error("improve requires subcommand: learn, propose, decide, rollback, or list");
  }
}

async function runMemoryTool(args: any, tool: any, input: any) {
  await runRecordTool(args, tool, input);
}

async function runRecordTool(args: any, tool: any, input: any) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const runLedger = createRunLedger({ stateDir: state, workspaceRoot: invocationRoot(), featureFlags: normalizeExperimentalFlags(config.experimental) });
  try {
    const auditStore = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
    const result = await runTask({
      task: { tool, input, actor: "cli" },
      auditStore,
      policy: createDefaultPolicy(config.policy),
      registry: createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: state, config, auditStore }),
      runLedger
    });
    await printJson(result.output);
  } finally {
    runLedger.close();
  }
}

function runtimeFor(args: any) {
  const state = stateDir(args);
  const config = readConfigSync(state);
  return { state, config, runtime: createDifferentiatedRuntime({ stateDir: state, workspaceRoot: invocationRoot(), featureFlags: normalizeExperimentalFlags(config.experimental) }) };
}

function readConfigSync(state: any) {
  try { return JSON.parse(readFileSync(join(state, "config.json"), "utf8")); }
  catch { return { experimental: normalizeExperimentalFlags() }; }
}

async function proof(args: any) {
  const [subcommand, ...rest] = args;
  if (subcommand === "contract" && rest[0] === "validate") {
    const path = rest[1]; if (!path) throw new Error("proof contract validate requires a contract path");
    const contract = parseStructuredDocument(await readFile(resolveInvocationPath(path), "utf8"), path); await printJson({ valid: true, contract: contract.schemaVersion === 1 ? validateVerificationContract(contract) : validateContract(contract) }); return;
  }
  const { runtime, config } = runtimeFor(rest);
  try {
    if (subcommand === "run") {
      if (!normalizeExperimentalFlags(config.experimental).proof) throw new Error("experimental.proof is disabled; enable it before running verification");
      const runId = rest.find((value: any) => !value.startsWith("--")); const path = option(rest, "--contract"); if (!runId || !path) throw new Error("proof run requires <run-id> and --contract");
      const contract = parseStructuredDocument(await readFile(resolveInvocationPath(path), "utf8"), path);
      if (contract.schemaVersion === 1) {
        if (contract.runId !== runId) throw new Error("proof contract runId must match the requested run");
        await printJson(await new ProofVerifier({ runLedger: runtime.ledger, allowedRoot: invocationRoot(), allowedCommands: config.proof?.allowedCommands ?? [] }).verify(contract));
      } else {
        await printJson(await runtime.proof.run(runId, contract, { workspaceRoot: invocationRoot() }));
      }
      return;
    }
    if (subcommand === "show") { const runId = rest.find((value: any) => !value.startsWith("--")); if (!runId) throw new Error("proof show requires <run-id>"); await printJson(runtime.proof.show(runId)); return; }
    throw new Error("proof requires run, show, or contract validate");
  } finally { runtime.ledger.close(); }
}

async function policyCommand(args: any) {
  const [subcommand, ...rest] = args; const path = rest.find((value: any) => !value.startsWith("--")); if (!path) throw new Error("policy requires a policy path");
  const policy = parseStructuredDocument(await readFile(resolveInvocationPath(path), "utf8"), path); validatePolicy(policy);
  if (subcommand === "validate") { await printJson({ valid: true, policy }); return; }
  if (subcommand !== "test") throw new Error("policy requires validate or test");
  const { runtime } = runtimeFor(rest); try { const runId = `policy-test-${randomUUID()}`; runtime.ledger.ensureRun({ runId, objective: "policy test" }); const result = runtime.sentinel.evaluate({ runId, toolName: option(rest, "--tool"), input: JSON.parse(option(rest, "--input-json", "{}")), policy }); await printJson(result); } finally { runtime.ledger.close(); }
}

async function capabilityCommand(args: any) {
  const [subcommand, ...rest] = args; const { runtime } = runtimeFor(rest);
  try {
    if (subcommand === "issue") { const result = runtime.capabilities.issue({ runId: option(rest, "--run"), stepId: option(rest, "--step"), toolName: option(rest, "--tool"), scopes: splitCsv(option(rest, "--scope", "")), resourceConstraints: JSON.parse(option(rest, "--constraints", "{}")), expiresInMs: Number(option(rest, "--expires-ms", "60000")), maxUses: Number(option(rest, "--max-uses", "1")) }); await printJson(hasFlag(rest, "--show-token") ? result : { claims: result.claims, token: "[hidden; use --show-token only for a one-time local test]" }); return; }
    if (subcommand === "use") { await printJson(runtime.capabilities.consume(option(rest, "--token"), { runId: option(rest, "--run"), toolName: option(rest, "--tool"), resource: JSON.parse(option(rest, "--resource", "{}")) })); return; }
    if (subcommand === "list") { await printJson(runtime.capabilities.list(rest.find((value: any) => !value.startsWith("--")))); return; }
    if (subcommand === "revoke") { await printJson(runtime.capabilities.revoke(rest.find((value: any) => !value.startsWith("--")))); return; }
    throw new Error("capability requires issue, use, list, or revoke");
  } finally { runtime.ledger.close(); }
}

async function timeline(args: any) {
  const { runtime } = runtimeFor(args); try {
    const runId = args.find((value: any) => !value.startsWith("--"));
    const run = runtime.ledger.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const { steps, events, ...metadata } = run;
    await printJson({ run: metadata, steps, events });
  } finally { runtime.ledger.close(); }
}

async function rewindCommand(command: any, args: any) {
  const { runtime } = runtimeFor(args); try {
    if (command === "checkpoint") { if (args[0] !== "create") throw new Error("checkpoint requires create"); const runId = args[1] && !args[1].startsWith("--") ? args[1] : option(args, "--run"); await printJson(runtime.snapshots.create({ runId, paths: splitCsv(option(args, "--path", "")), label: option(args, "--label", "checkpoint"), workspaceRoot: invocationRoot() })); return; }
    const snapshotId = args.find((value: any) => !value.startsWith("--")); if (!snapshotId) throw new Error("rewind requires <snapshot-id>"); await printJson(runtime.snapshots.restore(snapshotId, { apply: hasFlag(args, "--apply") }));
  } finally { runtime.ledger.close(); }
}

async function branchCommand(command: any, args: any) {
  const { runtime } = runtimeFor(args); try {
    if (command === "branch") { const path = option(args, "--plan-file"); const plan = parseStructuredDocument(await readFile(resolveInvocationPath(path), "utf8"), path); await printJson(await runtime.counterfactual.create({ sourceRunId: args[0], sourceStepId: option(args, "--from"), plans: [plan], workspaceRoot: invocationRoot() })); return; }
    await printJson(runtime.counterfactual.compare(args[0]));
  } finally { runtime.ledger.close(); }
}

async function capsuleCommand(args: any) {
  const [subcommand, ...rest] = args; const { state, runtime } = runtimeFor(rest); try {
    const path = rest.find((value: any) => !value.startsWith("--"));
    if (subcommand === "export") await printJson(await runtime.capsules.export(path, { output: option(rest, "--output") }));
    else if (subcommand === "inspect" || subcommand === "verify") await printJson(await runtime.capsules.verify(path));
    else if (subcommand === "replay") {
      const mode = option(rest, "--mode", "verification-only");
      const config = await readConfig(state);
      const auditStore = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
      await printJson(await runtime.capsules.replay(path, {
        mode,
        workspace: option(rest, "--workspace", ""),
        approveExternal: hasFlag(rest, "--approve-external"),
        executor: mode === "full" ? async ({ tool, input, replayRunId, stepIndex, workspaceRoot }: any) => {
          const taskId = `${replayRunId}-step-${stepIndex}`;
          if (runtime.ledger.featureFlags.capabilities === true) {
            const issued = runtime.capabilities.issue({ runId: taskId, stepId: `replay-step-${stepIndex}`, toolName: tool, scopes: [tool], resourceConstraints: input.resource ?? {} });
            input = { ...input, capabilityToken: issued.token };
          }
          return runTask({
            task: { id: taskId, tool, input, actor: "capsule-replay" },
            auditStore,
            policy: createDefaultPolicy(config.policy),
            registry: createBuiltInRegistry({ workspaceRoot, stateDir: state, config, auditStore }),
            runLedger: runtime.ledger
          });
        } : undefined
      }));
    }
    else throw new Error("capsule requires export, inspect, verify, or replay");
  } finally { runtime.ledger.close(); }
}

async function counterfactualCommand(args: any) {
  const [subcommand, ...rest] = args; const { runtime } = runtimeFor(rest); try {
    if (subcommand === "run") {
      const files = []; for (let i = 0; i < rest.length; i += 1) if (rest[i] === "--plan-file") files.push(rest[i + 1]);
      const created = await runtime.counterfactual.create({ sourceRunId: option(rest, "--source-run"), sourceStepId: option(rest, "--from"), plans: await Promise.all(files.map(async (file: any) => parseStructuredDocument(await readFile(resolveInvocationPath(file), "utf8"), file))), workspaceRoot: invocationRoot() });
      if (!hasFlag(rest, "--execute")) { await printJson(created); return; }
      const config = await readConfig(stateDir(rest));
      const auditStore = createAuditStore(join(stateDir(rest), config.auditLog ?? "audit.jsonl"));
      const registry = createBuiltInRegistry({ workspaceRoot: invocationRoot(), stateDir: stateDir(rest), config, auditStore });
      const result = await runtime.counterfactual.execute(created.groupId, {
        proof: {
          run: async (runId: any, contract: any, { workspaceRoot = invocationRoot() }: any = {}) => {
            if (contract?.schemaVersion === 1) {
              if (!normalizeExperimentalFlags(config.experimental).proof) throw new Error("experimental.proof is disabled; counterfactual verification cannot run");
              return new ProofVerifier({
                runLedger: runtime.ledger,
                allowedRoot: workspaceRoot,
                allowedCommands: config.proof?.allowedCommands ?? []
              }).verify({ ...contract, runId });
            }
            return runtime.proof.run(runId, contract, { workspaceRoot });
          }
        },
        capabilities: runtime.capabilities,
        policy: createDefaultPolicy(config.policy),
        workspaceRoot: invocationRoot(),
        executor: async (task: any, context: any) => runTask({ task, auditStore, policy: context.policy, registry: createBuiltInRegistry({ workspaceRoot: context.workspaceRoot, stateDir: stateDir(rest), config, auditStore }), runLedger: runtime.ledger })
      });
      await printJson({ ...created, execution: result });
      return;
    }
    if (subcommand === "compare") { await printJson(runtime.counterfactual.compare(rest[0])); return; }
    if (subcommand === "select") { await printJson(await runtime.counterfactual.select(rest[0], option(rest, "--run"), { apply: hasFlag(rest, "--apply") })); return; }
    throw new Error("counterfactual requires run, compare, or select");
  } finally { runtime.ledger.close(); }
}

async function routingCommand(args: any) {
  const [subcommand, ...rest] = args; const { runtime } = runtimeFor(rest); try {
    if (subcommand === "observe") { await printJson(runtime.darwin.observe({ runId: option(rest, "--run"), providerId: option(rest, "--provider"), modelId: option(rest, "--model"), taskClass: option(rest, "--task-class", "general"), verified: option(rest, "--verified") === "true", partiallyVerified: option(rest, "--partial") === "true", durationMs: Number(option(rest, "--duration-ms", "0")), costUsd: Number(option(rest, "--cost-usd", "0")), toolCalls: Number(option(rest, "--tool-calls", "0")), toolErrors: Number(option(rest, "--tool-errors", "0")), retries: Number(option(rest, "--retries", "0")), policyViolations: Number(option(rest, "--policy-violations", "0")), rolledBack: hasFlag(rest, "--rolled-back") })); return; }
    if (subcommand === "stats") { await printJson(runtime.darwin.stats(option(rest, "--task-class", "general"))); return; }
    if (subcommand === "choose") { await printJson(runtime.darwin.choose(option(rest, "--task-class", "general"), { pinnedModel: option(rest, "--model", "") })); return; }
    throw new Error("routing requires observe, stats, or choose");
  } finally { runtime.ledger.close(); }
}

async function audit(args: any) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const store = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  const subcommand = args.find((value: any) => !value.startsWith("--"));
  if (subcommand === "verify") {
    await printJson(await store.verifyIntegrity({ allowUnsigned: hasFlag(args, "--allow-unsigned") }));
    return;
  }
  if (subcommand === "rotate-key") {
    await printJson(await store.rotateKey());
    return;
  }
  await printJson(await store.readAll());
}

async function runs(args: any) {
  const state = stateDir(args);
  const config = await readConfig(state);
  const limit = Number.parseInt(option(args, "--limit", "20"), 10);
  const store = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  await printJson((await store.readRuns()).slice(0, Number.isFinite(limit) ? limit : 20));
}

async function show(args: any) {
  const state = stateDir(args);
  const runId = option(args, "--run");
  if (!runId) throw new Error("show requires --run");
  const config = await readConfig(state);
  const store = createAuditStore(join(state, config.auditLog ?? "audit.jsonl"));
  const run = await store.readRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  await printJson(run);
}

async function readConfig(state: any) {
  const path = join(state, "config.json");
  try {
    const raw = await readFile(path, "utf8");
    const config = JSON.parse(raw);
    if (config && typeof config === "object") configBaselines.set(config, contentFingerprint(raw));
    return config;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    const config = { version: 1, policy: createDefaultPolicy(), auditLog: "audit.jsonl", providers: {}, defaultModel: "", experimental: normalizeExperimentalFlags(), selfImprovement: normalizeSelfImprovementConfig() };
    configBaselines.set(config, null);
    return config;
  }
}

async function ensureConfig(state: any) {
  return withStateMutationLock(state, async () => {
    const configPath = join(state, "config.json");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    await writeFile(configPath, `${JSON.stringify({
      version: 1,
      policy: createDefaultPolicy(),
      auditLog: "audit.jsonl",
      providers: {},
      defaultModel: "",
      experimental: normalizeExperimentalFlags(),
      selfImprovement: normalizeSelfImprovementConfig()
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch((error: any) => {
      if (error?.code !== "EEXIST") throw error;
    });
    await chmod(configPath, 0o600);
    return configPath;
  });
}

async function saveConfig(state: any, config: any) {
  const serialized = `${JSON.stringify({
    version: config.version ?? 1,
    policy: config.policy ?? createDefaultPolicy(),
    auditLog: config.auditLog ?? "audit.jsonl",
    providers: config.providers ?? {},
    experimental: normalizeExperimentalFlags(config.experimental),
    selfImprovement: normalizeSelfImprovementConfig(config.selfImprovement),
    runtime: config.runtime ?? {},
    ...(config.proof ? { proof: config.proof } : {}),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {})
  }, null, 2)}\n`;
  await withStateMutationLock(state, async () => {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    const expected = config && typeof config === "object" ? configBaselines.get(config) : undefined;
    if (expected !== undefined) {
      const current = await readFile(join(state, "config.json"), "utf8").then(contentFingerprint).catch((error: any) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (current !== expected) {
        throw new Error("Odinn configuration changed in another process. Your stale changes were not written; reload the configuration and try again.");
      }
    }
    await atomicWrite(join(state, "config.json"), serialized, 0o600);
    if (config && typeof config === "object") configBaselines.set(config, contentFingerprint(serialized));
  });
}

function contentFingerprint(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function renderOnboardingSummary({ providers, defaultModel }: any) {
  if (!providers.length) {
    return [
      "Ódinn needs an AI connection before it can start.",
      "",
      `Run ${odinnCommand()} onboard in a terminal to choose ChatGPT or a local model.`
    ].join("\n");
  }
  const provider = providers.find((entry: any) => defaultModel?.startsWith(`${entry.name}:`)) ?? providers[0];
  return [
    "Ódinn is ready.",
    "",
    `AI: ${friendlyProviderName(provider.name)} · ${friendlyModelName(defaultModel)}`,
    `Connection: ${provider.configured ? "Credentials found — run onboarding verification to test them" : "Needs attention"}`,
    "",
    `Start Ódinn: ${odinnCommand()} start`,
    `Change this setup later: ${odinnCommand()} onboard`
  ].join("\n");
}

function renderCurrentSetup(current: any) {
  const provider = current.providers.find((entry: any) => current.defaultModel?.startsWith(`${entry.name}:`)) ?? current.providers[0];
  return [
    `  AI: ${friendlyProviderName(provider?.name)} · ${friendlyModelName(current.defaultModel)}`,
    `  Credentials: ${provider?.configured ? "Found" : "Need attention"}`,
    `  Access: ${friendlyAccessName(current.policy ?? current.allowedCapabilities)}`,
    ...(current.runtime ? [`  Local workspace: ${current.runtime.state === "healthy" ? "Running" : current.runtime.state === "stopped" ? "Stopped" : "Needs attention"}`] : []),
    ""
  ].join("\n");
}

function renderSetupComplete(current: any) {
  const provider = current.providers.find((entry: any) => current.defaultModel?.startsWith(`${entry.name}:`)) ?? current.providers[0];
  return [
    "\nYou’re ready.",
    `  AI: ${friendlyProviderName(provider?.name)} · ${friendlyModelName(current.defaultModel)}`,
    `  Access: ${friendlyAccessName(current.policy ?? current.allowedCapabilities)}`,
    ""
  ].join("\n");
}

function friendlyProviderName(name: any) {
  if (name === "openai") return "OpenAI / ChatGPT";
  if (name === "ollama") return "Ollama (local)";
  if (!name) return "Not connected";
  return String(name).split(/[-_]/u).map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function friendlyModelName(model: any) {
  const name = String(model ?? "").split(":").slice(1).join(":") || String(model ?? "");
  return name || "No model selected";
}

function friendlyAccessName(policyOrCapabilities: any = []) {
  const policy = Array.isArray(policyOrCapabilities)
    ? createDefaultPolicy({ allowedCapabilities: policyOrCapabilities })
    : policyOrCapabilities;
  return accessProfileLabel(identifyAccessProfile(policy));
}

function renderOnboardingDetails({ state, workspaceRoot, configPath, tools, allowedCapabilities, providers, defaultModel, runs }: any) {
  const providerLines = providers.length
    ? providers.map((provider: any) => `  - ${provider.name} [${provider.authMode}]: ${provider.models.join(", ")} (${provider.baseUrl})${provider.configured ? "" : provider.authMode === "oauth" ? " [not connected]" : provider.apiKeyEnv ? " [credential missing]" : ""}`)
    : ["  - none"];
  return [
    "Technical details",
    `State: ${state}`,
    `Workspace: ${workspaceRoot}`,
    "",
    "Configured providers:",
    ...providerLines,
    `Default model: ${defaultModel || "(none)"}`,
    `${tools.length} tools · ${allowedCapabilities.length} allowed capabilities · ${runs.length} recorded runs`,
    `Config: ${configPath}`,
    `More commands: ${odinnCommand()} help --all`
  ].join("\n");
}

function renderTui({ state, workspaceRoot, tools, allowedCapabilities, runs }: any) {
  const recent = runs.slice(0, 8);
  return [
    "Odinn Forge TUI",
    "=========",
    `Workspace : ${workspaceRoot}`,
    `State     : ${state}`,
    `Tools     : ${tools.join(", ") || "(none)"}`,
    `Policy    : ${allowedCapabilities.join(", ") || "(none)"}`,
    "",
    "Recent runs",
    "-----------",
    recent.length
      ? recent.map((run: any) => `${run.status.padEnd(9)} ${run.id} ${run.tool ?? ""} ${run.message ?? ""}`.trimEnd()).join("\n")
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

function splitCsv(value: any) {
  return String(value ?? "")
    .split(",")
    .map((item: any) => item.trim())
    .filter(Boolean);
}

async function printJson(value: any) {
  console.log(JSON.stringify(redactOutput(value), null, 2));
}

function redactOutput(value: any): any {
  if (Array.isArray(value)) return value.map((item: any) => redactOutput(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]: any) => [
    key,
    /(?:api.?key(?!env)|access.?token|refresh.?token|client.?secret(?!env)|password|authorization)/i.test(key)
      ? "[redacted]"
      : redactOutput(item)
  ]));
}

main().catch((error: any) => {
  console.error(error.message);
  process.exitCode = 1;
});
