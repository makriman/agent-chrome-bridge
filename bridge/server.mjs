import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOKEN_PATH = join(ROOT, ".bridge-token");
const PORT = Number(process.env.CODEX_CHROME_BRIDGE_PORT || 18474);
const HOST = "127.0.0.1";

const state = {
  startedAt: new Date().toISOString(),
  pending: [],
  results: {},
  latestExtensionState: null,
  events: []
};

async function loadToken() {
  try {
    return (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch (_) {
    await mkdir(ROOT, { recursive: true });
    const token = randomBytes(24).toString("hex");
    await writeFile(TOKEN_PATH, token, { mode: 0o600 });
    return token;
  }
}

const TOKEN = await loadToken();

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": `http://${HOST}:${PORT}`,
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
      button.secondary { background: white; color: #222; }
      button.danger { border-color: #b3261e; background: #b3261e; }
      input { min-width: 360px; padding: 8px; border: 1px solid #bbb; border-radius: 6px; }
      pre { background: white; border: 1px solid #dadce0; border-radius: 6px; padding: 12px; min-height: 300px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Codex Chrome Bridge</h1>
    <p>Use the CLI from Codex for tokenized control. This local page can show status only.</p>
    <button class="secondary" onclick="refresh()">Refresh status</button>
    <pre id="out">Loading...</pre>
    <script>
      async function refresh() {
        const response = await fetch('/status');
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

function queue(command) {
  const item = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...command
  };
  state.pending.push(item);
  state.events.push({ type: "queued", at: item.createdAt, command: item });
  state.events = state.events.slice(-250);
  console.log(`[bridge] queued ${item.type} ${item.id}`);
  return item;
}

function summarizeValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(summarizeValue);
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "dataUrl" && typeof item === "string") {
      copy[key] = `[${Math.round(item.length / 1024)}KB data URL omitted]`;
    } else {
      copy[key] = summarizeValue(item);
    }
  }
  return copy;
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

    if (req.method === "GET" && url.pathname === "/poll") {
      json(res, 200, state.pending.shift() || {});
      return;
    }

    if (req.method === "POST" && url.pathname === "/command") {
      if (!hasToken(req)) {
        json(res, 403, { ok: false, error: "Missing or invalid bridge token." });
        return;
      }
      const command = await body(req);
      if (!command.type) {
        json(res, 400, { ok: false, error: "Missing command type." });
        return;
      }
      json(res, 200, { ok: true, command: queue(command) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/event") {
      const event = await body(req);
      if (event.state) state.latestExtensionState = event.state;
      if (event.type === "command-result" && event.payload && event.payload.id) {
        state.results[event.payload.id] = event.payload;
      }
      state.events.push(summarizeValue({ ...event, receivedAt: new Date().toISOString() }));
      state.events = state.events.slice(-250);
      if (event.type !== "log") console.log(`[bridge] ${event.type || "event"}`);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/result") {
      if (!hasToken(req)) {
        json(res, 403, { ok: false, error: "Missing or invalid bridge token." });
        return;
      }
      const id = url.searchParams.get("id");
      json(res, 200, { ok: true, result: state.results[id] || null });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      json(res, 200, {
        ok: true,
        startedAt: state.startedAt,
        pending: state.pending,
        latestExtensionState: state.latestExtensionState,
        events: state.events.slice(-40)
      });
      return;
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] token file: ${TOKEN_PATH}`);
});
