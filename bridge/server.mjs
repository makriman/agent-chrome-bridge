import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_VERSION, COMMAND_STATUSES, PROTOCOL_VERSION, TERMINAL_STATUSES } from "./protocol.mjs";
import { chmodOwnerOnly, secretEquals } from "./token-file.mjs";
import { pairedSessionHeaders, sessionProofHex, validProofNonce } from "../extension/extension-credential.mjs";
import { boundScreenshotResult, MAX_JSON_BODY_BYTES, MAX_SCREENSHOT_CHARS, releaseScreenshotResult } from "../extension/resource-bounds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const HOST = "127.0.0.1";
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_LEASE_GRACE_MS = 5000;
const MAX_EVENTS = 400;
const PAIR_TICKET_TTL_MS = 2 * 60 * 1000;
const MAX_PAIR_TICKETS = 20;
const PAIR_BODY_LIMIT = 4096;
const TERMINAL = new Set(TERMINAL_STATUSES);

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (_) {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function capLeaseExpiresAt(command, now) {
  const uncapped = now + Number(command.timeoutMs || 0) + DEFAULT_LEASE_GRACE_MS;
  if (!Number.isFinite(command.deadlineAt)) return uncapped;
  return Math.min(uncapped, command.deadlineAt);
}

function headerValue(req, name) {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function hostAllowed(req, port) {
  const host = String(req.headers.host || "").trim().toLowerCase();
  const expectedPort = String(port);
  return host === `127.0.0.1:${expectedPort}` || host === `localhost:${expectedPort}`;
}

function validExtensionInstanceId(value) {
  return typeof value === "string" && /^ext_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function writeSecretMeta(filePath, metaPath, token, tokenStat, reason, extra = {}) {
  const meta = {
    createdAt: new Date().toISOString(),
    reason,
    tokenPath: filePath,
    tokenMtimeMs: tokenStat ? tokenStat.mtimeMs : Date.now(),
    fingerprint: createHash("sha256").update(token).digest("hex").slice(0, 12),
    ...extra
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  try {
    await chmod(metaPath, 0o600);
  } catch (_) {
    // Mode is best-effort when the filesystem ignores it.
  }
  return meta;
}

async function loadSecretFile(filePath, metaPath) {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= 32) {
      const tokenStat = await stat(filePath);
      await chmodOwnerOnly(filePath);
      let meta;
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8"));
      } catch (_) {
        meta = await writeSecretMeta(filePath, metaPath, existing, tokenStat, "metadata-created-for-existing-token");
      }
      return { token: existing, meta: { ...meta, tokenMtimeMs: tokenStat.mtimeMs } };
    }
  } catch (_) {
    // Missing, unreadable, or invalid token files are repaired below.
  }

  const token = randomBytes(32).toString("hex");
  await writeFile(filePath, `${token}\n`, { mode: 0o600 });
  try {
    await chmod(filePath, 0o600);
  } catch (_) {
    // Mode is best-effort when the filesystem ignores it.
  }
  const tokenStat = await stat(filePath);
  const meta = await writeSecretMeta(filePath, metaPath, token, tokenStat, "generated");
  return { token, meta };
}

function json(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload, null, 2));
}

function html(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

async function readBody(req, limit = MAX_JSON_BODY_BYTES) {
  const declared = Number(req.headers["content-length"] || 0);
  if (limit && Number.isFinite(declared) && declared > limit) {
    const error = new Error(`Request body exceeds ${limit} bytes.`);
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (limit && size > limit) {
      const error = new Error(`Request body exceeds ${limit} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
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
    } else if (key === "extensionToken" || key === "ticket") {
      copy[key] = "[redacted]";
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

export async function startBridge(options = {}) {
  const port = options.port === undefined
    ? Number(process.env.AGENT_CHROME_BRIDGE_PORT || process.env.CODEX_CHROME_BRIDGE_PORT || 18474)
    : options.port;
  const root = options.root || ROOT;
  const tokenPath = join(root, ".bridge-token");
  const tokenMetaPath = join(root, ".bridge-token.meta.json");
  const extensionTokenPath = join(root, ".bridge-extension-session");
  const extensionTokenMetaPath = join(root, ".bridge-extension-session.meta.json");
  const quiet = options.quiet !== false;
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes) ? options.maxBodyBytes : MAX_JSON_BODY_BYTES;
  const maxScreenshotChars = Number.isFinite(options.maxScreenshotChars) ? options.maxScreenshotChars : MAX_SCREENSHOT_CHARS;
  const bridgeInstanceId = `br_${randomUUID()}`;
  const { token: operatorToken, meta: operatorMeta } = await loadSecretFile(tokenPath, tokenMetaPath);
  const { token: extensionToken, meta: extensionMeta } = await loadSecretFile(extensionTokenPath, extensionTokenMetaPath);
  const pairTickets = new Map();

  const state = {
    bridgeInstanceId,
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: nowIso(),
    tokenMeta: { ...operatorMeta, bridgeInstanceId },
    extensionTokenMeta: extensionMeta,
    pairedExtensionInstanceId: validExtensionInstanceId(extensionMeta.pairedExtensionInstanceId)
      ? extensionMeta.pairedExtensionInstanceId
      : null,
    pendingIds: [],
    commands: new Map(),
    latestExtensionState: null,
    extension: {
      connected: false,
      lastHelloAt: null,
      lastPollAt: null,
      lastEventAt: null,
      extensionInstanceId: validExtensionInstanceId(extensionMeta.pairedExtensionInstanceId)
        ? extensionMeta.pairedExtensionInstanceId
        : null,
      activeBridgeInstanceId: null
    },
    events: []
  };

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
      deadlineAt: command.deadlineAt,
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
      deadlineAt: command.deadlineAt,
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
      bridgeInstanceId,
      armSessionId: command.armSessionId || activeArmSessionId(),
      timeoutMs,
      deadlineAt: nowMs() + timeoutMs + DEFAULT_LEASE_GRACE_MS,
      status: "queued",
      lifecycle: [{ status: "queued", at: createdAt }]
    };
    state.commands.set(item.id, item);
    state.pendingIds.push(item.id);
    pushEvent({ type: "queued", command: commandSummary(item) });
    if (!quiet) console.log(`[bridge] queued ${item.type} ${item.id}`);
    return item;
  }

  function retainScreenshot(command, result) {
    if (!result || typeof result.dataUrl !== "string" || !result.dataUrl.startsWith("data:")) return result;
    for (const other of state.commands.values()) {
      if (other === command || !other.result || typeof other.result.dataUrl !== "string") continue;
      if (!other.result.dataUrl.startsWith("data:")) continue;
      other.result = releaseScreenshotResult(other.result);
    }
    return result;
  }

  function leaseNextCommand(query) {
    expireCommands();
    const extensionArmSessionId = query.searchParams.get("armSessionId") || null;
    state.extension.lastPollAt = nowIso();
    state.extension.connected = true;
    state.extension.extensionInstanceId = state.pairedExtensionInstanceId;
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
      command.leaseExpiresAt = capLeaseExpiresAt(command, nowMs());
      mark(command, "leased", { startedAt: leasedAt });
      return command;
    }
    return null;
  }

  function updateFromEvent(event) {
    state.extension.lastEventAt = nowIso();
    state.extension.connected = true;
    state.extension.extensionInstanceId = state.pairedExtensionInstanceId;
    if (event.payload && event.payload.bridgeInstanceId) {
      state.extension.activeBridgeInstanceId = event.payload.bridgeInstanceId;
    }
    if (event.state && typeof event.state === "object") state.latestExtensionState = event.state;
    if (event.type === "hello") state.extension.lastHelloAt = nowIso();
    if (event.type === "arm-state" || event.type === "armed" || event.type === "disarmed") {
      state.extension.connected = true;
    }

    const payload = event.payload || {};
    if ((event.type === "command-start" || event.type === "command-heartbeat" || event.type === "command-result") && payload.id) {
      const command = state.commands.get(payload.id);
      if (!command) return { ok: false, statusCode: 404, error: "Unknown command id." };
      if (TERMINAL.has(command.status)) {
        return { ok: true, ignored: true, reason: "terminal", status: command.status };
      }
      if (!["leased", "running"].includes(command.status)) {
        return { ok: true, ignored: true, reason: "not-leased", status: command.status };
      }
      if (event.type === "command-start") {
        mark(command, "running", { startedAt: command.startedAt || nowIso() });
        return { ok: true, status: command.status };
      }
      if (event.type === "command-heartbeat") {
        command.leaseExpiresAt = capLeaseExpiresAt(command, nowMs());
        command.lifecycle.push({ status: "heartbeat", at: nowIso() });
        return { ok: true, leaseExpiresAt: command.leaseExpiresAt, deadlineAt: command.deadlineAt };
      }
      const status = payload.status || (payload.ok === false ? "failed" : "succeeded");
      if (!TERMINAL.has(status)) {
        return { ok: false, statusCode: 400, error: "Result status must be terminal." };
      }
      const result = retainScreenshot(command, boundScreenshotResult(payload.result || null, maxScreenshotChars));
      mark(command, status, {
        finishedAt: payload.finishedAt || payload.at || nowIso(),
        result,
        error: payload.error || null
      });
      return { ok: true, status };
    }
    return { ok: true };
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
      bridgeInstanceId,
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
    if (publicOnly) {
      const { tokenFingerprint, activeCommand, ...liveness } = base;
      return liveness;
    }
    return {
      ...base,
      extensionPaired: Boolean(state.pairedExtensionInstanceId),
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
    if (TERMINAL.has(command.status)) return command;
    state.pendingIds = state.pendingIds.filter((pendingId) => pendingId !== id);
    mark(command, "cancelled", { finishedAt: nowIso(), error: "Cancelled by client." });
    return command;
  }

  function hasOperatorToken(req) {
    return secretEquals(headerValue(req, "x-codex-bridge-token"), operatorToken);
  }

  function hasExtensionToken(req) {
    return secretEquals(headerValue(req, "x-codex-bridge-extension-token"), extensionToken);
  }

  function extensionSessionMatches(extensionInstanceId) {
    return Boolean(state.pairedExtensionInstanceId) && extensionInstanceId === state.pairedExtensionInstanceId;
  }

  function requireOperatorToken(req, res) {
    if (hasOperatorToken(req)) return true;
    json(res, 403, {
      ok: false,
      error: "Missing or invalid bridge token.",
      hint: "Run `node bridge/control.mjs doctor` from this repo. Restart the bridge if the token file changed."
    });
    return false;
  }

  function rejectExtension(res) {
    json(res, 403, {
      ok: false,
      error: "Missing or invalid extension session.",
      hint: "Run `node bridge/control.mjs pair`, then paste the code into the extension popup."
    });
  }

  function createPairTicket() {
    const now = nowMs();
    for (const [ticket, entry] of pairTickets) {
      if (entry.expiresAt <= now) pairTickets.delete(ticket);
    }
    while (pairTickets.size >= MAX_PAIR_TICKETS) {
      const oldest = pairTickets.keys().next().value;
      pairTickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("hex");
    const expiresAtMs = now + PAIR_TICKET_TTL_MS;
    pairTickets.set(ticket, { expiresAt: expiresAtMs });
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  function takePairTicket(ticket) {
    if (typeof ticket !== "string") return false;
    const normalized = ticket.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) return false;
    const entry = pairTickets.get(normalized);
    if (!entry) return false;
    pairTickets.delete(normalized);
    return entry.expiresAt > nowMs();
  }

  async function rememberPairedExtension(extensionInstanceId) {
    state.pairedExtensionInstanceId = extensionInstanceId;
    state.extension.extensionInstanceId = extensionInstanceId;
    const meta = {
      ...state.extensionTokenMeta,
      pairedExtensionInstanceId: extensionInstanceId,
      pairedAt: nowIso(),
      tokenPath: extensionTokenPath,
      fingerprint: state.extensionTokenMeta.fingerprint
    };
    state.extensionTokenMeta = meta;
    await writeFile(extensionTokenMetaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
    try {
      await chmod(extensionTokenMetaPath, 0o600);
    } catch (_) {
      // Mode is best-effort when the filesystem ignores it.
    }
  }

  async function doctorPayload() {
    let tokenFile = null;
    try {
      const tokenStat = await stat(tokenPath);
      const tokenText = (await readFile(tokenPath, "utf8")).trim();
      tokenFile = {
        exists: true,
        length: tokenText.length,
        validLength: tokenText.length >= 32,
        mtimeMs: tokenStat.mtimeMs,
        fingerprint: tokenText ? createHash("sha256").update(tokenText).digest("hex").slice(0, 12) : null,
        matchesRunningBridge: secretEquals(tokenText, operatorToken)
      };
    } catch (error) {
      tokenFile = { exists: false, error: error.message };
    }
    return {
      ...statusPayload(),
      doctor: {
        tokenPath,
        tokenMetaPath,
        tokenFile,
        bridgeTokenFingerprint: state.tokenMeta.fingerprint,
        extensionSession: {
          paired: Boolean(state.pairedExtensionInstanceId),
          extensionInstanceId: state.pairedExtensionInstanceId,
          fingerprint: state.extensionTokenMeta.fingerprint || null,
          header: "x-codex-bridge-extension-token",
          storage: "chrome.storage.session",
          pairCommand: "node bridge/control.mjs pair"
        },
        listen: {
          host: HOST,
          port: server.address() && typeof server.address() === "object" ? server.address().port : port,
          pinned: HOST === "127.0.0.1" && (server.address() && server.address().port) === 18474
        },
        commandRoundTripHint: state.pairedExtensionInstanceId
          ? "Run `node bridge/control.mjs raw '{\"type\":\"status\"}'` to verify the extension command path."
          : "Extension is not paired. Run `node bridge/control.mjs pair`, paste the code into the popup, then arm a tab."
      }
    };
  }

  function statusPage() {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Agent Chrome Bridge</title>
    <style>
      body { margin: 24px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202124; background: #f8f7f3; }
      button { margin-right: 8px; padding: 8px 10px; border: 1px solid #222; border-radius: 6px; background: #222; color: white; cursor: pointer; }
      pre { background: white; border: 1px solid #dadce0; border-radius: 6px; padding: 12px; min-height: 300px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Agent Chrome Bridge</h1>
    <p>Give Grok Bot and other agents your Chrome. This local page shows public bridge liveness only. Pair the extension before commands can move, and use the CLI for authenticated command status.</p>
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
</html>`;
  }

  function pairPage() {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Pair Agent Chrome Bridge</title>
    <style>
      body { margin: 24px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202124; background: #f8f7f3; }
      code { display: block; margin: 12px 0; padding: 12px; background: white; border: 1px solid #dadce0; border-radius: 6px; word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>Pair the extension</h1>
    <p>This page does not receive the pairing code from the server. The code stays in the URL fragment. Open the extension popup and click <strong>Pair from tab</strong>, or paste the code.</p>
    <code id="code">Waiting for code…</code>
    <script>
      const ticket = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
      document.getElementById("code").textContent = ticket || "No pairing code in this page. Run node bridge/control.mjs pair and open the printed URL.";
    </script>
  </body>
</html>`;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req, server.address() ? server.address().port : port)) {
        json(res, 403, { ok: false, error: "Rejected host." });
        return;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${HOST}:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        html(res, statusPage());
        return;
      }

      if (req.method === "GET" && url.pathname === "/pair") {
        html(res, pairPage());
        return;
      }

      if (req.method === "GET" && url.pathname === "/hello") {
        json(res, 200, {
          ok: true,
          bridgeInstanceId,
          bridgeVersion: BRIDGE_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          startedAt: state.startedAt,
          tokenFingerprint: state.tokenMeta.fingerprint
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/session-proof") {
        const nonce = (url.searchParams.get("nonce") || "").trim().toLowerCase();
        if (!validProofNonce(nonce)) {
          json(res, 400, { ok: false, error: "Nonce must be 32-128 hex characters." });
          return;
        }
        json(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          bridgeInstanceId,
          tokenFingerprint: state.tokenMeta.fingerprint,
          proof: await sessionProofHex(extensionToken, nonce)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/public-status") {
        json(res, 200, statusPayload({ publicOnly: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/pair/start") {
        if (!requireOperatorToken(req, res)) return;
        await readBody(req, PAIR_BODY_LIMIT);
        const created = createPairTicket();
        json(res, 200, {
          ok: true,
          ticket: created.ticket,
          expiresAt: created.expiresAt,
          pairPath: "/pair"
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/pair/redeem") {
        const payload = await readBody(req, PAIR_BODY_LIMIT);
        const extensionInstanceId = payload.extensionInstanceId;
        if (!validExtensionInstanceId(extensionInstanceId) || !takePairTicket(payload.ticket)) {
          json(res, 403, { ok: false, error: "Pairing code is invalid or expired." });
          return;
        }
        await rememberPairedExtension(extensionInstanceId);
        if (!quiet) console.log("[bridge] extension paired");
        json(res, 200, {
          ok: true,
          extensionToken,
          bridgeInstanceId,
          operatorFingerprint: state.tokenMeta.fingerprint,
          expiresAt: null
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/poll") {
        const extensionInstanceId = url.searchParams.get("extensionInstanceId") || "";
        if (!hasExtensionToken(req) || !extensionSessionMatches(extensionInstanceId)) {
          rejectExtension(res);
          return;
        }
        const command = leaseNextCommand(url);
        json(res, 200, command || {}, pairedSessionHeaders(PROTOCOL_VERSION, bridgeInstanceId));
        return;
      }

      if (req.method === "POST" && url.pathname === "/command") {
        if (!requireOperatorToken(req, res)) return;
        const command = await readBody(req, maxBodyBytes);
        if (!command.type && !command.op) {
          json(res, 400, { ok: false, error: "Missing command type/op." });
          return;
        }
        json(res, 200, { ok: true, command: commandSummary(queue(command)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/event") {
        if (!hasExtensionToken(req)) {
          rejectExtension(res);
          return;
        }
        const event = await readBody(req, maxBodyBytes);
        const extensionInstanceId = event && event.payload ? event.payload.extensionInstanceId : "";
        if (!extensionSessionMatches(extensionInstanceId)) {
          rejectExtension(res);
          return;
        }
        const result = updateFromEvent(event || {});
        if (result.ok !== false) {
          pushEvent({ ...event, state: event.state ? summarizeValue(event.state) : undefined });
          if (event.type !== "log" && event.type !== "command-heartbeat" && !quiet) {
            console.log(`[bridge] ${event.type || "event"}`);
          }
        }
        json(res, result.statusCode || 200, {
          ok: result.ok !== false,
          bridgeInstanceId,
          ignored: result.ignored || false,
          reason: result.reason,
          status: result.status,
          error: result.error,
          leaseExpiresAt: result.leaseExpiresAt,
          deadlineAt: result.deadlineAt
        }, pairedSessionHeaders(PROTOCOL_VERSION, bridgeInstanceId));
        return;
      }

      if (req.method === "GET" && url.pathname === "/result") {
        if (!requireOperatorToken(req, res)) return;
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
        if (!requireOperatorToken(req, res)) return;
        json(res, 200, queuePayload());
        return;
      }

      if (req.method === "POST" && url.pathname === "/flush") {
        if (!requireOperatorToken(req, res)) return;
        json(res, 200, { ok: true, flushed: flushCommands() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/cancel") {
        if (!requireOperatorToken(req, res)) return;
        const payload = await readBody(req, maxBodyBytes);
        const command = cancelCommand(payload.id);
        json(res, command ? 200 : 404, { ok: Boolean(command), command: commandSummary(command) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/status") {
        if (!requireOperatorToken(req, res)) return;
        json(res, 200, statusPayload());
        return;
      }

      if (req.method === "GET" && url.pathname === "/doctor") {
        if (!requireOperatorToken(req, res)) return;
        json(res, 200, await doctorPayload());
        return;
      }

      json(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      json(res, statusCode, { ok: false, error: error.message });
      if (statusCode === 413) res.on("finish", () => req.destroy());
    }
  });

  server.requestTimeout = Number.isFinite(options.requestTimeout) ? options.requestTimeout : 30_000;
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const boundPort = server.address().port;
  if (!quiet) {
    console.log(`[bridge] listening on http://${HOST}:${boundPort}`);
    console.log(`[bridge] instance: ${bridgeInstanceId}`);
    console.log(`[bridge] token file: ${tokenPath}`);
    console.log(`[bridge] token fingerprint: ${state.tokenMeta.fingerprint}`);
    console.log(`[bridge] extension session fingerprint: ${state.extensionTokenMeta.fingerprint}`);
  }

  return {
    port: boundPort,
    token: operatorToken,
    extensionToken,
    bridgeInstanceId,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

if (invokedDirectly()) {
  await startBridge({ quiet: false });
}
