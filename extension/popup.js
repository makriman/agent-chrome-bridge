const SOURCE = "codex-chrome-bridge";
const output = document.getElementById("output");

function print(value) {
  output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function send(action) {
  chrome.runtime.sendMessage({ source: SOURCE, type: "popup-command", action }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      print(error.message);
      return;
    }
    print(response);
  });
}

document.getElementById("arm").addEventListener("click", () => send("arm"));
document.getElementById("status").addEventListener("click", () => send("status"));
document.getElementById("disarm").addEventListener("click", () => send("disarm"));

chrome.storage.local.get("state", (saved) => {
  if (saved && saved.state) print(saved.state);
});
