import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isTrustedExtensionSender } from "./extension-sender.mjs";

test("content script does not accept page postMessage", async () => {
  const source = await readFile(new URL("./content.js", import.meta.url), "utf8");
  assert.equal(source.includes("postMessage"), false);
  assert.equal(source.includes("addEventListener(\"message\""), false);
  assert.equal(source.includes("addEventListener('message'"), false);
  const match = source.match(/function isTrustedExtensionSender\(sender, extensionId\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "content script is missing the extension sender check");
  const normalized = match[0].replace(/\s+/g, " ").trim();
  const exported = isTrustedExtensionSender.toString().replace(/\s+/g, " ").trim();
  assert.equal(normalized, exported);
});

test("content script is not declared on every http page", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("webNavigation"));
  assert.ok(manifest.permissions.includes("scripting"));
});
