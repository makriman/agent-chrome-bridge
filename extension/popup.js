const SOURCE = "codex-chrome-bridge";
const output = document.getElementById("output");

function print(value) {
  output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function send(action, extra = {}) {
  chrome.runtime.sendMessage({ source: SOURCE, type: "popup-command", action, ...extra }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      print(error.message);
      return;
    }
    print(response);
  });
}

document.getElementById("pair").addEventListener("click", () => {
  send("pair", { ticket: document.getElementById("pair-code").value });
});
document.getElementById("pair-tab").addEventListener("click", () => send("pair-tab"));
document.getElementById("arm").addEventListener("click", () => send("arm"));
document.getElementById("status").addEventListener("click", () => send("status"));
document.getElementById("disarm").addEventListener("click", () => send("disarm"));

send("status");
