import { spawn } from "node:child_process";
import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { request as requestHttps } from "node:https";
import { connect } from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18_790;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_500;
const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 1_500;
const MAX_PROBE_RESPONSE_BYTES = 512 * 1_024;

export type GatewayProtocol = "http" | "https";
export type GatewayProbeState = "healthy" | "occupied" | "stopped" | "unreachable";

export interface GatewayProbeOptions {
  host?: string;
  port?: number;
  protocol?: GatewayProtocol;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface GatewayHealthSummary {
  stateDir: string;
  workspaceRoot: string;
  defaultModel?: string;
  providerCount: number;
  toolCount: number;
}

interface GatewayProbeBase {
  state: GatewayProbeState;
  host: string;
  port: number;
  url: string;
  detail: string;
}

export interface HealthyGatewayProbe extends GatewayProbeBase {
  state: "healthy";
  reason: "odinn-ready";
  statusCode: number;
  health: GatewayHealthSummary;
}

export interface OccupiedGatewayProbe extends GatewayProbeBase {
  state: "occupied";
  reason: "non-odinn-service" | "unhealthy-odinn" | "invalid-http-response";
  statusCode?: number;
  errorCode?: string;
}

export interface StoppedGatewayProbe extends GatewayProbeBase {
  state: "stopped";
  reason: "connection-refused";
  errorCode?: string;
}

export interface UnreachableGatewayProbe extends GatewayProbeBase {
  state: "unreachable";
  reason: "connection-timeout" | "network-error";
  errorCode?: string;
}

export type GatewayProbeResult = HealthyGatewayProbe | OccupiedGatewayProbe | StoppedGatewayProbe | UnreachableGatewayProbe;

export interface GatewayRuntimeDecision {
  action: "open" | "start" | "blocked";
  shouldOpen: boolean;
  shouldStart: boolean;
  detail: string;
}

export interface GatewayRuntimeInspection {
  probe: GatewayProbeResult;
  decision: GatewayRuntimeDecision;
}

export interface BrowserCommand {
  command: string;
  args: string[];
}

export interface BrowserOpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  commands?: readonly BrowserCommand[];
}

export type BrowserOpenResult =
  | {
      ok: true;
      url: string;
      command: string;
      detail: string;
    }
  | {
      ok: false;
      url: string;
      reason: "invalid-url" | "unsupported-platform" | "command-failed";
      attemptedCommands: string[];
      detail: string;
    };

interface HttpProbeResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface TcpProbeResult {
  connected: boolean;
  errorCode?: string;
}

/**
 * Inspect the configured gateway address without changing process or service
 * state. A start is safe to offer only when this reports `stopped`.
 */
export async function probeGateway(options: GatewayProbeOptions = {}): Promise<GatewayProbeResult> {
  const address = normalizeGatewayOptions(options);
  const tcp = await probeTcp(address.host, address.port, address.connectTimeoutMs);
  if (!tcp.connected) return unavailableProbe(address, tcp.errorCode);

  let root: HttpProbeResponse;
  try {
    root = await requestText(address, "/");
  } catch (error) {
    const errorCode = errorCodeFor(error);
    return {
      state: "occupied",
      reason: "invalid-http-response",
      host: address.host,
      port: address.port,
      url: address.url,
      errorCode,
      detail: `Port ${address.port} is in use, but the service at ${address.url} did not return a valid HTTP response. Ódinn will not start another server on that port.`
    };
  }

  const cookie = gatewayCookie(root.headers);
  let status: HttpProbeResponse;
  try {
    status = await requestText(address, "/status", cookie ? { cookie } : undefined);
  } catch (error) {
    return occupiedProbeFromFailedHealth(address, root, undefined, errorCodeFor(error));
  }

  const health = parseOdinnHealth(status);
  if (health && isOdinnRoot(root)) {
    return {
      state: "healthy",
      reason: "odinn-ready",
      host: address.host,
      port: address.port,
      url: address.url,
      statusCode: status.statusCode,
      health,
      detail: `Ódinn is already running and responding at ${address.url}`
    };
  }

  return occupiedProbeFromFailedHealth(address, root, status);
}

/**
 * Convert a read-only probe into an onboarding action. This helper never binds
 * a socket: callers must only invoke their start path when `shouldStart` is
 * true, and should probe again immediately before starting to avoid races.
 */
export function decideGatewayAction(probe: GatewayProbeResult): GatewayRuntimeDecision {
  switch (probe.state) {
    case "healthy":
      return {
        action: "open",
        shouldOpen: true,
        shouldStart: false,
        detail: "Ódinn is already running. Open the existing console instead of starting another copy."
      };
    case "stopped":
      return {
        action: "start",
        shouldOpen: false,
        shouldStart: true,
        detail: "No service is listening at the configured address. Ódinn can be started safely."
      };
    case "occupied":
    case "unreachable":
      return {
        action: "blocked",
        shouldOpen: false,
        shouldStart: false,
        detail: probe.detail
      };
  }
}

export async function inspectGatewayRuntime(options: GatewayProbeOptions = {}): Promise<GatewayRuntimeInspection> {
  const probe = await probeGateway(options);
  return { probe, decision: decideGatewayAction(probe) };
}

/** Return browser-launch commands in preference order for the current OS. */
export function browserCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): BrowserCommand[] {
  if (platform === "darwin") return [{ command: "open", args: [url] }];
  if (platform === "win32") {
    return [{ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }];
  }
  if (platform === "linux") {
    const commands: BrowserCommand[] = [];
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) commands.push({ command: "wslview", args: [url] });
    commands.push(
      { command: "xdg-open", args: [url] },
      { command: "gio", args: ["open", url] },
      { command: "sensible-browser", args: [url] }
    );
    return commands;
  }
  return [];
}

/**
 * Ask the operating system to open an HTTP(S) URL and report whether a launch
 * command actually started. Failure always includes a manual-open fallback.
 */
export async function openBrowser(url: string, options: BrowserOpenOptions = {}): Promise<BrowserOpenResult> {
  const parsed = safeBrowserUrl(url);
  if (!parsed) {
    return {
      ok: false,
      url,
      reason: "invalid-url",
      attemptedCommands: [],
      detail: "The browser URL is invalid. Ódinn only opens HTTP or HTTPS addresses without embedded credentials."
    };
  }

  const href = parsed.href;
  const commands = options.commands
    ? options.commands.map((item) => ({ command: item.command, args: [...item.args] }))
    : browserCommands(href, options.platform, options.env);
  if (commands.length === 0) {
    return {
      ok: false,
      url: href,
      reason: "unsupported-platform",
      attemptedCommands: [],
      detail: `Ódinn could not open a browser automatically on this platform. Open ${href} in your browser.`
    };
  }

  const timeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULT_BROWSER_COMMAND_TIMEOUT_MS, "commandTimeoutMs");
  const attemptedCommands: string[] = [];
  for (const candidate of commands) {
    if (!candidate.command.trim()) continue;
    attemptedCommands.push(candidate.command);
    if (await launchBrowserCommand(candidate, timeoutMs, options.env)) {
      return {
        ok: true,
        url: href,
        command: candidate.command,
        detail: `Opened ${href} in your default browser.`
      };
    }
  }

  return {
    ok: false,
    url: href,
    reason: "command-failed",
    attemptedCommands,
    detail: `Ódinn could not open a browser automatically. Open ${href} in your browser.`
  };
}

function normalizeGatewayOptions(options: GatewayProbeOptions) {
  const configuredHost = String(options.host ?? DEFAULT_HOST).trim();
  if (!configuredHost || /[\s/\\]/.test(configuredHost) || configuredHost.includes("@")) throw new Error("gateway host must be a hostname or IP address");
  const host = configuredHost.startsWith("[") && configuredHost.endsWith("]")
    ? configuredHost.slice(1, -1)
    : configuredHost;
  if (!host) throw new Error("gateway host must be a hostname or IP address");
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("gateway port must be an integer from 1 through 65535");
  const protocol = options.protocol ?? "http";
  if (protocol !== "http" && protocol !== "https") throw new Error("gateway protocol must be http or https");
  const connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs");
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { host, port, protocol, connectTimeoutMs, requestTimeoutMs, url: `${protocol}://${urlHost}:${port}/` };
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1) throw new Error(`${name} must be a positive integer`);
  return normalized;
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (result: TcpProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ connected: true }));
    socket.once("timeout", () => finish({ connected: false, errorCode: "ETIMEDOUT" }));
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ connected: false, errorCode: error.code ?? "NETWORK_ERROR" }));
  });
}

function unavailableProbe(
  address: ReturnType<typeof normalizeGatewayOptions>,
  errorCode: string | undefined
): StoppedGatewayProbe | UnreachableGatewayProbe {
  if (errorCode === "ECONNREFUSED") {
    return {
      state: "stopped",
      reason: "connection-refused",
      host: address.host,
      port: address.port,
      url: address.url,
      errorCode,
      detail: `Ódinn is not running at ${address.url} Nothing is listening on that address.`
    };
  }
  const reason = errorCode === "ETIMEDOUT" ? "connection-timeout" : "network-error";
  const detail = reason === "connection-timeout"
    ? `Ódinn did not answer at ${address.url} The address could not be verified, so another server will not be started.`
    : `Ódinn could not reach ${address.url}${errorCode ? ` (${errorCode})` : ""}. Check the address or network before starting a server.`;
  return {
    state: "unreachable",
    reason,
    host: address.host,
    port: address.port,
    url: address.url,
    errorCode,
    detail
  };
}

function occupiedProbeFromFailedHealth(
  address: ReturnType<typeof normalizeGatewayOptions>,
  root: HttpProbeResponse,
  status?: HttpProbeResponse,
  errorCode?: string
): OccupiedGatewayProbe {
  const looksLikeOdinn = isOdinnRoot(root);
  const statusCode = status?.statusCode ?? root.statusCode;
  if (looksLikeOdinn) {
    return {
      state: "occupied",
      reason: "unhealthy-odinn",
      host: address.host,
      port: address.port,
      url: address.url,
      statusCode,
      errorCode,
      detail: `Ódinn appears to be running at ${address.url}, but its health check failed${statusCode ? ` (HTTP ${statusCode})` : ""}. Do not start another copy; repair or restart the existing service.`
    };
  }
  return {
    state: "occupied",
    reason: "non-odinn-service",
    host: address.host,
    port: address.port,
    url: address.url,
    statusCode,
    errorCode,
    detail: `Port ${address.port} is already being used by another service. Stop that service or choose a different port before starting Ódinn.`
  };
}

function isOdinnRoot(response: HttpProbeResponse) {
  const authenticationHeader = response.headers["x-odinn-auth"];
  if (String(authenticationHeader ?? "") === "bootstrap-cookie") return true;
  const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("text/html") && /<title>\s*[ÓO]dinn Forge Console\s*<\/title>/i.test(response.body);
}

function gatewayCookie(headers: IncomingHttpHeaders) {
  const values = headers["set-cookie"] ?? [];
  const cookies = Array.isArray(values) ? values : [values];
  for (const value of cookies) {
    const cookie = String(value).split(";", 1)[0]?.trim();
    if (cookie?.startsWith("odinn_gateway_token=")) return cookie;
  }
  return undefined;
}

function parseOdinnHealth(response: HttpProbeResponse): GatewayHealthSummary | undefined {
  if (response.statusCode !== 200) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (
    value.ok !== true
    || typeof value.state !== "string"
    || typeof value.workspaceRoot !== "string"
    || !Array.isArray(value.tools)
    || !Array.isArray(value.allowedCapabilities)
    || !Array.isArray(value.providers)
  ) return undefined;
  return {
    stateDir: value.state,
    workspaceRoot: value.workspaceRoot,
    defaultModel: typeof value.defaultModel === "string" ? value.defaultModel : undefined,
    providerCount: value.providers.length,
    toolCount: value.tools.length
  };
}

function requestText(
  address: ReturnType<typeof normalizeGatewayOptions>,
  path: string,
  headers: Record<string, string> = {}
): Promise<HttpProbeResponse> {
  const request = address.protocol === "https" ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    const outgoing = request({
      protocol: `${address.protocol}:`,
      hostname: address.host,
      port: address.port,
      path,
      method: "GET",
      headers: { accept: "application/json, text/html;q=0.9", ...headers }
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.byteLength;
        if (bytes > MAX_PROBE_RESPONSE_BYTES) {
          response.destroy(Object.assign(new Error("gateway probe response was too large"), { code: "RESPONSE_TOO_LARGE" }));
          return;
        }
        chunks.push(data);
      });
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.setTimeout(address.requestTimeoutMs, () => {
      outgoing.destroy(Object.assign(new Error("gateway probe timed out"), { code: "ETIMEDOUT" }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function safeBrowserUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function launchBrowserCommand(candidate: BrowserCommand, timeoutMs: number, env: NodeJS.ProcessEnv | undefined) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(candidate.command, candidate.args, {
      detached: true,
      env: env ?? process.env,
      shell: false,
      stdio: "ignore"
    });
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.once("spawn", () => {
      child.unref();
      timer = setTimeout(() => finish(true), timeoutMs);
    });
  });
}

function errorCodeFor(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}
