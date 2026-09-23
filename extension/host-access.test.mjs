import assert from "node:assert/strict";
import test from "node:test";
import { armedOriginPattern } from "./host-access.mjs";

test("armed host access is the http(s) origin only", () => {
  assert.equal(armedOriginPattern("https://shop.example/admin?token=1"), "https://shop.example/*");
  assert.equal(armedOriginPattern("http://localhost:3000/path"), "http://localhost:3000/*");
  assert.equal(armedOriginPattern("file:///tmp/a.html"), null);
  assert.equal(armedOriginPattern("chrome://extensions/"), null);
  assert.equal(armedOriginPattern("javascript:alert(1)"), null);
  assert.equal(armedOriginPattern(""), null);
  assert.equal(armedOriginPattern(null), null);
});
