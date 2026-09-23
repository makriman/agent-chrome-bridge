const SOURCE = "codex-chrome-bridge";
const output = document.getElementById("output");
const fingerprint = document.getElementById("fingerprint");
const confirmFingerprint = document.getElementById("confirm-fingerprint");
const armButton = document.getElementById("arm");
let seenFingerprint = null;

function print(value) {
  output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function currentFingerprint(response) {
  const result = response && response.ok && response.result ? response.result : null;
  return result && result.listenerFingerprint ? result.listenerFingerprint : null;
}

function syncArm(fingerprintValue) {
  armButton.disabled = !fingerprintValue || !confirmFingerprint.checked;
}

function showFingerprint(response) {
  if (!response || response.ok === false) {
    syncArm(seenFingerprint);
    return;
  }
  const value = currentFingerprint(response);
  if (value !== seenFingerprint) {
    confirmFingerprint.checked = false;
    seenFingerprint = value;
  }
  fingerprint.textContent = value
    ? `Listener fingerprint: ${value}`
    : "Listener fingerprint: none. Start the bridge, then click Status. Do not arm.";
  syncArm(value);
}

function send(action) {
  chrome.runtime.sendMessage({ source: SOURCE, type: "popup-command", action }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      print(error.message);
      showFingerprint(null);
      return;
    }
    print(response);
    showFingerprint(response);
  });
}

confirmFingerprint.addEventListener("change", () => syncArm(seenFingerprint));
document.getElementById("arm").addEventListener("click", () => {
  if (armButton.disabled) return;
  send("arm");
});
document.getElementById("status").addEventListener("click", () => send("status"));
document.getElementById("disarm").addEventListener("click", () => send("disarm"));

send("status");
