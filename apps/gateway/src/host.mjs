#!/usr/bin/env node
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { chmod, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureSecureStateDirectory } from "@odinn/store-file";
import { createGatewayServer } from "./server.mjs";

const scrypt = promisify(scryptCallback);
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export async function hashPassword(password, salt = randomBytes(16).toString("base64url")) {
  if (String(password).length < 12) throw new Error("gateway host passwords require at least 12 characters");
  return { salt, hash: Buffer.from(await scrypt(password, salt, 32)).toString("base64url") };
}

export async function verifyPassword(password, record) {
  const actual = Buffer.from(await scrypt(password, record.salt, 32));
  const expected = Buffer.from(record.passwordHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createMultiUserHost({ stateDir = ".odinn-host", users, publicOrigin, tls, loginLimits = {} } = {}) {
  const root = resolve(stateDir);
  await ensureSecureStateDirectory(root);
  const records = users ?? JSON.parse(await readFile(join(root, "users.json"), "utf8"));
  const usersById = new Map((records.users ?? []).filter((user) => !user.disabled).map((user) => [user.id, user]));
  const sessions = new Map();
  const tenants = new Map();
  const loginAttempts = new Map();
  const sessionKey = randomBytes(32);
  const maximumLoginAttempts = Math.max(1, Number(loginLimits.maximumAttempts ?? 5));
  const loginWindowMs = Math.max(1_000, Number(loginLimits.windowMs ?? 5 * 60 * 1000));

  async function tenant(user) {
    if (tenants.has(user.id)) return tenants.get(user.id);
    const userState = resolve(root, "users", user.id);
    if (!userState.startsWith(`${root}${sep}`)) throw new Error("invalid tenant state path");
    const workspaceRoot = await realpath(resolve(user.workspaceRoot));
    const gateway = await createGatewayServer({ stateDir: userState, workspaceRoot });
    await new Promise((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
    const value = { gateway, port: gateway.address().port, token: gateway.odinnAuthToken };
    tenants.set(user.id, value);
    return value;
  }

  const handler = async (request, response) => {
    try {
      const origin = request.headers.origin;
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method || "GET");
      if (publicOrigin && mutating && origin !== publicOrigin) return send(response, 403, { error: "origin rejected" });
      if (origin && publicOrigin && origin !== publicOrigin) return send(response, 403, { error: "origin rejected" });
      if (request.method === "GET" && request.url === "/auth/login") return loginPage(response);
      if (request.method === "POST" && request.url === "/auth/login") {
        const body = await readBody(request);
        const userId = String(body.userId || "");
        const attemptKey = `${request.socket.remoteAddress || "unknown"}:${userId}`;
        const now = Date.now();
        const attempt = loginAttempts.get(attemptKey);
        if (attempt && attempt.resetAt > now && attempt.count >= maximumLoginAttempts) {
          response.setHeader("retry-after", String(Math.max(1, Math.ceil((attempt.resetAt - now) / 1000))));
          return send(response, 429, { error: "too many authentication attempts" });
        }
        if (attempt?.resetAt <= now) loginAttempts.delete(attemptKey);
        const user = usersById.get(userId);
        if (!user || !await verifyPassword(String(body.password || ""), user)) {
          const current = loginAttempts.get(attemptKey);
          loginAttempts.set(attemptKey, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? now + loginWindowMs });
          return send(response, 401, { error: "invalid credentials" });
        }
        loginAttempts.delete(attemptKey);
        const id = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
        sessions.set(id, { userId: user.id, expiresAt });
        const signature = createHmac("sha256", sessionKey).update(id).digest("base64url");
        response.setHeader("set-cookie", `odinn_host_session=${id}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${tls ? "; Secure" : ""}`);
        return send(response, 200, { ok: true, userId: user.id });
      }
      const session = authenticate(request, sessions, sessionKey);
      if (!session && request.method === "GET" && request.url === "/") { response.writeHead(302, { location: "/auth/login", "cache-control": "no-store" }); return response.end(); }
      if (!session) return send(response, 401, { error: "host authentication required" });
      if (request.method === "POST" && request.url === "/auth/logout") {
        sessions.delete(session.id);
        response.setHeader("set-cookie", `odinn_host_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tls ? "; Secure" : ""}`);
        return send(response, 200, { ok: true });
      }
      const user = usersById.get(session.userId);
      if (!user) return send(response, 403, { error: "user disabled" });
      const backend = await tenant(user);
      proxy(request, response, backend);
    } catch (error) { send(response, 500, { error: error.message }); }
  };
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  const close = server.close.bind(server);
  server.close = (callback) => Promise.allSettled([...tenants.values()].map(({ gateway }) => new Promise((done) => gateway.close(() => done())))).then(() => close(callback));
  return server;
}

export async function addHostUser({ stateDir = ".odinn-host", id, password, workspaceRoot }) {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(String(id || ""))) throw new Error("user id must contain 2-64 lowercase letters, digits, underscores, or hyphens");
  const root = resolve(stateDir); await ensureSecureStateDirectory(root);
  const workspace = await realpath(resolve(workspaceRoot));
  const credentials = await hashPassword(password);
  const path = join(root, "users.json");
  let config = { schemaVersion: 1, users: [] };
  try { config = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const user = { id, workspaceRoot: workspace, salt: credentials.salt, passwordHash: credentials.hash, disabled: false };
  config.users = [...(config.users ?? []).filter((item) => item.id !== id), user];
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600);
  return { id, workspaceRoot: workspace };
}

function proxy(incoming, outgoing, backend) {
  const headers = { ...incoming.headers, host: `127.0.0.1:${backend.port}`, authorization: `Bearer ${backend.token}` };
  delete headers.cookie;
  if (headers.origin) headers.origin = `http://127.0.0.1:${backend.port}`;
  const request = httpRequest({ hostname: "127.0.0.1", port: backend.port, path: incoming.url, method: incoming.method, headers }, (response) => {
    const forwarded = { ...response.headers }; delete forwarded["set-cookie"];
    outgoing.writeHead(response.statusCode ?? 502, forwarded); response.pipe(outgoing);
  });
  request.on("error", (error) => send(outgoing, 502, { error: error.message }));
  incoming.pipe(request);
}

function authenticate(request, sessions, key) {
  const raw = String(request.headers.cookie || "").split(/;\s*/).find((item) => item.startsWith("odinn_host_session="))?.split("=").slice(1).join("=");
  const [id, signature] = String(raw || "").split(".");
  if (!id || !signature) return null;
  const expected = createHmac("sha256", key).update(id).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(id);
    return null;
  }
  return { ...session, id };
}
async function readBody(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 16_384) throw new Error("request too large"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
function send(response, status, value) { if (response.headersSent) return; response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(`${JSON.stringify(value)}\n`); }
function loginPage(response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" });
  response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Ódinn Forge sign in</title><style>body{margin:0;background:#080a0d;color:#e7e9ee;font:15px system-ui;display:grid;place-items:center;min-height:100vh}form{width:min(360px,85vw);display:grid;gap:14px;padding:28px;border:1px solid #262b34;border-radius:16px;background:#11141a}input,button{padding:12px;border-radius:9px;border:1px solid #343b47;background:#0b0e13;color:inherit}button{background:#d6a84b;color:#111;font-weight:700}</style></head><body><form id="login"><h1>Ódinn Forge</h1><input name="userId" autocomplete="username" placeholder="User" required><input name="password" type="password" autocomplete="current-password" placeholder="Password" required><button>Sign in</button><div id="error"></div></form><script>login.onsubmit=async(e)=>{e.preventDefault();const f=new FormData(login);const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(f))});if(r.ok)location='/';else error.textContent='Authentication failed';}</script></body></html>`);
}

if (isMain) {
  const stateDir = resolve(process.env.ODINN_HOST_STATE || ".odinn-host");
  if (process.argv[2] === "user-add") {
    const value = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ""; };
    const result = await addHostUser({ stateDir, id: value("--id"), password: process.env.ODINN_USER_PASSWORD, workspaceRoot: value("--workspace") });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    process.exit(0);
  }
  const host = process.env.ODINN_HOST || "127.0.0.1";
  const port = Number(process.env.ODINN_PORT || 18791);
  const remote = !["127.0.0.1", "::1", "localhost"].includes(host);
  const cert = process.env.ODINN_TLS_CERT; const key = process.env.ODINN_TLS_KEY;
  if (remote && (!cert || !key || !process.env.ODINN_PUBLIC_ORIGIN)) throw new Error("remote hosting requires ODINN_TLS_CERT, ODINN_TLS_KEY, and ODINN_PUBLIC_ORIGIN");
  const tls = cert && key ? { cert: await readFile(cert), key: await readFile(key) } : undefined;
  const server = await createMultiUserHost({ stateDir, publicOrigin: process.env.ODINN_PUBLIC_ORIGIN, tls });
  server.listen(port, host, () => console.log(`Odinn Forge multi-user host listening on ${tls ? "https" : "http"}://${host}:${port}`));
}
