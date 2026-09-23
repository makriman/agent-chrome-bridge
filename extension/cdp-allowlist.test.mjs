import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertCdpMethodAllowed, CDP_ALLOWED_METHODS } from "./cdp-allowlist.mjs";

const DENIED = [
  "Network.getCookies",
  "Network.getAllCookies",
  "Storage.getCookies",
  "Page.getCookies",
  "Network.enable",
  "Runtime.evaluate",
  "Browser.getWindowForTarget"
];

test("CDP allowlist is only the input and screenshot methods the extension calls", () => {
  assert.deepEqual(CDP_ALLOWED_METHODS, [
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Page.enable",
    "Page.captureScreenshot"
  ]);
  for (const method of CDP_ALLOWED_METHODS) assertCdpMethodAllowed(method);
});

test("cookie and other CDP methods stay out of the allowlist", () => {
  for (const method of DENIED) {
    assert.throws(() => assertCdpMethodAllowed(method), /CDP method is not allowed/);
  }
  assert.equal(CDP_ALLOWED_METHODS.some((method) => /cookie/i.test(method)), false);
});

test("manifest drops all_urls and the service worker detaches the debugger when the arm expires", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1:18474/*",
    "http://localhost:18474/*"
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.permissions.includes("debugger"));
  assert.equal(manifest.content_scripts, undefined);

  const background = await readFile(new URL("./background.js", import.meta.url), "utf8");
  assert.match(background, /assertCdpMethodAllowed\(method\)/);
  assert.match(background, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(background, /arm_expired/);
  assert.match(background, /async function clearArm[\s\S]*detachDebugger\(/);
  assert.equal(background.includes("Network.getCookies"), false);
  assert.equal(background.includes("<all_urls>"), false);

  const popup = await readFile(new URL("./popup.js", import.meta.url), "utf8");
  assert.match(popup, /chrome\.permissions\.request/);
  assert.match(popup, /armedOriginPattern/);
});
