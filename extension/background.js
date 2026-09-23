import { assignFrameOffsets, placeItems, translateRect } from "./frame-geometry.mjs";
import { isTrustedExtensionSender } from "./extension-sender.mjs";
import {
  CREDENTIAL_STORAGE_KEY,
  credentialFromRedeem,
  listenerAcceptedExtension,
  persistedStateWithoutCredential,
  proofMatches,
  validProofNonce
} from "./extension-credential.mjs";

const SOURCE = "codex-chrome-bridge";
const BRIDGE_URL = "http://127.0.0.1:18474";
const BRIDGE_VERSION = "0.1.0";
const PROTOCOL_VERSION = 3;
const ARM_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;
const HELLO_INTERVAL_MS = 2000;
const COMMAND_HEARTBEAT_MS = 2000;

let state = {
  extensionInstanceId: `ext_${crypto.randomUUID()}`,
  extensionToken: "",
  operatorFingerprint: "",
  credentialProblem: null,
  protocolMismatch: null,
  listenerUntrusted: false,
  armed: null,
  debuggerTabId: null,
  activeBridgeInstanceId: null,
  lastBridgeHelloAt: null,
  lastPollAt: null,
  lastCommandAt: null,
  runningCommand: null,
  latestCommand: null,
  latestResult: null,
  capabilities: {
    inspect: true,
    input: true,
    screenshot: {
      ok: null,
      method: "cdp.Page.captureScreenshot",
      fallback: "tabs.captureVisibleTab",
      hint: "Screenshots use CDP first and tabs.captureVisibleTab as fallback."
    }
  },
  logs: []
};

let pollInFlight = false;
let helloInFlight = false;
let lastCommandId = "";
let proofFreshUntil = 0;

function storage() {
  return chrome.storage.session || chrome.storage.local;
}

function chromeCall(api, method, ...args) {
  return new Promise((resolve, reject) => {
    chrome[api][method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function debuggerCall(method, target, ...args) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](target, ...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function storageGet(key) {
  return new Promise((resolve) => storage().get(key, (saved) => resolve(saved)));
}

function storageSet(value) {
  const payload = value && value.state
    ? { ...value, state: persistedStateWithoutCredential(value.state) }
    : value;
  return new Promise((resolve) => storage().set(payload, () => resolve()));
}

function sessionArea() {
  return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
}

function sessionGetCredential() {
  const area = sessionArea();
  if (!area) return Promise.resolve(null);
  return new Promise((resolve) => {
    area.get(CREDENTIAL_STORAGE_KEY, (saved) => {
      const credential = saved && saved[CREDENTIAL_STORAGE_KEY];
      if (!credential || typeof credential.extensionToken !== "string" || credential.extensionToken.length < 32) {
        resolve(null);
        return;
      }
      resolve(credential);
    });
  });
}

function sessionWriteCredential(credential) {
  const area = sessionArea();
  if (!area) {
    return Promise.reject(new Error(
      "This browser has no chrome.storage.session, so the extension token was not stored. Update Chrome and pair again. The token is never written to chrome.storage.local."
    ));
  }
  return new Promise((resolve, reject) => {
    area.set({ [CREDENTIAL_STORAGE_KEY]: credential }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function sessionClearCredential() {
  const area = sessionArea();
  if (!area || !area.remove) return Promise.resolve();
  return new Promise((resolve) => area.remove(CREDENTIAL_STORAGE_KEY, () => resolve()));
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return value || "";
  }
}

function sanitizedArmed() {
  if (!state.armed) return null;
  return {
    ...state.armed,
    url: sanitizeUrl(state.armed.url),
    rawUrlRedacted: state.armed.url !== sanitizeUrl(state.armed.url)
  };
}

function summarizeResult(result) {
  if (!result) return null;
  if (!result.result || !result.result.dataUrl) return result;
  return {
    ...result,
    result: {
      ...result.result,
      dataUrl: `[${Math.round(result.result.dataUrl.length / 1024)}KB data URL omitted from status]`
    }
  };
}

function publicState() {
  return {
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    extensionInstanceId: state.extensionInstanceId,
    activeBridgeInstanceId: state.activeBridgeInstanceId,
    lastBridgeHelloAt: state.lastBridgeHelloAt,
    lastPollAt: state.lastPollAt,
    lastCommandAt: state.lastCommandAt,
    paired: Boolean(state.extensionToken),
    operatorFingerprint: state.operatorFingerprint || null,
    credentialProblem: state.credentialProblem || null,
    protocolMismatch: state.protocolMismatch || null,
    listenerUntrusted: Boolean(state.listenerUntrusted),
    armed: sanitizedArmed(),
    runningCommand: state.runningCommand,
    latestCommand: state.latestCommand,
    latestResult: summarizeResult(state.latestResult),
    capabilities: state.capabilities,
    logs: state.logs.slice(-30)
  };
}

async function restoreState() {
  const saved = await storageGet("state");
  let leakedToken = false;
  if (saved && saved.state) {
    leakedToken = Boolean(saved.state.extensionToken || saved.state.operatorFingerprint);
    const rest = persistedStateWithoutCredential(saved.state);
    state = {
      ...state,
      ...rest,
      extensionToken: "",
      operatorFingerprint: "",
      extensionInstanceId: rest.extensionInstanceId || state.extensionInstanceId,
      debuggerTabId: null,
      runningCommand: null
    };
  }
  const credential = await sessionGetCredential();
  if (credential) {
    state.extensionInstanceId = credential.extensionInstanceId || state.extensionInstanceId;
    state.extensionToken = credential.extensionToken;
    state.operatorFingerprint = credential.operatorFingerprint || "";
    if (credential.bridgeInstanceId) state.activeBridgeInstanceId = credential.bridgeInstanceId;
  }
  if (leakedToken) await storageSet({ state });
  if (state.armed && state.armed.expiresAt <= Date.now()) {
    state.armed = null;
    await storageSet({ state });
  }
  if (state.armed) {
    try {
      const tab = await chromeCall("tabs", "get", state.armed.tabId);
      if (!tab || !/^https?:/.test(tab.url || "")) {
        state.armed = null;
      } else {
        await updateArmedTabSnapshot(tab);
      }
    } catch (_) {
      state.armed = null;
    }
    await storageSet({ state });
  }
}

function log(message, extra) {
  const entry = { at: new Date().toISOString(), message, ...(extra ? { extra } : {}) };
  state.logs.push(entry);
  state.logs = state.logs.slice(-120);
  storageSet({ state });
  postEvent("log", entry).catch(() => {});
}

function extensionHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.extensionToken) headers["x-codex-bridge-extension-token"] = state.extensionToken;
  return headers;
}

async function forgetExtensionCredential(reason) {
  proofFreshUntil = 0;
  state.extensionToken = "";
  state.operatorFingerprint = "";
  state.listenerUntrusted = true;
  state.credentialProblem = reason;
  await sessionClearCredential();
  await storageSet({ state });
}

async function proveListener() {
  const nonce = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  if (!validProofNonce(nonce)) return false;
  const response = await fetch(`${BRIDGE_URL}/session-proof?nonce=${encodeURIComponent(nonce)}`, { cache: "no-store" });
  if (!response.ok) return false;
  const payload = await response.json().catch(() => null);
  if (!payload || Number(payload.protocolVersion) !== PROTOCOL_VERSION) return false;
  if (state.operatorFingerprint && payload.tokenFingerprint !== state.operatorFingerprint) return false;
  return proofMatches(state.extensionToken, nonce, payload.proof);
}

async function ensureListenerProof() {
  if (!state.extensionToken) return false;
  if (Date.now() < proofFreshUntil) return true;
  const proved = await proveListener();
  proofFreshUntil = proved ? Date.now() + HELLO_INTERVAL_MS : 0;
  state.listenerUntrusted = !proved;
  if (!proved) {
    state.credentialProblem = "Listener could not prove it holds this extension session. The extension token was not sent. Restart `npm run bridge` from this checkout. If doctor reports extension_unpaired, run `node bridge/control.mjs pair` again.";
    await storageSet({ state });
  }
  return proved;
}

async function postEvent(type, payload = {}) {
  if (!state.extensionToken || state.protocolMismatch) return;
  try {
    if (!(await ensureListenerProof())) return;
    const response = await fetch(`${BRIDGE_URL}/event`, {
      method: "POST",
      headers: extensionHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        type,
        payload: {
          extensionInstanceId: state.extensionInstanceId,
          bridgeInstanceId: state.activeBridgeInstanceId,
          ...payload
        },
        state: publicState(),
        at: new Date().toISOString()
      })
    });
    if (response.status === 403) {
      await forgetExtensionCredential("Bridge rejected the extension session. Run `node bridge/control.mjs pair` and paste a new code.");
      return;
    }
    if (!listenerAcceptedExtension(response.headers, PROTOCOL_VERSION)) {
      state.protocolMismatch = "Listener did not prove a paired protocol v3 session. Restart `npm run bridge`, reload the extension, and pair again.";
      proofFreshUntil = 0;
      await storageSet({ state });
      return;
    }
    const bridge = await response.json().catch(() => null);
    if (bridge && bridge.bridgeInstanceId && bridge.bridgeInstanceId !== state.activeBridgeInstanceId) {
      state.activeBridgeInstanceId = bridge.bridgeInstanceId;
      await storageSet({ state });
    }
  } catch (_) {
    // The bridge is optional until a Codex session starts it.
  }
}

async function helloBridge({ force = false } = {}) {
  if (helloInFlight) return;
  const lastHelloMs = state.lastBridgeHelloAt ? Date.parse(state.lastBridgeHelloAt) : 0;
  if (!force && Date.now() - lastHelloMs < HELLO_INTERVAL_MS) return;
  helloInFlight = true;
  try {
    const response = await fetch(`${BRIDGE_URL}/hello`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (Number(payload.protocolVersion) !== PROTOCOL_VERSION) {
      state.protocolMismatch = `Bridge protocol v${payload.protocolVersion} does not match extension v${PROTOCOL_VERSION}. Restart npm run bridge, reload the extension, and pair again.`;
      state.lastBridgeHelloAt = new Date().toISOString();
      proofFreshUntil = 0;
      await storageSet({ state });
      return;
    }
    state.protocolMismatch = null;
    if (state.operatorFingerprint && payload.tokenFingerprint && payload.tokenFingerprint !== state.operatorFingerprint) {
      state.listenerUntrusted = true;
      state.credentialProblem = "The listener fingerprint does not match the bridge this extension paired with. The extension token was not sent. Run doctor, then pair again if this checkout changed.";
      proofFreshUntil = 0;
      state.lastBridgeHelloAt = new Date().toISOString();
      await storageSet({ state });
      return;
    }
    state.listenerUntrusted = false;
    const changed = payload.bridgeInstanceId && payload.bridgeInstanceId !== state.activeBridgeInstanceId;
    state.activeBridgeInstanceId = payload.bridgeInstanceId || state.activeBridgeInstanceId;
    state.lastBridgeHelloAt = new Date().toISOString();
    await storageSet({ state });
    await postEvent("hello", {
      bridgeInstanceId: state.activeBridgeInstanceId,
      extensionInstanceId: state.extensionInstanceId,
      bridgeChanged: changed
    });
    if (changed && state.armed) {
      await postEvent("arm-state", { armed: sanitizedArmed() });
    }
  } catch (_) {
    // Bridge may not be running.
  } finally {
    helloInFlight = false;
  }
}

function isArmed() {
  return Boolean(state.armed && state.armed.expiresAt > Date.now());
}

async function updateArmedTabSnapshot(tab) {
  if (!state.armed || tab.id !== state.armed.tabId) return;
  state.armed = {
    ...state.armed,
    url: tab.url || state.armed.url,
    title: tab.title || state.armed.title
  };
  await storageSet({ state });
}

async function activeTab() {
  const tabs = await chromeCall("tabs", "query", { active: true, currentWindow: true });
  if (!tabs || !tabs[0]) throw new Error("No active Chrome tab.");
  return tabs[0];
}

async function armActiveTab() {
  const tab = await activeTab();
  if (!/^https?:/.test(tab.url || "")) {
    throw new Error("Only http/https tabs can be armed.");
  }
  if (state.armed && state.armed.tabId !== tab.id) {
    await detachDebugger();
  }
  state.armed = {
    armSessionId: `arm_${crypto.randomUUID()}`,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    armedAt: Date.now(),
    expiresAt: Date.now() + ARM_DURATION_MS
  };
  await storageSet({ state });
  await helloBridge({ force: true });
  await postEvent("armed", { armed: sanitizedArmed() });
  await postEvent("arm-state", { armed: sanitizedArmed() });
  return publicState();
}

async function disarm() {
  await detachDebugger();
  state.armed = null;
  state.runningCommand = null;
  await storageSet({ state });
  await postEvent("disarmed", {});
  return publicState();
}

async function getArmedTab() {
  if (!isArmed()) {
    if (state.armed) {
      state.armed = null;
      await storageSet({ state });
    }
    throw new Error("Bridge is not armed. Click the extension icon and arm the active tab.");
  }
  const tab = await chromeCall("tabs", "get", state.armed.tabId);
  if (tab.id !== state.armed.tabId) {
    throw new Error("Command refused: armed tab is no longer available.");
  }
  await updateArmedTabSnapshot(tab);
  return tab;
}

async function ensureDebugger(tabId) {
  if (state.debuggerTabId === tabId) return;
  await detachDebugger();
  try {
    await debuggerCall("attach", { tabId }, "1.3");
  } catch (error) {
    if (!/already attached/i.test(error.message)) throw error;
  }
  state.debuggerTabId = tabId;
  await storageSet({ state });
}

async function detachDebugger() {
  if (state.debuggerTabId === null) return;
  const tabId = state.debuggerTabId;
  state.debuggerTabId = null;
  await debuggerCall("detach", { tabId }).catch(() => {});
  await storageSet({ state });
}

async function sendCdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return debuggerCall("sendCommand", { tabId }, method, params);
}

async function ensureContent(tabId) {
  await chromeCall("scripting", "executeScript", {
    target: { tabId, allFrames: true },
    files: ["content.js"]
  });
}

async function listFrames(tabId) {
  try {
    const frames = await chromeCall("webNavigation", "getAllFrames", { tabId });
    if (Array.isArray(frames) && frames.length > 0) return frames;
  } catch (_) {
    // webNavigation can fail on restricted tabs. Top frame still answers.
  }
  return [{ frameId: 0, parentFrameId: -1, url: "" }];
}

async function queryFrames(tabId, message) {
  await ensureContent(tabId);
  const frames = await listFrames(tabId);
  const reports = [];
  for (const frame of frames) {
    try {
      const response = await chromeCall(
        "tabs",
        "sendMessage",
        tabId,
        { source: SOURCE, ...message },
        { frameId: frame.frameId }
      );
      if (response && response.ok) reports.push({ frameId: frame.frameId, ...response });
    } catch (_) {
      // The frame can navigate away between injection and the message.
    }
  }
  return { frames, reports };
}

async function inspect(command) {
  const tab = await getArmedTab();
  const limit = command.limit || 120;
  const { frames, reports } = await queryFrames(tab.id, { type: "inspect", limit });
  const items = placeItems(frames, reports).slice(0, limit);
  const top = reports.find((report) => report.frameId === 0) || reports[0];
  const viewport = top && top.viewport ? top.viewport : { width: null, height: null, deviceScaleFactor: null };
  return {
    url: sanitizeUrl(tab.url),
    title: tab.title,
    armSessionId: state.armed.armSessionId,
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor
    },
    items,
    redactions: items.flatMap((item) => item.redactions || [])
  };
}

async function findTarget(tabId, spec) {
  const { frames, reports } = await queryFrames(tabId, { type: "find", spec });
  const childFramesById = new Map(reports.map((report) => [report.frameId, report.childFrames || []]));
  const offsets = assignFrameOffsets(frames, childFramesById);
  const found = [];
  for (const report of reports) {
    if (!report.target || !report.target.rect) continue;
    const offset = offsets.get(report.frameId) || { x: 0, y: 0 };
    found.push({ ...report.target, rect: translateRect(report.target.rect, offset) });
  }
  found.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  if (!found[0]) throw new Error(`No target found for ${JSON.stringify(spec)}.`);
  return found[0];
}

function center(rect) {
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  };
}

async function moveMouse(tabId, point) {
  await sendCdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none"
  });
}

async function mouseClick(tabId, point, options = {}) {
  const button = options.button || "left";
  const clickCount = options.clickCount || 1;
  await moveMouse(tabId, point);
  await sendCdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    clickCount
  });
  await sendCdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    clickCount
  });
}

function targetFromCommand(command) {
  if (Number.isFinite(command.x) && Number.isFinite(command.y)) {
    return { point: { x: command.x, y: command.y }, target: null };
  }
  return null;
}

function targetSpec(command) {
  return {
    ref: command.ref || "",
    text: command.text || "",
    selector: command.selector || "",
    role: command.role || "",
    exact: Boolean(command.exact),
    index: command.index || 0
  };
}

async function click(command) {
  const tab = await getArmedTab();
  const coordinateTarget = targetFromCommand(command);
  if (coordinateTarget) {
    await mouseClick(tab.id, coordinateTarget.point, {
      button: command.button || "left",
      clickCount: command.clickCount || 1
    });
    return { clicked: "coordinates", point: coordinateTarget.point };
  }
  const target = await findTarget(tab.id, targetSpec(command));
  const point = center(target.rect);
  await mouseClick(tab.id, point, {
    button: command.button || "left",
    clickCount: command.clickCount || 1
  });
  return { clicked: target.text, role: target.role, ref: target.ref, point, frameUrl: target.frameUrl };
}

async function doubleClick(command) {
  return click({ ...command, clickCount: 2 });
}

async function move(command) {
  const tab = await getArmedTab();
  let point;
  if (Number.isFinite(command.x) && Number.isFinite(command.y)) {
    point = { x: command.x, y: command.y };
  } else {
    const target = await findTarget(tab.id, targetSpec(command));
    point = center(target.rect);
  }
  await moveMouse(tab.id, point);
  return { moved: true, point };
}

async function scroll(command) {
  const tab = await getArmedTab();
  await sendCdp(tab.id, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: command.x || 900,
    y: command.y || 560,
    deltaX: command.deltaX || 0,
    deltaY: command.deltaY || 700
  });
  return { scrolled: true };
}

function modifierMask(modifiers = []) {
  let mask = 0;
  for (const modifier of modifiers) {
    const key = String(modifier).toLowerCase();
    if (key === "alt" || key === "option") mask |= 1;
    if (key === "ctrl" || key === "control") mask |= 2;
    if (key === "meta" || key === "cmd" || key === "command") mask |= 4;
    if (key === "shift") mask |= 8;
  }
  return mask;
}

function keyEventFields(key) {
  const normalized = String(key || "");
  const special = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 }
  };
  if (special[normalized]) return special[normalized];
  const char = normalized.length === 1 ? normalized : normalized.slice(0, 1);
  return {
    key: char,
    code: /^[a-z]$/i.test(char) ? `Key${char.toUpperCase()}` : char,
    text: char,
    windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0)
  };
}

async function keypress(command) {
  const tab = await getArmedTab();
  const fields = keyEventFields(command.key || command.value);
  const modifiers = modifierMask(command.modifiers || []);
  await sendCdp(tab.id, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...fields,
    modifiers,
    text: modifiers ? undefined : fields.text
  });
  await sendCdp(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...fields,
    modifiers,
    text: undefined
  });
  return { key: fields.key, modifiers: command.modifiers || [] };
}

async function typeText(command) {
  const tab = await getArmedTab();
  await sendCdp(tab.id, "Input.insertText", { text: String(command.text || "") });
  return { typed: String(command.text || "").length };
}

async function fill(command) {
  const tab = await getArmedTab();
  if (!command.ref) throw new Error("fill requires a ref from inspect.");
  const { reports } = await queryFrames(tab.id, {
    type: "setValue",
    spec: { ref: command.ref },
    text: String(command.text || "")
  });
  const success = reports.map((report) => report.result).find((result) => result && result.ok);
  if (!success) {
    const reason = reports.map((report) => report.result && report.result.error).find(Boolean);
    throw new Error(reason || `Unable to fill ${command.ref}.`);
  }
  return { filled: command.ref, length: String(command.text || "").length };
}

async function navigate(command) {
  const tab = await getArmedTab();
  const destination = new URL(command.url, tab.url);
  await chromeCall("tabs", "update", tab.id, { url: destination.href });
  return { navigatingTo: sanitizeUrl(destination.href) };
}

async function reload() {
  const tab = await getArmedTab();
  await chromeCall("tabs", "reload", tab.id);
  return { reloading: true };
}

async function history(command) {
  const tab = await getArmedTab();
  if (command.type === "back") {
    await chromeCall("tabs", "goBack", tab.id);
    return { goingBack: true };
  }
  await chromeCall("tabs", "goForward", tab.id);
  return { goingForward: true };
}

async function screenshot(command = {}) {
  const tab = await getArmedTab();
  const format = command.format === "jpeg" ? "jpeg" : "png";
  try {
    await sendCdp(tab.id, "Page.enable");
    const params = {
      format,
      captureBeyondViewport: Boolean(command.fullPage)
    };
    if (format === "jpeg" && Number.isFinite(command.quality)) params.quality = command.quality;
    const captured = await sendCdp(tab.id, "Page.captureScreenshot", params);
    state.capabilities.screenshot = {
      ok: true,
      method: "cdp.Page.captureScreenshot",
      fallback: "tabs.captureVisibleTab"
    };
    await storageSet({ state });
    return {
      url: sanitizeUrl(tab.url),
      title: tab.title,
      dataUrl: `data:image/${format};base64,${captured.data}`,
      method: "cdp.Page.captureScreenshot"
    };
  } catch (cdpError) {
    try {
      const dataUrl = await chromeCall("tabs", "captureVisibleTab", tab.windowId, {
        format,
        quality: command.quality
      });
      state.capabilities.screenshot = {
        ok: true,
        method: "tabs.captureVisibleTab",
        cdpError: cdpError.message
      };
      await storageSet({ state });
      return {
        url: sanitizeUrl(tab.url),
        title: tab.title,
        dataUrl,
        method: "tabs.captureVisibleTab",
        cdpError: cdpError.message
      };
    } catch (fallbackError) {
      state.capabilities.screenshot = {
        ok: false,
        method: "cdp.Page.captureScreenshot",
        fallback: "tabs.captureVisibleTab",
        error: fallbackError.message,
        cdpError: cdpError.message,
        hint: "CDP Page.captureScreenshot failed, then tabs.captureVisibleTab failed. Focus the Chrome window, keep <all_urls> host permission, and retry. inspect can still work."
      };
      await storageSet({ state });
      const error = new Error(fallbackError.message);
      error.status = "failed";
      throw error;
    }
  }
}

async function waitCommand(command) {
  const ms = Math.max(0, Number(command.ms || command.timeout || 0));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { waitedMs: ms };
}

async function waitFor(command) {
  const tab = await getArmedTab();
  const timeoutMs = Math.max(1, Number(command.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS));
  const started = Date.now();
  const kind = String(command.kind || "").toLowerCase();
  const value = String(command.value || "");
  while (Date.now() - started < timeoutMs) {
    if (kind === "url") {
      const current = await chromeCall("tabs", "get", tab.id);
      if ((current.url || "").includes(value)) return { matched: "url", value: sanitizeUrl(current.url) };
    } else {
      const spec = kind === "selector" ? { selector: value } : { text: value };
      const target = await findTarget(tab.id, spec).catch(() => null);
      if (target) return { matched: kind || "text", target };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${kind || "target"} ${value}.`);
}

function assertCommandArm(command) {
  if (command.type === "status" || command.type === "stop" || command.type === "disarm") return;
  if (!isArmed()) throw new Error("Bridge is not armed. Click the extension icon and arm the active tab.");
  if (command.armSessionId && state.armed && command.armSessionId !== state.armed.armSessionId) {
    const error = new Error(`Stale arm session. Command targets ${command.armSessionId}; active is ${state.armed.armSessionId}.`);
    error.status = "stale_arm";
    throw error;
  }
}

async function handleCommand(command) {
  if (!command || !command.type) throw new Error("Missing command type.");
  assertCommandArm(command);
  if (command.type === "status") return publicState();
  if (command.type === "inspect") return inspect(command);
  if (command.type === "click") return click(command);
  if (command.type === "doubleClick" || command.type === "dblclick") return doubleClick(command);
  if (command.type === "move" || command.type === "hover") return move(command);
  if (command.type === "scroll") return scroll(command);
  if (command.type === "key" || command.type === "keypress") return keypress(command);
  if (command.type === "type") return typeText(command);
  if (command.type === "fill") return fill(command);
  if (command.type === "waitFor") return waitFor(command);
  if (command.type === "navigate" || command.type === "nav") return navigate(command);
  if (command.type === "reload") return reload(command);
  if (command.type === "back" || command.type === "forward") return history(command);
  if (command.type === "screenshot") return screenshot(command);
  if (command.type === "wait") return waitCommand(command);
  if (command.type === "stop" || command.type === "disarm") return disarm();
  throw new Error(`Unknown command type: ${command.type}`);
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(`Command timed out after ${timeoutMs}ms.`);
        error.status = "timed_out";
        reject(error);
      }, timeoutMs);
    })
  ]);
}

async function finishCommand(command, status, fields = {}) {
  state.latestResult = {
    id: command.id,
    type: command.type,
    status,
    startedAt: state.runningCommand ? state.runningCommand.startedAt : undefined,
    finishedAt: new Date().toISOString(),
    ...fields
  };
  state.runningCommand = null;
  await storageSet({ state });
  await postEvent("command-result", state.latestResult);
}

async function runBridgeCommand(command) {
  state.latestCommand = command;
  state.lastCommandAt = new Date().toISOString();
  state.runningCommand = {
    id: command.id,
    type: command.type,
    armSessionId: command.armSessionId,
    startedAt: new Date().toISOString(),
    timeoutMs: command.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS
  };
  await storageSet({ state });
  await postEvent("command-start", state.runningCommand);
  const heartbeat = setInterval(() => {
    postEvent("command-heartbeat", {
      id: command.id,
      type: command.type,
      startedAt: state.runningCommand ? state.runningCommand.startedAt : undefined
    }).catch(() => {});
  }, COMMAND_HEARTBEAT_MS);
  try {
    const timeoutMs = Math.max(1, Number(command.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS));
    const result = await withTimeout(handleCommand(command), timeoutMs);
    clearInterval(heartbeat);
    await finishCommand(command, "succeeded", { result });
  } catch (error) {
    clearInterval(heartbeat);
    await finishCommand(command, error.status || "failed", { error: error.message });
  }
}

async function redeemPairTicket(ticket) {
  const code = String(ticket || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(code)) {
    throw new Error("Pairing code should be the 64-character code from `node bridge/control.mjs pair`.");
  }
  const response = await fetch(`${BRIDGE_URL}/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket: code, extensionInstanceId: state.extensionInstanceId })
  });
  const payload = await response.json().catch(() => null);
  const credential = credentialFromRedeem(payload, state.extensionInstanceId);
  await sessionWriteCredential(credential);
  state.extensionToken = credential.extensionToken;
  state.operatorFingerprint = credential.operatorFingerprint;
  state.credentialProblem = null;
  state.protocolMismatch = null;
  state.listenerUntrusted = false;
  proofFreshUntil = 0;
  if (credential.bridgeInstanceId) state.activeBridgeInstanceId = credential.bridgeInstanceId;
  await storageSet({ state });
  await helloBridge({ force: true });
  return publicState();
}

async function pairFromActiveTab() {
  const tab = await activeTab();
  let parsed;
  try {
    parsed = new URL(tab.url || "");
  } catch (_) {
    throw new Error("Active tab has no URL to pair from.");
  }
  if (parsed.origin !== BRIDGE_URL || parsed.pathname !== "/pair") {
    throw new Error("Open the pairing page from `node bridge/control.mjs pair` at http://127.0.0.1:18474/pair in the active tab, then try again.");
  }
  return redeemPairTicket(decodeURIComponent(parsed.hash.replace(/^#/, "")));
}

async function pollBridge() {
  if (pollInFlight || state.runningCommand) return;
  pollInFlight = true;
  try {
    await whenRestored();
    await helloBridge();
    if (!state.extensionToken || state.protocolMismatch || state.listenerUntrusted) return;
    if (!(await ensureListenerProof())) return;
    const params = new URLSearchParams({
      extensionInstanceId: state.extensionInstanceId,
      bridgeInstanceId: state.activeBridgeInstanceId || ""
    });
    if (state.armed && state.armed.armSessionId) params.set("armSessionId", state.armed.armSessionId);
    const response = await fetch(`${BRIDGE_URL}/poll?${params.toString()}`, {
      cache: "no-store",
      headers: extensionHeaders()
    });
    state.lastPollAt = new Date().toISOString();
    await storageSet({ state });
    if (response.status === 403) {
      await forgetExtensionCredential("Bridge rejected the extension session. Run `node bridge/control.mjs pair` and paste a new code.");
      return;
    }
    if (!response.ok) return;
    if (!listenerAcceptedExtension(response.headers, PROTOCOL_VERSION)) {
      state.protocolMismatch = "Refusing commands from a listener that did not prove protocol v3 with a paired extension session.";
      proofFreshUntil = 0;
      await storageSet({ state });
      return;
    }
    state.credentialProblem = null;
    const command = await response.json();
    if (command && command.id && command.id !== lastCommandId) {
      lastCommandId = command.id;
      await runBridgeCommand(command);
    }
  } catch (_) {
    // Bridge may not be running.
  } finally {
    pollInFlight = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return false;
  if (!message || message.source !== SOURCE) return false;
  if (message.type === "popup-command") {
    const action = message.action;
    const run =
      action === "arm" ? armActiveTab() :
      action === "disarm" ? disarm() :
      action === "pair" ? redeemPairTicket(message.ticket) :
      action === "pair-tab" ? pairFromActiveTab() :
      Promise.resolve(publicState());
    run.then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  whenRestored().then(() => storageSet({ state }));
});

chrome.runtime.onStartup.addListener(() => {
  whenRestored().then(() => helloBridge({ force: true }));
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  if (state.armed && tabId === state.armed.tabId) {
    updateArmedTabSnapshot(tab)
      .then(() => postEvent("arm-state", { armed: sanitizedArmed() }))
      .catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.armed && tabId === state.armed.tabId) {
    disarm().catch(() => {});
  }
});

const restored = restoreState();
function whenRestored() {
  return restored;
}

restored.then(() => helloBridge({ force: true }));
setInterval(() => {
  restored.then(() => pollBridge());
}, POLL_INTERVAL_MS);
restored.then(() => pollBridge());
