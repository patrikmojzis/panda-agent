#!/usr/bin/env node
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {createHash, randomUUID} from "node:crypto";
import {once} from "node:events";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const transport = option("--transport", "stdio");
const port = Number(option("--port", "0"));
const host = option("--host", "127.0.0.1");
const mode = option("--mode", "normal");
const secret = process.env.FIXTURE_SECRET ?? "";
const emitSecretKeys = mode === "secret-keys" || mode === "secret-key-collision";
const events = [];
const sessions = new Map();
const oauthClients = new Map();
const oauthCodes = new Map();
const oauthAccessTokens = new Set();
const oauthRefreshTokens = new Set();
const oauthEvents = [];

const richTools = [
  {
    name: "echo",
    title: "Rich echo",
    description: "Returns a rich MCP result envelope.",
    inputSchema: {type: "object", properties: {message: {type: "string"}}},
    outputSchema: {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object"},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
    _meta: {fixture: "page-one"},
  },
  {
    name: "destructive_fixture",
    description: "Visible write/destructive annotation fixture.",
    inputSchema: {type: "object"},
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false},
  },
];

function resultFor(message) {
  const method = message?.method;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: mode === "invalid-initialize" ? "malformed" : {
          tools: {listChanged: false},
          ...(emitSecretKeys && secret ? {experimental: {[secret]: {source: "server-metadata"}}} : {}),
        },
        serverInfo: {
          name: "panda-mcp-fixture",
          version: "1.0.0",
          ...(emitSecretKeys && secret ? {[secret]: "server-metadata"} : {}),
        },
      },
    };
  }
  if (method === "tools/list") {
    const second = message.params?.cursor === "page-2";
    if (mode === "cursor-cycle" && second) {
      return {jsonrpc: "2.0", id: message.id, result: {tools: [richTools[1]], nextCursor: "page-2"}};
    }
    const tools = second ? [richTools[1]] : [richTools[0]];
    if (mode === "aggregate-oversize") {
      tools[0] = {...tools[0], description: "x".repeat(4_500_000)};
    }
    if (emitSecretKeys && secret) {
      tools[0] = {...tools[0], _meta: {...tools[0]._meta, [secret]: "tool-metadata"}};
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: second
        ? {tools, _meta: {page: 2, ...(emitSecretKeys && secret ? {[secret]: "list-metadata"} : {})}}
        : {tools, nextCursor: "page-2", _meta: {page: 1, ...(emitSecretKeys && secret ? {[secret]: "list-metadata"} : {})}},
    };
  }
  if (method === "tools/call") {
    const name = message.params?.name;
    const input = message.params?.arguments ?? {};
    if (name === "delay") {
      return new Promise((resolve) => setTimeout(() => resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {content: [{type: "text", text: "delayed"}]},
      }), Number(input.delayMs ?? 250)));
    }
    if (name === "protocol_error") {
      return {jsonrpc: "2.0", id: message.id, error: {code: -32000, message: `fixture error ${secret}`}};
    }
    if (name === "tool_error") {
      return {jsonrpc: "2.0", id: message.id, result: {content: [{type: "text", text: "fixture failure"}], isError: true}};
    }
    const text = name === "secret_echo" ? secret : String(input.message ?? "hello-mcp");
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {type: "text", text},
          {type: "resource_link", uri: "fixture://resource", name: "fixture"},
        ],
        structuredContent: {
          echo: text,
          nested: {value: text},
          ...(emitSecretKeys && secret ? {[secret]: "structured-key"} : {}),
          ...(mode === "secret-key-collision" ? {"[redacted]": "collision"} : {}),
        },
        _meta: {
          fixtureSecretEcho: text,
          untouched: true,
          ...(emitSecretKeys && secret ? {[secret]: "result-metadata"} : {}),
        },
        isError: false,
      },
    };
  }
  return undefined;
}

async function responsesFor(body) {
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) {
    const response = await resultFor(message);
    if (response && message.id !== undefined) responses.push(response);
  }
  if (responses.length === 0) return undefined;
  return Array.isArray(body) ? responses : responses[0];
}

function writeStdio(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function spawnProcessTreeDescendant(inheritStdio = false) {
  const marker = process.env.FIXTURE_PROCESS_TREE_MARKER;
  const statePath = process.env.FIXTURE_PROCESS_TREE_STATE;
  if (!marker || !statePath) throw new Error("Process-tree fixture requires marker and state paths.");

  process.env.FIXTURE_PROCESS_TREE_PARENT_PID = String(process.pid);
  const script = `
    import {writeFileSync} from "node:fs";
    const marker = process.env.FIXTURE_PROCESS_TREE_MARKER;
    writeFileSync(process.env.FIXTURE_PROCESS_TREE_STATE, JSON.stringify({
      parentPid: Number(process.env.FIXTURE_PROCESS_TREE_PARENT_PID),
      descendantPid: process.pid,
      marker,
    }));
    process.title = marker;
    process.on("SIGTERM", () => {});
    process.send?.("ready");
    process.disconnect?.();
    setInterval(() => {}, 60_000);
  `;
  const descendant = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", inheritStdio ? "inherit" : "ignore", inheritStdio ? "inherit" : "ignore", "ipc"],
  });
  await once(descendant, "message");
  descendant.unref();
}

async function runStdio() {
  if (mode.startsWith("process-tree")) {
    await spawnProcessTreeDescendant(mode === "process-tree-leader-exit");
  }
  if (mode === "process-tree-leader-exit") return;
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    while (pending.includes("\n")) {
      const index = pending.indexOf("\n");
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      if (!line) continue;
      void (async () => {
        const message = JSON.parse(line);
        if (mode.endsWith("oversize-line") && message.method === "initialize") {
          process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
          return;
        }
        if (mode === "stderr-flood" && message.method === "tools/call") {
          if (!process.stderr.write("z".repeat(70 * 1024))) {
            await once(process.stderr, "drain");
          }
        }
        if (message.method === "tools/call" && message.params?.name === "secret_echo" && secret) {
          const split = Math.max(1, Math.floor(secret.length / 2));
          process.stderr.write(`stderr:${secret.slice(0, split)}`);
          await new Promise((resolve) => setImmediate(() => {
            process.stderr.write(`${secret.slice(split)}\n`);
            resolve();
          }));
        }
        const response = await resultFor(message);
        if (response && message.id !== undefined) writeStdio(response);
      })();
    }
  });
  await once(process.stdin, "end");
  if (mode === "process-tree-concurrent-close") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {"content-type": "application/json", ...headers});
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readForm(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function oauthBase(request) {
  return `http://${request.headers.host}`;
}

function issueOAuthTokens(response, rotatedFrom) {
  const accessToken = `access-${randomUUID()}`;
  const refreshToken = `refresh-${randomUUID()}`;
  oauthAccessTokens.add(accessToken);
  oauthRefreshTokens.add(refreshToken);
  if (rotatedFrom) oauthRefreshTokens.delete(rotatedFrom);
  oauthEvents.push({type: rotatedFrom ? "refresh" : "exchange", rotated: Boolean(rotatedFrom)});
  json(response, 200, {access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, scope: "resource:read"});
}

function record(request) {
  events.push({
    method: request.method,
    path: new URL(request.url ?? "/", "http://fixture").pathname,
    session: Boolean(request.headers["mcp-session-id"]),
    protocol: Boolean(request.headers["mcp-protocol-version"]),
    authorization: Boolean(request.headers.authorization),
    apiKey: Boolean(request.headers["x-api-key"]),
    lastEventId: Boolean(request.headers["last-event-id"]),
  });
}

async function runHttp() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const base = oauthBase(request);
    if (mode === "oauth" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(response, 200, {resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["resource:read"]});
      return;
    }
    if (mode === "oauth" && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
      json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["resource:read"],
      });
      return;
    }
    if (mode === "oauth" && url.pathname === "/oauth/register" && request.method === "POST") {
      const metadata = await readJson(request);
      const clientId = `client-${randomUUID()}`;
      oauthClients.set(clientId, metadata);
      oauthEvents.push({type: "register"});
      json(response, 201, {...metadata, client_id: clientId, token_endpoint_auth_method: "none"});
      return;
    }
    if (mode === "oauth" && url.pathname === "/oauth/authorize" && request.method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      if (!oauthClients.has(clientId) || !redirectUri || !codeChallenge || url.searchParams.get("code_challenge_method") !== "S256") {
        json(response, 400, {error: "invalid_request"});
        return;
      }
      const code = `code-${randomUUID()}`;
      oauthCodes.set(code, {clientId, redirectUri, codeChallenge});
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, {location: callback.toString()});
      response.end();
      return;
    }
    if (mode === "oauth" && url.pathname === "/oauth/token" && request.method === "POST") {
      const form = await readForm(request);
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code") ?? "";
        const stored = oauthCodes.get(code);
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!stored || stored.clientId !== form.get("client_id") || stored.redirectUri !== form.get("redirect_uri") || challenge !== stored.codeChallenge) {
          json(response, 400, {error: "invalid_grant"});
          return;
        }
        oauthCodes.delete(code);
        issueOAuthTokens(response);
        return;
      }
      if (form.get("grant_type") === "refresh_token") {
        const refreshToken = form.get("refresh_token") ?? "";
        if (!oauthRefreshTokens.has(refreshToken)) {
          json(response, 400, {error: "invalid_grant"});
          return;
        }
        issueOAuthTokens(response, refreshToken);
        return;
      }
      json(response, 400, {error: "unsupported_grant_type"});
      return;
    }
    if (mode === "oauth" && url.pathname === "/oauth/revoke" && request.method === "POST") {
      const form = await readForm(request);
      oauthAccessTokens.delete(form.get("token") ?? "");
      oauthRefreshTokens.delete(form.get("token") ?? "");
      oauthEvents.push({type: "revoke"});
      response.writeHead(200);
      response.end();
      return;
    }
    if (mode === "oauth" && url.pathname === "/oauth/expire" && request.method === "POST") {
      oauthAccessTokens.clear();
      oauthEvents.push({type: "expire"});
      json(response, 200, {ok: true});
      return;
    }
    if (mode === "oauth" && url.pathname === "/oauth/events") {
      json(response, 200, {events: oauthEvents});
      return;
    }
    if (url.pathname === "/events") {
      json(response, 200, {events});
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, {location: "/mcp"});
      response.end();
      return;
    }
    if (url.pathname === "/error") {
      response.writeHead(500, {"content-type": "text/plain"});
      response.end(`remote body ${secret}`);
      return;
    }
    if (url.pathname === "/auth") {
      response.writeHead(401, {"content-type": "application/json"});
      response.end(JSON.stringify({error: `unauthorized ${secret}`}));
      return;
    }
    if (url.pathname === "/invalid-content") {
      response.writeHead(200, {"content-type": "text/plain"});
      response.end(`not MCP ${secret}`);
      return;
    }
    if (url.pathname === "/invalid-json") {
      response.writeHead(200, {"content-type": "application/json"});
      response.end("{not-json");
      return;
    }
    if (url.pathname === "/oversize") {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(`{"padding":"${"x".repeat(8 * 1024 * 1024)}"}`);
      return;
    }
    record(request);
    if (url.pathname === "/mcp") {
      if (mode === "require-auth" && request.headers.authorization !== `Bearer ${secret}`) {
        json(response, 401, {error: "unauthorized"});
        return;
      }
      if (mode === "oauth" && !oauthAccessTokens.has(String(request.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        json(response, 401, {error: "unauthorized"}, {"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`});
        return;
      }
      const sessionId = String(request.headers["mcp-session-id"] ?? "");
      if (request.method === "DELETE") {
        sessions.delete(sessionId);
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const body = await readJson(request);
      const initialized = (Array.isArray(body) ? body : [body]).some((message) => message.method === "initialize");
      const resolvedSession = initialized ? randomUUID() : sessionId;
      if (initialized) {
        sessions.set(resolvedSession, true);
        if (mode === "session-expired") sessions.delete(resolvedSession);
      }
      if (!initialized && !sessions.has(resolvedSession)) {
        json(response, 404, {error: "unknown session"});
        return;
      }
      const value = await responsesFor(body);
      if (!value) {
        response.writeHead(202, {"mcp-session-id": resolvedSession});
        response.end();
        return;
      }
      json(response, 200, value, {"mcp-session-id": resolvedSession});
      return;
    }
    if (url.pathname === "/sse" && request.method === "GET") {
      const sessionId = randomUUID();
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sessions.set(sessionId, response);
      response.write(`event: endpoint\ndata: /messages?session=${sessionId}\n\n`);
      request.on("close", () => sessions.delete(sessionId));
      return;
    }
    if (url.pathname === "/messages" && request.method === "POST") {
      const stream = sessions.get(url.searchParams.get("session") ?? "");
      if (!stream || typeof stream.write !== "function") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = await readJson(request);
      const value = await responsesFor(body);
      if (value) stream.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  process.stdout.write(`READY ${JSON.stringify({port: address.port, mcp: `http://127.0.0.1:${address.port}/mcp`, sse: `http://127.0.0.1:${address.port}/sse`})}\n`);
  const close = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

if (transport === "stdio") await runStdio();
else if (transport === "http") await runHttp();
else throw new Error(`Unsupported fixture transport ${transport}`);
