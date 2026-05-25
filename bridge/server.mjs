import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_VERSION, COMMAND_STATUSES, PROTOCOL_VERSION } from "./protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOKEN_PATH = join(ROOT, ".bridge-token");
const TOKEN_META_PATH = join(ROOT, ".bridge-token.meta.json");
const PORT = Number(process.env.CODEX_CHROME_BRIDGE_PORT || 18474);
const HOST = "127.0.0.1";
const BRIDGE_INSTANCE_ID = `br_${randomUUID()}`;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_LEASE_GRACE_MS = 5000;
const MAX_EVENTS = 400;

const state = {
  bridgeInstanceId: BRIDGE_INSTANCE_ID,
  bridgeVersion: BRIDGE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  startedAt: new Date().toISOString(),
  tokenMeta: null,
  pendingIds: [],
  commands: new Map(),
  latestExtensionState: null,
  extension: {
    connected: false,
    lastHelloAt: null,
    lastPollAt: null,
    lastEventAt: null,
    extensionInstanceId: null,
    activeBridgeInstanceId: null
  },
  events: []
};

async function writeTokenMeta(token, tokenStat, reason) {
  const meta = {
    createdAt: new Date().toISOString(),
    reason,
    tokenPath: TOKEN_PATH,
    tokenMtimeMs: tokenStat ? tokenStat.mtimeMs : Date.now(),
    fingerprint: createHash("sha256").update(token).digest("hex").slice(0, 12)
  };
  await writeFile(TOKEN_META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

async function loadToken() {
  await mkdir(ROOT, { recursive: true });
  try {
    const existing = (await readFile(TOKEN_PATH, "utf8")).trim();
    if (existing.length >= 32) {
      const tokenStat = await stat(TOKEN_PATH);
      let meta;
      try {
        meta = JSON.parse(await readFile(TOKEN_META_PATH, "utf8"));
      } catch (_) {
        meta = await writeTokenMeta(existing, tokenStat, "metadata-created-for-existing-token");
      }
      return { token: existing, meta: { ...meta, tokenMtimeMs: tokenStat.mtimeMs } };
    }
  } catch (_) {
    // Missing, unreadable, or invalid token files are repaired below.
  }

  const token = randomBytes(32).toString("hex");
  await writeFile(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  const tokenStat = await stat(TOKEN_PATH);
  const meta = await writeTokenMeta(token, tokenStat, "generated");
  return { token, meta };
}

const { token: TOKEN, meta: TOKEN_META } = await loadToken();
state.tokenMeta = {
  ...TOKEN_META,
  bridgeInstanceId: BRIDGE_INSTANCE_ID
};

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-codex-bridge-token"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function html(res) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Codex Chrome Bridge</title>
    <style>
      body { margin: 24px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202124; background: #f8f7f3; }
      button { margin-right: 8px; padding: 8px 10px; border: 1px solid #222; border-radius: 6px; background: #222; color: white; cursor: pointer; }
      pre { background: white; border: 1px solid #dadce0; border-radius: 6px; padding: 12px; min-height: 300px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Codex Chrome Bridge</h1>
    <p>This local page shows public bridge liveness only. Use the CLI for token-authenticated command status.</p>
    <button onclick="refresh()">Refresh</button>
    <pre id="out">Loading...</pre>
    <script>
      async function refresh() {
        const response = await fetch('/public-status');
        document.getElementById('out').textContent = await response.text();
      }
      refresh();
      setInterval(refresh, 2000);
    </script>
  </body>
</html>`);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function hasToken(req) {
  return req.headers["x-codex-bridge-token"] === TOKEN;
}

function requireToken(req, res) {
  if (hasToken(req)) return true;
  json(res, 403, {
    ok: false,
    error: "Missing or invalid bridge token.",
    hint: "Run `node bridge/control.mjs doctor` from this repo. Restart the bridge if the token file changed."
  });
  return false;
}

function summarizeValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(summarizeValue);
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "dataUrl" && typeof item === "string") {
      copy[key] = `[${Math.round(item.length / 1024)}KB data URL omitted]`;
    } else if ((key === "url" || key === "frameUrl") && typeof item === "string") {
      copy[key] = sanitizeUrl(item);
    } else {
      copy[key] = summarizeValue(item);
    }
  }
  return copy;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return value;
  }
}

function pushEvent(event) {
  state.events.push(summarizeValue({ ...event, receivedAt: event.receivedAt || nowIso() }));
  state.events = state.events.slice(-MAX_EVENTS);
}

function commandSummary(command) {
  if (!command) return null;
  return summarizeValue({
    id: command.id,
    type: command.type,
    status: command.status,
    createdAt: command.createdAt,
    startedAt: command.startedAt,
    finishedAt: command.finishedAt,
    timeoutMs: command.timeoutMs,
    output: command.output,
    leaseExpiresAt: command.leaseExpiresAt,
    bridgeInstanceId: command.bridgeInstanceId,
    armSessionId: command.armSessionId,
    error: command.error,
    result: command.result,
    lifecycle: command.lifecycle
  });
}

function commandResult(command) {
  if (!command) return null;
  return {
    id: command.id,
    type: command.type,
    status: command.status,
    createdAt: command.createdAt,
    startedAt: command.startedAt,
    finishedAt: command.finishedAt,
    timeoutMs: command.timeoutMs,
    output: command.output,
    leaseExpiresAt: command.leaseExpiresAt,
    bridgeInstanceId: command.bridgeInstanceId,
    armSessionId: command.armSessionId,
    error: command.error,
    result: command.result,
    lifecycle: command.lifecycle
  };
}

function commandCounts(commands = Array.from(state.commands.values())) {
  const counts = Object.fromEntries(COMMAND_STATUSES.map((status) => [status, 0]));
  for (const command of commands) {
    if (!counts[command.status]) counts[command.status] = 0;
    counts[command.status] += 1;
  }
  return counts;
}

function queuePayload() {
  expireCommands();
  const commands = Array.from(state.commands.values());
  const active = commands
    .filter((command) => ["queued", "leased", "running"].includes(command.status))
    .map(commandSummary);
  const recentFailures = commands
    .filter((command) => ["failed", "timed_out", "stale_arm"].includes(command.status))
    .slice(-20)
    .map(commandSummary);
  return {
    ok: true,
    counts: commandCounts(commands),
    active,
    recentFailures,
    pending: state.pendingIds.map((id) => commandSummary(state.commands.get(id))).filter(Boolean),
    commands: commands.slice(-100).map(commandSummary)
  };
}

function activeArmSessionId() {
  return state.latestExtensionState && state.latestExtensionState.armed
    ? state.latestExtensionState.armed.armSessionId
    : null;
}

function mark(command, status, fields = {}) {
  command.status = status;
  command.lifecycle.push({ status, at: nowIso(), ...(fields.reason ? { reason: fields.reason } : {}) });
  Object.assign(command, fields);
  pushEvent({ type: `command-${status}`, command: commandSummary(command) });
}

function expireCommands() {
  const now = nowMs();
  for (const command of state.commands.values()) {
    if (!["queued", "leased", "running"].includes(command.status)) continue;
    const leaseExpired = command.leaseExpiresAt && command.leaseExpiresAt <= now;
    const totalExpired = command.deadlineAt && command.deadlineAt <= now;
    if (leaseExpired || totalExpired) {
      state.pendingIds = state.pendingIds.filter((id) => id !== command.id);
      mark(command, "timed_out", {
        finishedAt: nowIso(),
        error: totalExpired ? "Command timed out." : "Command lease expired before a result was posted."
      });
    }
  }
}

function queue(command) {
  expireCommands();
  const createdAt = nowIso();
  const id = command.id || `cmd_${randomUUID()}`;
  const timeoutMs = Math.max(1, Number(command.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS));
  const item = {
    ...command,
    id,
    type: command.type || command.op,
    op: command.op || command.type,
    createdAt,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    armSessionId: command.armSessionId || activeArmSessionId(),
    timeoutMs,
    deadlineAt: nowMs() + timeoutMs + DEFAULT_LEASE_GRACE_MS,
    status: "queued",
    lifecycle: [{ status: "queued", at: createdAt }]
  };
  state.commands.set(item.id, item);
  state.pendingIds.push(item.id);
  pushEvent({ type: "queued", command: commandSummary(item) });
  console.log(`[bridge] queued ${item.type} ${item.id}`);
  return item;
}

function leaseNextCommand(query) {
  expireCommands();
  const extensionArmSessionId = query.searchParams.get("armSessionId") || null;
  state.extension.lastPollAt = nowIso();
  state.extension.connected = true;
  state.extension.extensionInstanceId = query.searchParams.get("extensionInstanceId") || state.extension.extensionInstanceId;
  state.extension.activeBridgeInstanceId = query.searchParams.get("bridgeInstanceId") || state.extension.activeBridgeInstanceId;

  while (state.pendingIds.length > 0) {
    const id = state.pendingIds.shift();
    const command = state.commands.get(id);
    if (!command || command.status !== "queued") continue;
    if (command.armSessionId && extensionArmSessionId && command.armSessionId !== extensionArmSessionId) {
      mark(command, "stale_arm", {
        finishedAt: nowIso(),
        error: `Command targeted stale arm session ${command.armSessionId}. Active extension session is ${extensionArmSessionId}.`
      });
      continue;
    }
    const leasedAt = nowIso();
    command.startedAt = leasedAt;
    command.leaseExpiresAt = nowMs() + command.timeoutMs + DEFAULT_LEASE_GRACE_MS;
    mark(command, "leased", { startedAt: leasedAt });
    return command;
  }
  return null;
}

function updateFromEvent(event) {
  state.extension.lastEventAt = nowIso();
  if (event.state) state.latestExtensionState = event.state;
  if (event.payload && event.payload.extensionInstanceId) {
    state.extension.extensionInstanceId = event.payload.extensionInstanceId;
  }
  if (event.payload && event.payload.bridgeInstanceId) {
    state.extension.activeBridgeInstanceId = event.payload.bridgeInstanceId;
  }
  if (event.type === "hello") {
    state.extension.connected = true;
    state.extension.lastHelloAt = nowIso();
  }
  if (event.type === "arm-state" || event.type === "armed" || event.type === "disarmed") {
    state.extension.connected = true;
  }
  if (event.type === "command-start" && event.payload && event.payload.id) {
    const command = state.commands.get(event.payload.id);
    if (command && ["leased", "queued"].includes(command.status)) {
      mark(command, "running", { startedAt: command.startedAt || nowIso() });
    }
  }
  if (event.type === "command-heartbeat" && event.payload && event.payload.id) {
    const command = state.commands.get(event.payload.id);
    if (command && ["leased", "running"].includes(command.status)) {
      command.leaseExpiresAt = nowMs() + command.timeoutMs + DEFAULT_LEASE_GRACE_MS;
      command.lifecycle.push({ status: "heartbeat", at: nowIso() });
    }
  }
  if (event.type === "command-result" && event.payload && event.payload.id) {
    const command = state.commands.get(event.payload.id) || {
      id: event.payload.id,
      type: event.payload.type || "unknown",
      createdAt: event.payload.startedAt || nowIso(),
      bridgeInstanceId: BRIDGE_INSTANCE_ID,
      lifecycle: []
    };
    const status = event.payload.status || (event.payload.ok === false ? "failed" : "succeeded");
    mark(command, status, {
      finishedAt: event.payload.finishedAt || event.payload.at || nowIso(),
      result: event.payload.result || null,
      error: event.payload.error || null
    });
    state.commands.set(command.id, command);
  }
}

function statusPayload({ publicOnly = false } = {}) {
  expireCommands();
  const pending = state.pendingIds
    .map((id) => state.commands.get(id))
    .filter(Boolean)
    .map(commandSummary);
  const recentCommands = Array.from(state.commands.values()).slice(-40).map(commandSummary);
  const activeCommand = Array.from(state.commands.values())
    .reverse()
    .find((command) => ["leased", "running"].includes(command.status));
  const base = {
    ok: true,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: state.startedAt,
    connected: state.extension.connected,
    lastPollAt: state.extension.lastPollAt,
    lastEventAt: state.extension.lastEventAt,
    activeBridgeInstanceId: state.extension.activeBridgeInstanceId,
    tokenFingerprint: state.tokenMeta.fingerprint,
    pendingCount: pending.length,
    activeCommand: commandSummary(activeCommand),
    counts: commandCounts()
  };
  if (publicOnly) return base;
  return {
    ...base,
    tokenMeta: state.tokenMeta,
    extension: state.extension,
    capabilities: state.latestExtensionState ? state.latestExtensionState.capabilities || null : null,
    latestExtensionState: summarizeValue(state.latestExtensionState),
    pending,
    recentCommands,
    events: state.events.slice(-60)
  };
}

function flushCommands() {
  expireCommands();
  let count = 0;
  for (const id of state.pendingIds) {
    const command = state.commands.get(id);
    if (command && command.status === "queued") {
      count += 1;
      mark(command, "cancelled", { finishedAt: nowIso(), error: "Flushed before pickup." });
    }
  }
  state.pendingIds = [];
  return count;
}

function cancelCommand(id) {
  expireCommands();
  const command = state.commands.get(id);
  if (!command) return null;
  if (["succeeded", "failed", "timed_out", "cancelled", "stale_arm"].includes(command.status)) {
    return command;
  }
  state.pendingIds = state.pendingIds.filter((pendingId) => pendingId !== id);
  mark(command, "cancelled", { finishedAt: nowIso(), error: "Cancelled by client." });
  return command;
}

async function doctorPayload() {
  let tokenFile = null;
  try {
    const tokenStat = await stat(TOKEN_PATH);
    const tokenText = (await readFile(TOKEN_PATH, "utf8")).trim();
    tokenFile = {
      exists: true,
      length: tokenText.length,
      validLength: tokenText.length >= 32,
      mtimeMs: tokenStat.mtimeMs,
      fingerprint: tokenText ? createHash("sha256").update(tokenText).digest("hex").slice(0, 12) : null,
      matchesRunningBridge: tokenText === TOKEN
    };
  } catch (error) {
    tokenFile = { exists: false, error: error.message };
  }
  return {
    ...statusPayload(),
    doctor: {
      tokenPath: TOKEN_PATH,
      tokenMetaPath: TOKEN_META_PATH,
      tokenFile,
      bridgeTokenFingerprint: state.tokenMeta.fingerprint,
      capabilities: state.latestExtensionState ? state.latestExtensionState.capabilities || null : null,
      commandRoundTripHint: "Run `node bridge/control.mjs raw '{\"type\":\"status\"}'` to verify the extension command path."
    }
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      json(res, 200, { ok: true });
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/") {
      html(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/hello") {
      json(res, 200, {
        ok: true,
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        startedAt: state.startedAt
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/public-status") {
      json(res, 200, statusPayload({ publicOnly: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      const command = leaseNextCommand(url);
      json(res, 200, command || {});
      return;
    }

    if (req.method === "POST" && url.pathname === "/command") {
      if (!requireToken(req, res)) return;
      const command = await body(req);
      if (!command.type && !command.op) {
        json(res, 400, { ok: false, error: "Missing command type/op." });
        return;
      }
      json(res, 200, { ok: true, command: commandSummary(queue(command)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/event") {
      const event = await body(req);
      updateFromEvent(event);
      pushEvent({ ...event, state: event.state ? summarizeValue(event.state) : undefined });
      if (event.type !== "log" && event.type !== "command-heartbeat") {
        console.log(`[bridge] ${event.type || "event"}`);
      }
      json(res, 200, { ok: true, bridgeInstanceId: BRIDGE_INSTANCE_ID });
      return;
    }

    if (req.method === "GET" && url.pathname === "/result") {
      if (!requireToken(req, res)) return;
      expireCommands();
      const id = url.searchParams.get("id");
      const command = state.commands.get(id);
      json(res, 200, {
        ok: true,
        command: commandResult(command),
        status: command ? command.status : "unknown"
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/queue") {
      if (!requireToken(req, res)) return;
      json(res, 200, queuePayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/flush") {
      if (!requireToken(req, res)) return;
      json(res, 200, { ok: true, flushed: flushCommands() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/cancel") {
      if (!requireToken(req, res)) return;
      const payload = await body(req);
      const command = cancelCommand(payload.id);
      json(res, command ? 200 : 404, { ok: Boolean(command), command: commandSummary(command) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      if (!requireToken(req, res)) return;
      json(res, 200, statusPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/doctor") {
      if (!requireToken(req, res)) return;
      json(res, 200, await doctorPayload());
      return;
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] instance: ${BRIDGE_INSTANCE_ID}`);
  console.log(`[bridge] token file: ${TOKEN_PATH}`);
  console.log(`[bridge] token fingerprint: ${state.tokenMeta.fingerprint}`);
});
