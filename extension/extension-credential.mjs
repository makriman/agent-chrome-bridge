export const EXTENSION_TOKEN_HEADER = "x-codex-bridge-extension-token";
export const PROTOCOL_HEADER = "x-codex-bridge-protocol";
export const SESSION_HEADER = "x-codex-bridge-extension-session";
export const SESSION_PAIRED_VALUE = "paired";
export const CREDENTIAL_STORAGE_KEY = "extensionCredential";
export const PINNED_BRIDGE_ORIGIN = "http://127.0.0.1:18474";

export function pairedSessionHeaders(protocolVersion, bridgeInstanceId) {
  return {
    [PROTOCOL_HEADER]: String(protocolVersion),
    [SESSION_HEADER]: SESSION_PAIRED_VALUE,
    "x-codex-bridge-instance": String(bridgeInstanceId || "")
  };
}

export function headerLookup(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return String(headers.get(name) || headers.get(name.toLowerCase()) || "");
  }
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return direct == null ? "" : String(direct);
}

export function listenerAcceptedExtension(headers, expectedProtocol) {
  return headerLookup(headers, PROTOCOL_HEADER) === String(expectedProtocol)
    && headerLookup(headers, SESSION_HEADER) === SESSION_PAIRED_VALUE;
}

export function persistedStateWithoutCredential(savedState) {
  if (!savedState || typeof savedState !== "object") return savedState;
  const copy = { ...savedState };
  delete copy.extensionToken;
  delete copy.operatorFingerprint;
  return copy;
}

export function credentialFromRedeem(payload, extensionInstanceId) {
  if (!payload || payload.ok !== true || typeof payload.extensionToken !== "string" || payload.extensionToken.length < 32) {
    throw new Error(
      payload && payload.error
        ? payload.error
        : "Pairing response did not include an extension token. Run `node bridge/control.mjs pair` again."
    );
  }
  if (typeof extensionInstanceId !== "string" || !/^ext_[0-9a-f-]{36}$/i.test(extensionInstanceId)) {
    throw new Error("Extension instance id is missing. Reload the extension and pair again.");
  }
  if (typeof payload.operatorFingerprint !== "string" || !/^[a-f0-9]{12}$/.test(payload.operatorFingerprint)) {
    throw new Error("Pairing response did not include the bridge fingerprint. Restart `npm run bridge` and pair again.");
  }
  return {
    extensionToken: payload.extensionToken,
    extensionInstanceId,
    bridgeInstanceId: typeof payload.bridgeInstanceId === "string" ? payload.bridgeInstanceId : null,
    operatorFingerprint: payload.operatorFingerprint,
    pairedAt: new Date().toISOString()
  };
}

export async function sessionProofHex(extensionToken, nonce) {
  const normalized = String(nonce || "").trim().toLowerCase();
  const data = new TextEncoder().encode(`${extensionToken}:${normalized}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validProofNonce(nonce) {
  return typeof nonce === "string" && /^[a-f0-9]{32,128}$/.test(nonce.trim().toLowerCase());
}

export async function proofMatches(extensionToken, nonce, proof) {
  if (!validProofNonce(nonce) || typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = await sessionProofHex(extensionToken, nonce);
  if (expected.length !== proof.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ proof.charCodeAt(index);
  }
  return mismatch === 0;
}
