import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  credentialFromRedeem,
  listenerAcceptedExtension,
  persistedStateWithoutCredential,
  proofMatches,
  sessionProofHex,
  validProofNonce
} from "./extension-credential.mjs";

const EXTENSION_ID = "ext_11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(64);

test("redeem stores the extension token and operator fingerprint, not a second protocol", () => {
  const credential = credentialFromRedeem({
    ok: true,
    extensionToken: TOKEN,
    bridgeInstanceId: "br_1",
    operatorFingerprint: "abc123abc123"
  }, EXTENSION_ID);
  assert.equal(credential.extensionToken, TOKEN);
  assert.equal(credential.operatorFingerprint, "abc123abc123");
  assert.equal(credential.extensionInstanceId, EXTENSION_ID);
  assert.throws(
    () => credentialFromRedeem({ ok: true, extensionToken: TOKEN, bridgeInstanceId: "br_1" }, EXTENSION_ID),
    /fingerprint/
  );
});

test("persisted arm state drops the extension token", () => {
  const saved = persistedStateWithoutCredential({
    extensionInstanceId: EXTENSION_ID,
    extensionToken: TOKEN,
    operatorFingerprint: "abc123abc123",
    armed: { tabId: 1 }
  });
  assert.equal(saved.extensionToken, undefined);
  assert.equal(saved.operatorFingerprint, undefined);
  assert.equal(saved.armed.tabId, 1);
});

test("commands require a paired protocol header from the listener", () => {
  assert.equal(listenerAcceptedExtension({
    get(name) {
      const headers = {
        "x-codex-bridge-protocol": "3",
        "x-codex-bridge-extension-session": "paired"
      };
      return headers[name];
    }
  }, 3), true);
  assert.equal(listenerAcceptedExtension({ get: () => "" }, 3), false);
  assert.equal(listenerAcceptedExtension({
    "x-codex-bridge-protocol": "2",
    "x-codex-bridge-extension-session": "paired"
  }, 3), false);
});

test("session proof matches only the extension token and nonce", async () => {
  const nonce = "ab".repeat(16);
  assert.equal(validProofNonce(nonce), true);
  assert.equal(validProofNonce("short"), false);
  const proof = await sessionProofHex(TOKEN, nonce);
  assert.equal(await proofMatches(TOKEN, nonce, proof), true);
  assert.equal(await proofMatches(TOKEN, `${nonce.slice(0, -1)}c`, proof), false);
  assert.equal(await proofMatches(`${TOKEN.slice(0, -1)}b`, nonce, proof), false);
  assert.equal(proof.includes(TOKEN), false);
});

test("background keeps the extension token in session storage and checks the listener", () => {
  const background = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  assert.match(background, /extension-credential\.mjs/);
  assert.match(background, /chrome\.storage\.session/);
  assert.match(background, /persistedStateWithoutCredential/);
  assert.match(background, /ensureListenerProof/);
  assert.match(background, /listenerAcceptedExtension/);
  assert.doesNotMatch(background, /chrome\.storage\.local\.set\(\s*\{[^}]*extensionToken/);
  assert.match(background, /127\.0\.0\.1:18474/);
  assert.doesNotMatch(background, /localhost:18474/);
});
