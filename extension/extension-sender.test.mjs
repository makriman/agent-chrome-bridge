import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedExtensionSender } from "./extension-sender.mjs";

const id = "abcdefghijklmnopqrstuvwxyzabcdef";
const origin = `chrome-extension://${id}`;

test("accepts this extension and rejects page origins", () => {
  assert.equal(
    isTrustedExtensionSender({ id, origin, url: `${origin}/background.js` }, id),
    true
  );
  assert.equal(isTrustedExtensionSender({ id }, id), true);
  assert.equal(
    isTrustedExtensionSender({ id, origin: "https://shop.example", url: "https://shop.example/apps" }, id),
    false
  );
  assert.equal(
    isTrustedExtensionSender({ id, origin, url: "https://shop.example/apps" }, id),
    false
  );
  assert.equal(
    isTrustedExtensionSender({ id: "other-extension", origin, url: `${origin}/background.js` }, id),
    false
  );
  assert.equal(isTrustedExtensionSender(null, id), false);
  assert.equal(isTrustedExtensionSender({ id, origin: "null" }, id), false);
});
