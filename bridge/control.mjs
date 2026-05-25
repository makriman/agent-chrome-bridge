import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOKEN_PATH = join(ROOT, ".bridge-token");
const BRIDGE_URL = process.env.CODEX_CHROME_BRIDGE_URL || "http://127.0.0.1:18474";

async function token() {
  try {
    return (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch (_) {
    await mkdir(ROOT, { recursive: true });
    await writeFile(TOKEN_PATH, "", { mode: 0o600 });
    return "";
  }
}

function usage() {
  console.error(`Usage:
  node bridge/control.mjs status
  node bridge/control.mjs inspect [limit]
  node bridge/control.mjs click <x> <y>
  node bridge/control.mjs click-text "Text" [--exact] [--index N]
  node bridge/control.mjs click-selector "button.primary" [--index N]
  node bridge/control.mjs dblclick <x> <y>
  node bridge/control.mjs move <x> <y>
  node bridge/control.mjs scroll [deltaY]
  node bridge/control.mjs type "Text to insert"
  node bridge/control.mjs key Enter [Meta,Shift]
  node bridge/control.mjs nav "https://example.com/path"
  node bridge/control.mjs reload
  node bridge/control.mjs back
  node bridge/control.mjs forward
  node bridge/control.mjs screenshot [output.png]
  node bridge/control.mjs wait 1000
  node bridge/control.mjs stop
  node bridge/control.mjs raw '{"type":"click","x":400,"y":300}'`);
}

const action = process.argv[2] || "status";

function hasFlag(name) {
  return process.argv.includes(name);
}

function flagValue(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function numberArg(index, label) {
  const value = Number(process.argv[index]);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected numeric ${label}.`);
  }
  return value;
}

function commandFromArgs() {
  if (action === "status") return null;
  if (action === "inspect") return { type: "inspect", limit: Number(process.argv[3] || 120) };
  if (action === "click") return { type: "click", x: numberArg(3, "x"), y: numberArg(4, "y") };
  if (action === "click-text") {
    return {
      type: "click",
      text: process.argv[3] || "",
      exact: hasFlag("--exact"),
      index: Number(flagValue("--index", 0))
    };
  }
  if (action === "click-selector") {
    return {
      type: "click",
      selector: process.argv[3] || "",
      index: Number(flagValue("--index", 0))
    };
  }
  if (action === "dblclick" || action === "double-click") {
    return { type: "doubleClick", x: numberArg(3, "x"), y: numberArg(4, "y") };
  }
  if (action === "move" || action === "hover") return { type: "move", x: numberArg(3, "x"), y: numberArg(4, "y") };
  if (action === "scroll") return { type: "scroll", deltaY: Number(process.argv[3] || 700) };
  if (action === "type") return { type: "type", text: process.argv[3] || "" };
  if (action === "key") {
    const modifiers = (process.argv[4] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return { type: "key", key: process.argv[3] || "", modifiers };
  }
  if (action === "nav" || action === "navigate") return { type: "navigate", url: process.argv[3] || "" };
  if (action === "reload") return { type: "reload" };
  if (action === "back") return { type: "back" };
  if (action === "forward") return { type: "forward" };
  if (action === "screenshot") return { type: "screenshot", output: process.argv[3] || "artifacts/screenshot.png" };
  if (action === "wait") return { type: "wait", ms: Number(process.argv[3] || 1000) };
  if (action === "stop" || action === "disarm") return { type: "stop" };
  if (action === "raw") return JSON.parse(process.argv[3] || "{}");
  usage();
  process.exit(2);
}

async function getStatus() {
  const response = await fetch(`${BRIDGE_URL}/status`);
  const text = await response.text();
  console.log(text);
  if (!response.ok) process.exit(1);
}

async function enqueue(command) {
  const response = await fetch(`${BRIDGE_URL}/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-bridge-token": await token()
    },
    body: JSON.stringify(command)
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  return payload.command;
}

async function waitForResult(id, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${BRIDGE_URL}/result?id=${encodeURIComponent(id)}`, {
      headers: { "x-codex-bridge-token": await token() }
    });
    const payload = await response.json();
    if (payload.result) return payload.result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function saveScreenshot(command, result) {
  if (!result || !result.result || !result.result.dataUrl || !command.output) return;
  const [, meta, base64] = result.result.dataUrl.match(/^data:(.+);base64,(.*)$/) || [];
  if (!base64) return;
  const outputPath = resolve(ROOT, command.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(base64, "base64"));
  result.result = {
    ...result.result,
    mimeType: meta,
    dataUrl: `[saved to ${outputPath}]`,
    output: outputPath
  };
}

try {
  if (action === "status") {
    await getStatus();
  } else {
    const command = commandFromArgs();
    const queued = await enqueue(command);
    const result = await waitForResult(queued.id);
    await saveScreenshot(command, result);
    console.log(JSON.stringify({ queued, result }, null, 2));
    if (result && result.ok === false) process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
