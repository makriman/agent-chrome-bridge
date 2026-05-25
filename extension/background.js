const SOURCE = "codex-chrome-bridge";
const BRIDGE_URL = "http://127.0.0.1:18474";
const ARM_DURATION_MS = 30 * 60 * 1000;

let state = {
  armed: null,
  debuggerTabId: null,
  latestCommand: null,
  latestResult: null,
  logs: []
};

let pollInFlight = false;
let lastCommandId = "";

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

function storageSet(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, () => resolve()));
}

function restoreState() {
  chrome.storage.local.get("state", (saved) => {
    if (saved && saved.state) {
      state = { ...state, ...saved.state, debuggerTabId: null };
      if (state.armed && state.armed.expiresAt <= Date.now()) {
        state.armed = null;
        storageSet({ state });
      }
    }
  });
}

function log(message, extra) {
  const entry = { at: new Date().toISOString(), message, ...(extra ? { extra } : {}) };
  state.logs.push(entry);
  state.logs = state.logs.slice(-120);
  storageSet({ state });
  postEvent("log", entry).catch(() => {});
}

function publicState() {
  return {
    armed: state.armed,
    latestCommand: state.latestCommand,
    latestResult: summarizeResult(state.latestResult),
    logs: state.logs.slice(-30)
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

async function postEvent(type, payload = {}) {
  try {
    await fetch(`${BRIDGE_URL}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, payload, state: publicState(), at: new Date().toISOString() })
    });
  } catch (_) {
    // The bridge is optional until a Codex session starts it.
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
  state.armed = {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    armedAt: Date.now(),
    expiresAt: Date.now() + ARM_DURATION_MS
  };
  await storageSet({ state });
  await postEvent("armed", { armed: state.armed });
  return publicState();
}

async function disarm() {
  await detachDebugger();
  state.armed = null;
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
  try {
    await chromeCall("tabs", "sendMessage", tabId, { source: SOURCE, type: "ping" }, { frameId: 0 });
  } catch (_) {
    await chromeCall("scripting", "executeScript", {
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  }
}

async function inspect(command) {
  const tab = await getArmedTab();
  await ensureContent(tab.id);
  const response = await chromeCall(
    "tabs",
    "sendMessage",
    tab.id,
    { source: SOURCE, type: "inspect", limit: command.limit || 120 },
    { frameId: 0 }
  );
  return {
    url: tab.url,
    title: tab.title,
    items: response.items || []
  };
}

async function findTarget(tabId, spec) {
  await ensureContent(tabId);
  const response = await chromeCall(
    "tabs",
    "sendMessage",
    tabId,
    { source: SOURCE, type: "find", spec },
    { frameId: 0 }
  );
  if (!response || !response.target) {
    throw new Error(`No target found for ${JSON.stringify(spec)}.`);
  }
  return response.target;
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
  const target = await findTarget(tab.id, {
    text: command.text || "",
    selector: command.selector || "",
    role: command.role || "",
    exact: Boolean(command.exact),
    index: command.index || 0
  });
  const point = center(target.rect);
  await mouseClick(tab.id, point, {
    button: command.button || "left",
    clickCount: command.clickCount || 1
  });
  return { clicked: target.text, role: target.role, point, frameUrl: target.frameUrl };
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
    const target = await findTarget(tab.id, {
      text: command.text || "",
      selector: command.selector || "",
      role: command.role || "",
      exact: Boolean(command.exact),
      index: command.index || 0
    });
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

async function navigate(command) {
  const tab = await getArmedTab();
  const destination = new URL(command.url, tab.url);
  await chromeCall("tabs", "update", tab.id, { url: destination.href });
  return { navigatingTo: destination.href };
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
  const dataUrl = await chromeCall("tabs", "captureVisibleTab", tab.windowId, {
    format: command.format || "png",
    quality: command.quality
  });
  return { url: tab.url, title: tab.title, dataUrl };
}

async function waitCommand(command) {
  const ms = Math.max(0, Number(command.ms || command.timeout || 0));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { waitedMs: ms };
}

async function handleCommand(command) {
  if (!command || !command.type) throw new Error("Missing command type.");
  if (command.type === "status") return publicState();
  if (command.type === "inspect") return inspect(command);
  if (command.type === "click") return click(command);
  if (command.type === "doubleClick" || command.type === "dblclick") return doubleClick(command);
  if (command.type === "move" || command.type === "hover") return move(command);
  if (command.type === "scroll") return scroll(command);
  if (command.type === "key" || command.type === "keypress") return keypress(command);
  if (command.type === "type") return typeText(command);
  if (command.type === "navigate" || command.type === "nav") return navigate(command);
  if (command.type === "reload") return reload(command);
  if (command.type === "back" || command.type === "forward") return history(command);
  if (command.type === "screenshot") return screenshot(command);
  if (command.type === "wait") return waitCommand(command);
  if (command.type === "stop" || command.type === "disarm") return disarm();
  throw new Error(`Unknown command type: ${command.type}`);
}

async function runBridgeCommand(command) {
  state.latestCommand = command;
  await storageSet({ state });
  try {
    const result = await handleCommand(command);
    state.latestResult = { id: command.id, ok: true, result, at: new Date().toISOString() };
    await storageSet({ state });
    await postEvent("command-result", state.latestResult);
  } catch (error) {
    state.latestResult = { id: command.id, ok: false, error: error.message, at: new Date().toISOString() };
    await storageSet({ state });
    await postEvent("command-result", state.latestResult);
  }
}

async function pollBridge() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const response = await fetch(`${BRIDGE_URL}/poll`, { cache: "no-store" });
    if (!response.ok) return;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== SOURCE) return false;
  if (message.type === "popup-command") {
    const action = message.action;
    const run =
      action === "arm" ? armActiveTab() :
      action === "disarm" ? disarm() :
      Promise.resolve(publicState());
    run.then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  storageSet({ state });
});

chrome.runtime.onStartup.addListener(() => {
  restoreState();
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  if (state.armed && tabId === state.armed.tabId) {
    updateArmedTabSnapshot(tab).catch(() => {});
  }
});

restoreState();
setInterval(pollBridge, 500);
pollBridge();
