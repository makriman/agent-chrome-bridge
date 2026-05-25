import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_VERSION, PROTOCOL_VERSION, TERMINAL_STATUSES as TERMINAL_STATUS_LIST } from "./protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOKEN_PATH = join(ROOT, ".bridge-token");
const BRIDGE_URL = process.env.CODEX_CHROME_BRIDGE_URL || "http://127.0.0.1:18474";
const TERMINAL_STATUSES = new Set(TERMINAL_STATUS_LIST);

const action = process.argv[2] || "status";

function usage() {
  console.error(`Usage:
  node bridge/control.mjs status
  node bridge/control.mjs doctor
  node bridge/control.mjs queue
  node bridge/control.mjs flush
  node bridge/control.mjs cancel <command-id>
  node bridge/control.mjs resume
  node bridge/control.mjs inspect [limit]
  node bridge/control.mjs click <x> <y>
  node bridge/control.mjs click-ref <ref>
  node bridge/control.mjs click-text "Text" [--exact] [--index N]
  node bridge/control.mjs click-selector "button.primary" [--index N]
  node bridge/control.mjs dblclick <x> <y>
  node bridge/control.mjs move <x> <y>
  node bridge/control.mjs scroll [deltaY]
  node bridge/control.mjs fill-ref <ref> "Text to set"
  node bridge/control.mjs type "Text to insert"
  node bridge/control.mjs key Enter [Meta,Shift]
  node bridge/control.mjs wait-for text "Ready"
  node bridge/control.mjs wait-for selector ".done"
  node bridge/control.mjs wait-for url "/dashboard"
  node bridge/control.mjs nav "https://example.com/path"
  node bridge/control.mjs reload
  node bridge/control.mjs back
  node bridge/control.mjs forward
  node bridge/control.mjs screenshot [output.png]
  node bridge/control.mjs wait 1000
  node bridge/control.mjs stop
  node bridge/control.mjs raw '{"type":"click","x":400,"y":300}'

Options:
  --timeout <ms>    Command timeout, default 30000.
  --jsonl           Print lifecycle events while waiting.`);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function flagValue(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positionalArgs() {
  const args = [];
  for (let index = 3; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--exact" || value === "--jsonl") continue;
    if (value === "--index" || value === "--timeout") {
      index += 1;
      continue;
    }
    args.push(value);
  }
  return args;
}

function numberArg(index, label) {
  const value = Number(process.argv[index]);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected numeric ${label}.`);
  }
  return value;
}

async function token() {
  let value = "";
  try {
    value = (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch (_) {
    await mkdir(ROOT, { recursive: true });
    await writeFile(TOKEN_PATH, "", { mode: 0o600 });
  }
  if (value.length < 32) {
    throw new Error(
      "Bridge token is missing or invalid. Start/restart the bridge with `npm run bridge` so it can repair `.bridge-token`."
    );
  }
  return value;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token !== false) {
    headers["x-codex-bridge-token"] = await token();
  }
  const response = await fetch(`${BRIDGE_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = { ok: false, error: text || response.statusText };
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || response.statusText);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function assertProtocol(payload) {
  if (!payload || payload.protocolVersion === undefined) {
    throw new Error(
      `The running bridge looks stale or too old for this CLI. Restart it with: lsof -ti tcp:18474 | xargs -r kill && npm run bridge`
    );
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `The bridge process is running protocol v${payload.protocolVersion}, but this CLI expects v${PROTOCOL_VERSION}. Restart it with: lsof -ti tcp:18474 | xargs -r kill && npm run bridge`
    );
  }
}

async function bridgeHello() {
  try {
    const payload = await request("/hello", { token: false });
    assertProtocol(payload);
    return payload;
  } catch (error) {
    throw new Error(
      `The running bridge did not answer the current protocol check (${error.message}). Restart it with: lsof -ti tcp:18474 | xargs -r kill && npm run bridge`
    );
  }
}

async function localTokenInfo() {
  try {
    const tokenStat = await stat(TOKEN_PATH);
    const value = (await readFile(TOKEN_PATH, "utf8")).trim();
    return {
      exists: true,
      length: value.length,
      validLength: value.length >= 32,
      mtimeMs: tokenStat.mtimeMs,
      fingerprint: value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null
    };
  } catch (error) {
    return { exists: false, error: error.message };
  }
}

function withCommonFields(command) {
  const timeoutMs = Number(flagValue("--timeout", command.timeoutMs || 30000));
  return {
    ...command,
    timeoutMs,
    client: {
      name: "codex-chrome-bridge-cli",
      version: BRIDGE_VERSION
    }
  };
}

function commandFromArgs() {
  if (["status", "doctor", "queue", "flush", "cancel", "resume"].includes(action)) return null;
  if (action === "inspect") return withCommonFields({ type: "inspect", limit: Number(process.argv[3] || 120) });
  if (action === "click") return withCommonFields({ type: "click", x: numberArg(3, "x"), y: numberArg(4, "y") });
  if (action === "click-ref") return withCommonFields({ type: "click", ref: process.argv[3] || "" });
  if (action === "click-text") {
    return withCommonFields({
      type: "click",
      text: process.argv[3] || "",
      exact: hasFlag("--exact"),
      index: Number(flagValue("--index", 0))
    });
  }
  if (action === "click-selector") {
    return withCommonFields({
      type: "click",
      selector: process.argv[3] || "",
      index: Number(flagValue("--index", 0))
    });
  }
  if (action === "dblclick" || action === "double-click") {
    return withCommonFields({ type: "doubleClick", x: numberArg(3, "x"), y: numberArg(4, "y") });
  }
  if (action === "move" || action === "hover") {
    return withCommonFields({ type: "move", x: numberArg(3, "x"), y: numberArg(4, "y") });
  }
  if (action === "scroll") return withCommonFields({ type: "scroll", deltaY: Number(process.argv[3] || 700) });
  if (action === "fill-ref") return withCommonFields({ type: "fill", ref: process.argv[3] || "", text: process.argv[4] || "" });
  if (action === "type") return withCommonFields({ type: "type", text: process.argv[3] || "" });
  if (action === "key") {
    const modifiers = (process.argv[4] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return withCommonFields({ type: "key", key: process.argv[3] || "", modifiers });
  }
  if (action === "wait-for") {
    const [kind, ...rest] = positionalArgs();
    return withCommonFields({ type: "waitFor", kind, value: rest.join(" ") });
  }
  if (action === "nav" || action === "navigate") return withCommonFields({ type: "navigate", url: process.argv[3] || "" });
  if (action === "reload") return withCommonFields({ type: "reload" });
  if (action === "back") return withCommonFields({ type: "back" });
  if (action === "forward") return withCommonFields({ type: "forward" });
  if (action === "screenshot") {
    return withCommonFields({ type: "screenshot", output: process.argv[3] || "artifacts/screenshot.png" });
  }
  if (action === "wait") return withCommonFields({ type: "wait", ms: Number(process.argv[3] || 1000) });
  if (action === "stop" || action === "disarm") return withCommonFields({ type: "stop" });
  if (action === "raw") return withCommonFields(JSON.parse(process.argv[3] || "{}"));
  usage();
  process.exit(2);
}

async function enqueue(command) {
  await bridgeHello();
  const payload = await request("/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  return payload.command;
}

async function waitForResult(id, timeoutMs = 35000) {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    const payload = await request(`/result?id=${encodeURIComponent(id)}`);
    const command = payload.command;
    if (hasFlag("--jsonl") && command && command.status !== lastStatus) {
      console.log(JSON.stringify({ id, status: command.status, at: new Date().toISOString() }));
      lastStatus = command.status;
    }
    if (command && TERMINAL_STATUSES.has(command.status)) return command;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    id,
    status: "timed_out",
    error: `CLI timed out waiting for command result after ${timeoutMs}ms.`
  };
}

async function saveScreenshot(command) {
  if (!command || !command.result || !command.result.dataUrl || !command.output) return;
  const [, meta, base64] = command.result.dataUrl.match(/^data:(.+);base64,(.*)$/) || [];
  if (!base64) return;
  const outputPath = resolve(ROOT, command.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(base64, "base64"));
  command.result = {
    ...command.result,
    mimeType: meta,
    dataUrl: `[saved to ${outputPath}]`,
    output: outputPath
  };
}

async function runCommand() {
  const command = commandFromArgs();
  const queued = await enqueue(command);
  const result = await waitForResult(queued.id, Number(command.timeoutMs || 30000) + 10000);
  await saveScreenshot(result);
  printJson({ queued, result });
  if (result.status !== "succeeded") process.exit(1);
}

async function runDoctor() {
  const local = await localTokenInfo();
  let publicStatus = null;
  try {
    publicStatus = await request("/public-status", { token: false });
  } catch (error) {
    publicStatus = { ok: false, error: error.message };
  }
  try {
    const remote = await request("/doctor");
    assertProtocol(remote);
    printJson({ ...remote, localTokenFile: local, publicStatus });
  } catch (error) {
    const staleHint = error.message && /Not found|stale|protocol/i.test(error.message)
      ? "The bridge process is probably stale after a repo update. Restart it with: lsof -ti tcp:18474 | xargs -r kill && npm run bridge"
      : "If publicStatus is healthy but token auth fails, restart the bridge so it reloads the current `.bridge-token`.";
    printJson({
      ok: false,
      error: error.message,
      expectedBridgeVersion: BRIDGE_VERSION,
      expectedProtocolVersion: PROTOCOL_VERSION,
      localTokenFile: local,
      publicStatus,
      hint: staleHint
    });
    process.exit(1);
  }
}

try {
  if (action === "status") {
    const status = await request("/status");
    assertProtocol(status);
    printJson(status);
  } else if (action === "doctor") {
    await runDoctor();
  } else if (action === "queue") {
    await bridgeHello();
    printJson(await request("/queue"));
  } else if (action === "flush") {
    await bridgeHello();
    printJson(await request("/flush", { method: "POST" }));
  } else if (action === "cancel") {
    await bridgeHello();
    printJson(
      await request("/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: process.argv[3] || "" })
      })
    );
  } else if (action === "resume") {
    await bridgeHello();
    const status = await request("/status");
    printJson({
      ok: true,
      bridgeInstanceId: status.bridgeInstanceId,
      armed: status.latestExtensionState ? status.latestExtensionState.armed : null,
      connected: status.connected,
      lastPollAt: status.lastPollAt,
      hint: "If armed is present and connected is true, commands will target that arm session."
    });
  } else {
    await runCommand();
  }
} catch (error) {
  if (error.payload) {
    printJson(error.payload);
  } else {
    console.error(error.message);
  }
  process.exit(1);
}
