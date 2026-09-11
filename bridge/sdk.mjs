import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_VERSION, PROTOCOL_VERSION, TERMINAL_STATUSES as TERMINAL_STATUS_LIST } from "./protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOKEN_PATH = join(ROOT, ".bridge-token");
const BRIDGE_URL = process.env.CODEX_CHROME_BRIDGE_URL || "http://127.0.0.1:18474";
const TERMINAL_STATUSES = new Set(TERMINAL_STATUS_LIST);

export class BridgeCommandError extends Error {
  constructor(command) {
    super(command.error || `Command ${command.id} ended with ${command.status}.`);
    this.name = "BridgeCommandError";
    this.command = command;
    this.status = command.status;
  }
}

export class ApprovalRequired extends Error {
  constructor(approval) {
    super(`Approval required: ${approval.reason}`);
    this.name = "ApprovalRequired";
    this.approval = approval;
    this.status = "approval_required";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function patternSource(pattern) {
  if (pattern instanceof RegExp) return pattern.toString();
  return String(pattern || "");
}

function matches(value, pattern) {
  if (pattern instanceof RegExp) return pattern.test(String(value || ""));
  return String(value || "").includes(String(pattern || ""));
}

function hashApproval(approval) {
  return createHash("sha256")
    .update(JSON.stringify({ reason: approval.reason, details: approval.details }))
    .digest("hex")
    .slice(0, 24);
}

function outputPath(root, path) {
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(root || ROOT, path);
}

function fakeStatusResult() {
  return {
    ok: true,
    dryRun: true,
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    bridgeInstanceId: "dry-run-bridge",
    connected: true,
    pendingCount: 0,
    latestExtensionState: {
      armed: {
        armSessionId: "dry-run-arm",
        title: "Dry Run",
        url: "dry-run://current-tab",
        expiresAt: Date.now() + 30 * 60 * 1000
      }
    }
  };
}

function dryRunResultFor(command, root) {
  if (command.type === "inspect") {
    return {
      dryRun: true,
      url: "dry-run://current-tab",
      title: "Dry Run",
      armSessionId: "dry-run-arm",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      items: [],
      redactions: []
    };
  }
  if (command.type === "screenshot") {
    return {
      dryRun: true,
      output: outputPath(root, command.output || "artifacts/screenshot.png"),
      mimeType: "image/png",
      dataUrl: "[dry-run omitted]",
      method: "dry-run"
    };
  }
  if (command.type === "waitFor") {
    return {
      dryRun: true,
      matched: command.kind || "target",
      value: command.value || "",
      target: null
    };
  }
  if (command.type === "wait") {
    return {
      dryRun: true,
      waitedMs: Number(command.ms || 0)
    };
  }
  if (command.type === "status") return fakeStatusResult();
  return {
    dryRun: true,
    command
  };
}

export class BrowserClient {
  constructor(options = {}) {
    this.configure(options);
  }

  configure(options = {}) {
    this.bridgeUrl = options.bridgeUrl || this.bridgeUrl || BRIDGE_URL;
    this.tokenPath = options.tokenPath || this.tokenPath || TOKEN_PATH;
    this.root = options.root || this.root || ROOT;
    this.runDir = options.runDir || this.runDir || null;
    this.dryRun = Boolean(options.dryRun ?? this.dryRun);
    this.offline = Boolean(options.offline ?? this.offline);
    this.approve = Boolean(options.approve ?? this.approve);
    this.commandTimeoutMs = Number(options.commandTimeoutMs || this.commandTimeoutMs || 30000);
    this.eventSink = options.eventSink || this.eventSink || (() => {});
    return this;
  }

  emit(type, payload = {}) {
    this.eventSink({ type, at: nowIso(), ...payload });
  }

  async token() {
    const value = (await readFile(this.tokenPath, "utf8")).trim();
    if (value.length < 32) {
      throw new Error("Bridge token is missing or invalid. Start/restart the bridge with `npm run bridge`.");
    }
    return value;
  }

  async request(path, options = {}) {
    if (this.offline) {
      throw new Error(`Offline dry-run mode blocked bridge request: ${path}`);
    }
    const headers = { ...(options.headers || {}) };
    if (options.token !== false) {
      headers["x-codex-bridge-token"] = await this.token();
    }
    const response = await fetch(`${this.bridgeUrl}${path}`, { ...options, headers });
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

  async status() {
    if (this.dryRun || this.offline) return fakeStatusResult();
    return this.request("/status");
  }

  async doctor() {
    if (this.dryRun || this.offline) return { ...fakeStatusResult(), doctor: { offline: this.offline, dryRun: this.dryRun } };
    return this.request("/doctor");
  }

  async queue() {
    if (this.dryRun || this.offline) return { ok: true, dryRun: true, counts: {}, active: [], recentFailures: [], pending: [], commands: [] };
    return this.request("/queue");
  }

  async flush() {
    return this.request("/flush", { method: "POST" });
  }

  async cancel(id) {
    return this.request("/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id })
    });
  }

  async enqueue(command) {
    const payload = await this.request("/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    });
    return payload.command;
  }

  async waitForResult(id, timeoutMs) {
    const started = Date.now();
    let lastStatus = "";
    while (Date.now() - started < timeoutMs) {
      const payload = await this.request(`/result?id=${encodeURIComponent(id)}`);
      const command = payload.command;
      if (command && command.status !== lastStatus) {
        lastStatus = command.status;
        this.emit("command_status", { commandId: id, status: command.status, command });
      }
      if (command && TERMINAL_STATUSES.has(command.status)) return command;
      await sleep(250);
    }
    return {
      id,
      status: "timed_out",
      error: `SDK timed out waiting for command result after ${timeoutMs}ms.`
    };
  }

  async command(command, options = {}) {
    const timeoutMs = Number(command.timeoutMs || options.timeoutMs || this.commandTimeoutMs);
    const payload = {
      ...command,
      timeoutMs,
      client: {
        name: "codex-chrome-bridge-sdk",
        version: BRIDGE_VERSION,
        ...(command.client || {})
      }
    };
    if ((this.dryRun && command.type !== "status") || this.offline) {
      const dryRunCommand = {
        id: `dry_${randomUUID()}`,
        type: payload.type || payload.op,
        status: "succeeded",
        dryRun: true,
        result: dryRunResultFor(payload, this.root),
        lifecycle: [{ status: "succeeded", at: nowIso(), reason: "dry-run" }]
      };
      this.emit("command_dry_run", { command: dryRunCommand });
      return dryRunCommand;
    }
    this.emit("command_enqueue", { command: payload });
    const queued = await this.enqueue(payload);
    this.emit("command_queued", { command: queued });
    const result = await this.waitForResult(queued.id, timeoutMs + 10000);
    await this.saveScreenshotResult(result);
    this.emit("command_finished", { command: result });
    if (result.status !== "succeeded") throw new BridgeCommandError(result);
    return result;
  }

  async saveScreenshotResult(command) {
    if (!command || !command.result || !command.result.dataUrl || !command.output) return;
    const [, meta, base64] = command.result.dataUrl.match(/^data:(.+);base64,(.*)$/) || [];
    if (!base64) return;
    const target = outputPath(this.root, command.output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(base64, "base64"));
    command.result = {
      ...command.result,
      mimeType: meta,
      dataUrl: `[saved to ${target}]`,
      output: target
    };
  }

  async useProfile(profile = "default") {
    return new BrowserTab(this, profile);
  }

  async currentTab() {
    return this.useProfile("default");
  }

  async requireApproval(reason, details = {}) {
    const approval = {
      id: `approval_${randomUUID()}`,
      reason,
      details,
      requestedAt: nowIso()
    };
    approval.actionHash = hashApproval(approval);
    this.emit("approval_required", { approval });
    if (this.runDir) {
      const approvalDir = join(this.runDir, "approvals");
      await mkdir(approvalDir, { recursive: true });
      await writeFile(join(approvalDir, `${approval.id}.json`), JSON.stringify(approval, null, 2));
    }
    if (this.approve || process.env.CODEX_CHROME_BRIDGE_APPROVE === "1") {
      const token = {
        approvalId: approval.id,
        approvalToken: approval.actionHash,
        approvedAt: nowIso()
      };
      this.emit("approval_granted", { approval, token });
      return token;
    }
    throw new ApprovalRequired(approval);
  }
}

export class BrowserTab {
  constructor(client, profile = "default") {
    this.client = client;
    this.profile = profile;
  }

  async status() {
    return this.client.status();
  }

  async assertUrl(pattern) {
    if (this.client.offline) return "dry-run://current-tab";
    const status = await this.status();
    const armed = status.latestExtensionState ? status.latestExtensionState.armed : null;
    const url = armed ? armed.url : "";
    if (!matches(url, pattern)) {
      throw new Error(`Expected armed tab URL to match ${patternSource(pattern)}, got ${url || "nothing"}.`);
    }
    return url;
  }

  async inspect(limit = 120) {
    const command = await this.client.command({ type: "inspect", limit, profile: this.profile });
    return command.result;
  }

  async findByText(pattern, { limit = 200 } = {}) {
    const result = await this.inspect(limit);
    const item = (result.items || []).find((candidate) => matches(candidate.text, pattern));
    if (!item && this.client.dryRun) {
      return {
        dryRun: true,
        ref: "dry_ref",
        text: patternSource(pattern),
        role: "dry-run",
        rect: { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }
      };
    }
    if (!item) throw new Error(`No inspected item matched ${patternSource(pattern)}.`);
    return item;
  }

  async screenshot(output = null) {
    const target = output || (this.client.runDir ? join(this.client.runDir, "screenshots", `${Date.now()}.png`) : "artifacts/screenshot.png");
    try {
      const command = await this.client.command({ type: "screenshot", output: target, profile: this.profile });
      return command.result;
    } catch (error) {
      const wrapped = new Error(
        `Screenshot failed (${error.message}). CDP Page.captureScreenshot is tried first; tabs.captureVisibleTab is the fallback and needs the tab visible plus host permission. Continue with inspect if status/inspect still work.`
      );
      wrapped.cause = error;
      wrapped.status = error.status;
      wrapped.command = error.command;
      throw wrapped;
    }
  }

  async sleep(ms = 1000, options = {}) {
    const command = await this.client.command({
      type: "wait",
      ms: Number(ms) || 0,
      profile: this.profile,
      ...options
    });
    return command.result;
  }

  async wait() {
    throw new Error(
      "tab.wait() is not an SDK method. Use tab.sleep(ms), tab.waitForText(text), tab.waitForUrl(urlPart), or tab.waitForSelector(selector)."
    );
  }

  async getVisibleText({ limit = 200 } = {}) {
    const result = await this.inspect(limit);
    return {
      url: result.url,
      title: result.title,
      text: (result.items || []).map((item) => item.text).filter(Boolean).join("\n"),
      itemCount: (result.items || []).length,
      note: "inspect-only: interactive/labeled elements. Static Polaris metrics often do not appear. Prefer screenshot-first for those."
    };
  }

  async clickRef(ref, options = {}) {
    const command = await this.client.command({ type: "click", ref, profile: this.profile, ...options });
    return command.result;
  }

  async clickByText(text, options = {}) {
    const command = await this.client.command({ type: "click", text: String(text), profile: this.profile, ...options });
    return command.result;
  }

  async clickByRole(role, name, options = {}) {
    const command = await this.client.command({
      type: "click",
      role,
      text: String(name || ""),
      exact: options.exact ?? true,
      profile: this.profile,
      ...options
    });
    return command.result;
  }

  async clickBySelector(selector, options = {}) {
    const command = await this.client.command({ type: "click", selector, profile: this.profile, ...options });
    return command.result;
  }

  async fillRef(ref, text, options = {}) {
    const command = await this.client.command({ type: "fill", ref, text: String(text || ""), profile: this.profile, ...options });
    return command.result;
  }

  async type(text, options = {}) {
    const command = await this.client.command({ type: "type", text: String(text || ""), profile: this.profile, ...options });
    return command.result;
  }

  async press(key, modifiers = [], options = {}) {
    const command = await this.client.command({ type: "key", key, modifiers, profile: this.profile, ...options });
    return command.result;
  }

  async scroll(deltaY = 700, options = {}) {
    const command = await this.client.command({ type: "scroll", deltaY, profile: this.profile, ...options });
    return command.result;
  }

  async navigate(url, options = {}) {
    const command = await this.client.command({ type: "navigate", url, profile: this.profile, ...options });
    return command.result;
  }

  async waitForText(text, options = {}) {
    const command = await this.client.command({ type: "waitFor", kind: "text", value: String(text), profile: this.profile, ...options });
    return command.result;
  }

  async waitForSelector(selector, options = {}) {
    const command = await this.client.command({ type: "waitFor", kind: "selector", value: selector, profile: this.profile, ...options });
    return command.result;
  }

  async waitForUrl(urlPart, options = {}) {
    const command = await this.client.command({ type: "waitFor", kind: "url", value: String(urlPart), profile: this.profile, ...options });
    return command.result;
  }

  async assertText(text, options = {}) {
    return this.waitForText(text, options);
  }

  async assertSelector(selector, options = {}) {
    return this.waitForSelector(selector, options);
  }

  async requireApproval(reason, details = {}) {
    return this.client.requireApproval(reason, { profile: this.profile, ...details });
  }
}

export const browser = new BrowserClient();

export function configureBrowser(options = {}) {
  browser.configure(options);
  return browser;
}
