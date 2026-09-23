# Security review — 2026-09-23

Point-in-time review of Agent Chrome Bridge at `d2abca39f9541648a5181accabd135b071a3ca57` (`main`). Static reading of the bridge, extension, CLI, SDK, and workflow runner. No Chrome exploit run, no live armed-tab session, and no token material is included here.

## Risk posture

The product boundary is right: the server listens on `127.0.0.1` only, the token file is gitignored and created mode `0600`, the status HTML does not embed the token, and there is no cookie-export API in this tree. A remote internet client cannot open the port directly.

The local control plane is weaker than that boundary suggests. The extension polls and posts results **without** the bridge token, and those routes accept any loopback client. Separately, the content script is injected into every HTTP(S) frame and treats `window.postMessage` as a trusted control channel, so a page can use the extension outside an armed tab. Final-action approval exists only in the workflow SDK, not in the bridge or the extension.

Treat this as **not safe to expose beyond the user's own loopback**, and as **incomplete against other local programs and hostile pages** while the extension is installed.

Do not merge the docs PR that carries this review until the founder or Chief has read it. Fixes below are recommendations, not implemented in that PR.

## Method

Reviewed:

- `bridge/server.mjs`, `bridge/control.mjs`, `bridge/sdk.mjs`, `bridge/run-workflow.mjs`, `bridge/protocol.mjs`
- `extension/manifest.json`, `extension/background.js`, `extension/content.js`, `extension/popup.js`, `extension/popup.html`
- `.gitignore`, `SECURITY.md`, `README.md`, `SKILL.md`, `GROK_BOT.md`, `docs/ROADMAP.md`, `docs/WORKFLOWS.md`

Checked for: bind address, CORS, HTTP auth (there is no WebSocket server), token file handling, cookie/session export, extension permissions, CDP surface, screenshot path handling, token leakage, and multi-agent / stale-arm behavior.

`path.resolve` / `new URL` notes below were checked with Node on this machine. Chrome's reaction to non-HTTP `tabs.update` URLs and to Private Network Access was **not** runtime-tested.

## What is in good shape

- Bind address is the constant `127.0.0.1`, not `0.0.0.0` (`bridge/server.mjs`).
- `.bridge-token` and `.bridge-token.meta.json` are gitignored. New token files are written with mode `0o600`. Startup logs print the path and a 12-hex SHA-256 fingerprint, not the token.
- The loopback status page is static and fetches `/public-status` only. That payload has no raw token.
- Authenticated routes (`/command`, `/result`, `/queue`, `/flush`, `/cancel`, `/status`, `/doctor`) require header `x-codex-bridge-token`. The header is not taken from the query string.
- No `chrome.cookies` permission. No `document.cookie` read. No CDP `Network.getCookies` / `Network.getAllCookies`. Searched the tree; none are present.
- Browser commands go through `assertCommandArm`. A command whose `armSessionId` does not match the current arm fails as `stale_arm`. Arm lasts 30 minutes. Popup `arm` is not forwarded from the page `postMessage` handler.
- Inspect redacts query strings and a heuristic set of sensitive input values. Screenshot data URLs are stripped from command summaries and the in-memory event log.
- No `child_process` / shell execution of command fields. The `lsof | xargs kill` text is an error hint, not something the server runs.

## Findings

### H1 — Unauthenticated `/poll` and `/event` (command theft, result forgery, state spoofing)

**Severity:** High

**Where:** `bridge/server.mjs` (`/poll` around the `leaseNextCommand` response, `/event` around `updateFromEvent`), `extension/background.js` (`pollBridge`, `postEvent`).

**Evidence:** `requireToken` is applied to `/command`, `/result`, `/status`, `/doctor`, `/queue`, `/flush`, and `/cancel`. It is not applied to `GET /poll` or `POST /event`. `/poll` returns the leased command object itself (type, `text`, `url`, `output`, and the rest of the client payload), then removes it from `pendingIds`. `/event` will:

- replace `latestExtensionState` from `event.state`
- mark a known command `succeeded` / `failed` from `event.payload` with no check that the caller is the extension
- create a command record for an id the bridge did not queue
- refresh `leaseExpiresAt` on `command-heartbeat`

There is no terminal-state guard, so a later event can overwrite a real result. The extension never sends `x-codex-bridge-token`; it cannot, because it does not have the token. CORS on JSON responses is `access-control-allow-origin: *` with `POST` and the token header allowed.

**Impact:** Any process that can connect to `127.0.0.1:18474` can do this without reading `.bridge-token` (mode `0600` does not stop them). That includes other OS users on the same machine, a local dev server's origin, and malware that cannot read the home directory. Practical effects:

- Steal the next queued command, including text the agent was about to type.
- Leave the real extension with nothing to run, then `POST /event` a fake `command-result` so the CLI/SDK treats the action as succeeded.
- Swap a screenshot `dataUrl` before `saveScreenshot` writes the file the operator asked for.
- Publish a fake armed URL/title into `/status`, which workflows use for `assertUrl`.

Enqueueing a new click still requires the token. This finding is theft and forgery of the channel, not an unauthenticated "drive Chrome" API by itself.

**Browser caveat (unknown, not claimed as exploited):** current Chrome Private Network Access often blocks public websites from reading loopback responses unless the server sends `Access-Control-Allow-Private-Network: true`. This server does not send that header. A public-website attack was not verified. A page already served from `127.0.0.1` or `localhost` is a loopback origin and is not saved by that control. Host is not checked, so DNS rebinding depends entirely on the browser.

**Repro sketch (local operator only):** with the bridge running and a command queued, `GET /poll` from another shell returns the command and the extension no longer receives it. `POST /event` with `type: "command-result"` and that id updates `/result` for a token holder. Do not point this at a machine you do not own.

**Fix:** Give the extension its own loopback credential (separate from the operator token, delivered once through the native install or a user-confirmed pairing page). Require it on `/poll` and `/event`. Ignore result/state events whose `extensionInstanceId` was not the paired one. Reject result updates for unknown ids and for commands already in a terminal state. Restrict CORS to no origin (extension fetches are not subject to page CORS) or to an explicit null policy. Reject `Host` values other than `127.0.0.1` and `localhost`. Do not add `Access-Control-Allow-Private-Network`.

### H2 — Content script accepts page `postMessage` on every frame

**Severity:** High

**Where:** `extension/manifest.json` (`content_scripts.matches` `http://*/*` and `https://*/*`, `all_frames: true`), `extension/content.js` (`window.addEventListener("message", …)` and `frame.contentWindow.postMessage(request, "*")`).

**Evidence:** The listener accepts any event whose `data.source` is the public string `codex-chrome-bridge`. It does not check `event.origin`, and it cannot distinguish the extension's own frame messages from the page's: both are `window.postMessage` into the same frame. On `inspect` it replies to `event.source` with interactive text, roles, and selectors. On `setValue` it focuses a matched element and assigns `value` / `textContent`, including password-like fields (redaction applies to **reads**, not writes). Replies use target origin `"*"`.

The same script is injected into every HTTP(S) frame whether or not a tab is armed. Arming is enforced in `background.js` for bridge commands only. The page message handler never calls `chrome.runtime` to arm, which is good, but it does not need the bridge for inspect/fill.

Isolated worlds stop the page from reading content-script variables. They do not stop this, because the privileged action is triggered by a message the page is allowed to send.

**Impact:** A third-party iframe on a site the user visits can `postMessage` the parent and receive the parent's interactive inventory, or set input values in the parent, without a user arm. The other direction works when a victim origin can be framed. This is broader than the armed-tab product promise. It is not a cookie-jar export; `elementText` also blanks values whose attributes look like passwords, email, cards, or OTPs. Anything else visible on a button, link, or non-matching input can leave the frame.

**Fix:** Remove privileged behavior from `window` messages. Route frame inspect/find/fill through `chrome.tabs.sendMessage` / the service worker, which page scripts cannot forge. Until that lands, stop declaring content scripts on all URLs and inject `content.js` only into the armed tab. An `event.origin` check alone does not fix it.

### M1 — Screenshot and workflow paths are not confined to the repo

**Severity:** Medium

**Where:** `bridge/control.mjs` `saveScreenshot` (`resolve(ROOT, command.output)`), `bridge/sdk.mjs` `outputPath` (absolute paths returned unchanged; relative paths `resolve`d), `bridge/run-workflow.mjs` `--run-dir` (`resolve(ROOT, flag)`).

**Evidence:** Node `path.resolve(root, absolutePath)` returns the absolute path. `path.resolve("/tmp/repo", "../../.ssh/authorized_keys")` leaves the repo (`/.ssh/authorized_keys` in that example). The CLI writes decoded screenshot bytes to that path after `mkdir`. The SDK does the same. `--run-dir` can place `state.json`, logs, and a copy of the workflow outside the tree. JSON workflow `screenshot` steps pass `step.output` through the same helper.

There is no shell interpolation. The write is still an arbitrary overwrite of any path the Node process can write. A prompt-injected agent or a malicious workflow file is enough; the operator does not have to type the path by hand. Combined with H1, a forged screenshot `dataUrl` is what gets written to whatever path the honest client already chose.

**Fix:** Resolve under a single artifacts root and reject results whose normalized path is not `root + path.sep` prefixed. Refuse absolute paths and `..` after normalization. Apply the same check to `--run-dir`.

### M2 — Arm is tab-scoped, navigation schemes are unfiltered, and final-action approval is not enforced

**Severity:** Medium

**Where:** `extension/background.js` `armActiveTab`, `updateArmedTabSnapshot`, `navigate`; `bridge/server.mjs` `queue`; `bridge/sdk.mjs` `requireApproval`; `docs/ROADMAP.md` (approval tokens still listed as future work).

**Evidence:**

- Arm stores `tabId` plus a 30-minute `armSessionId`. Tab URL updates on `tabs.onUpdated` do not rotate the session. After arm, `navigate` may send the same tab anywhere `new URL(command.url, tab.url)` accepts.
- Node accepts `javascript:`, `file:///…`, and `chrome://…` as `new URL` results. `background.js` passes `destination.href` to `chrome.tabs.update` with no scheme allowlist. Whether Chrome blocks those schemes for this extension was **not** runtime-tested. `https://` navigation to a different site while the same arm remains valid **is** what the code does.
- `click`, `type`, `fill`, `key` (including Enter), and `navigate` run whenever the tab is armed. `requireApproval` only throws inside the SDK. `POST /command` never sees it. `--approve` and `CODEX_CHROME_BRIDGE_APPROVE=1` auto-grant the SDK gate (`bridge/sdk.mjs`). The roadmap's `confirm-write` / approval-token model is not implemented on the wire.

**Impact:** One Arm click is 30 minutes of control of that tab, including sites it is later navigated to. Submit, purchase, delete, and send are policy text in `SKILL.md` / `GROK_BOT.md`, not a bridge check. Any holder of `.bridge-token` (any same-user process) can skip the SDK gate with `/command`.

**Fix:** Pin the arm to origin (or eTLD+1) and require a new arm, or a user prompt, when the origin changes. Allowlist `http:` and `https:` before `tabs.update`. For high-risk command classes, require a short-lived approval token that only the popup can mint. Keep `--approve` from being a silent env-wide bypass.

### M3 — Extension trusts whoever is bound to `127.0.0.1:18474`; one queue for every agent

**Severity:** Medium

**Where:** `extension/background.js` `BRIDGE_URL` constant; `bridge/server.mjs` single `pendingIds` queue; `bridge/control.mjs` / `bridge/sdk.mjs` `CODEX_CHROME_BRIDGE_URL`.

**Evidence:** The extension always uses `http://127.0.0.1:18474`. It does not read `AGENT_CHROME_BRIDGE_PORT` / `CODEX_CHROME_BRIDGE_URL`, and it does not authenticate the process that answers `/hello` and `/poll`. If the operator moves the real bridge with `AGENT_CHROME_BRIDGE_PORT`, the extension still talks to 18474. A process that binds 18474 first can feed commands to an armed tab (the extension will `handleCommand` whatever JSON `/poll` returns).

Commands stamped with the current `armSessionId` are leased to that arm even if a different local agent queued them. There is no per-agent lock. Any token holder can `/flush` or `/cancel` another agent's in-flight work. A command queued while nothing is armed stores `armSessionId: null`; the lease check only rejects a mismatch when **both** sides have an id, so that command is delivered to whichever tab is armed at pickup.

Stale-arm handling itself works when both ids are present and differ (`leaseNextCommand` and `assertCommandArm`).

**Fix:** Pair the extension to a bridge instance (H1 credential plus `bridgeInstanceId` pinned at arm time). Teach the extension the configured port, or refuse to start when the port is not 18474. Stamp every command with the arm id at enqueue and refuse to lease when the extension's arm id is missing. Optionally take a per-run queue id so two agents cannot interleave clicks on one arm.

### M4 — Extension permissions are wider than one armed tab

**Severity:** Medium

**Where:** `extension/manifest.json`.

**Evidence:** Permissions are `activeTab`, `debugger`, `scripting`, `storage`, `tabs`, plus host `<all_urls>` and the loopback bridge. `activeTab` does not narrow `<all_urls>`. Content scripts match all HTTP(S) frames (H2). `chrome.debugger` is attached to the armed tab and `sendCdp` can issue any CDP method; current callers use `Input.*` and `Page.enable` / `Page.captureScreenshot` only. There is no method allowlist, so a later patch or a compromised service worker can call `Network.getCookies` without a manifest change. The debugger is not detached when the 30-minute arm expires; detach runs on disarm, tab close, or the next failed command.

**Fix:** Drop `<all_urls>` if the CDP screenshot path is enough, or request host access only after arm. Inject scripts only into the armed tab. Wrap `sendCdp` in an allowlist. Detach on expiry with an alarm. Keep cookie CDP methods permanently out of the allowlist.

### L1 — Unauthenticated public metadata

**Severity:** Low

**Where:** `bridge/server.mjs` `/public-status`, `statusPayload({ publicOnly: true })`, CORS headers in `json()`.

**Evidence:** `/public-status` needs no token. It returns bridge instance id, protocol version, token fingerprint (12 hex chars, not the token), connection timestamps, pending count, and the active command summary (id, type, output path, error, summarized result). CORS `*` lets any browser origin that can reach loopback read it. The fingerprint does not make the 256-bit token guessable. The HTML page does not inline the token.

**Fix:** Remove the fingerprint and active-command body from the public payload. Keep a liveness boolean for the status page.

### L2 — Token file handling edge cases

**Severity:** Low

**Where:** `bridge/server.mjs` `loadToken`; `bridge/control.mjs` `token()`.

**Evidence:** Comparison is `===`, not a constant-time compare. Practical timing value on loopback against a 256-bit token is negligible; noted so nobody "fixes" it by logging the header. `writeFile(..., { mode: 0o600 })` does not change the mode of a pre-existing file. If the CLI cannot **read** the token file, it `writeFile`s an empty string over that path and then throws because the length is under 32, which can destroy a token the running server still holds in memory. The server loads the token once at startup; a replaced file is ignored until restart (`doctor` reports `matchesRunningBridge`).

**Fix:** On read failure, do not truncate an existing file. `chmod 0600` when loading. Compare with `crypto.timingSafeEqual` on equal-length buffers.

### L3 — Local resource bounds

**Severity:** Low

**Where:** `bridge/server.mjs` `body()`, `updateFromEvent` heartbeat branch; `extension/background.js` `withTimeout` vs heartbeat.

**Evidence:** Request bodies are buffered with no size cap before `JSON.parse`. Screenshot results keep the full data URL on the in-memory command until the process exits (`/result` returns it to token holders on purpose; summaries strip it). Each `command-heartbeat` pushes `leaseExpiresAt` out by the full `timeoutMs`, and `/event` is unauthenticated (H1), so a caller can keep a lease alive. The extension's own `withTimeout` still bounds the real Chrome work.

**Fix:** Cap body size (for example 8 MB once screenshots are out of band, or a documented higher cap). Stop extending the lease past the original deadline. Write screenshots to a file from the extension side or stream them so `/result` does not hold the pixels.

### I1 — No cookie or session export path in this tree

**Severity:** Info (positive)

No `chrome.cookies`, no cookie CDP calls, no code that writes `Cookie` headers from the profile. Page **content** still leaves the machine as inspect text and screenshots; that is the product, and it can include data the user can see (account numbers on screen, CSRF tokens rendered into the DOM). Query strings are stripped in sanitized URL fields, not inside inspect text.

Residual: M4's unrestricted `sendCdp` means cookie export is one new call site away. The roadmap's blocked list already says never to add it.

### I2 — Token not written to the status page or bridge logs

**Severity:** Info (positive)

`html()` does not interpolate the token. `console.log` on listen prints `TOKEN_PATH` and `fingerprint`. `/doctor` (authenticated) returns path, length, mtime, fingerprint, and `matchesRunningBridge`, not the secret. `.bridge-token.meta.json` stores the fingerprint and path only.

### I3 — No WebSocket server

**Severity:** Info

Transport is HTTP polling. The roadmap's WebSocket is not implemented. Auth work should happen on `/poll` and `/event` before a socket is added, or the socket will inherit H1.

## Unknowns

- Chrome Private Network Access behavior against this server from a public origin was not tested in a browser.
- `chrome.tabs.update` to `javascript:`, `file:`, or `chrome:` was not tested. The extension does not filter schemes; the browser might.
- `chrome.storage.session` lifetime across a full browser restart was not tested. The code prefers session storage and falls back to `chrome.storage.local` if session storage is missing, which would persist arm state longer.
- Whether a second Node process on another port can confuse a customized CLI while the extension stays on 18474 follows from the code, but was not demonstrated against a running Chrome.

## Suggested order of work

1. H1 pair the extension and authenticate `/poll` and `/event`.
2. H2 move frame IPC off `postMessage`; inject only into the armed tab.
3. M1 confine filesystem writes.
4. M2 origin pin, `http`/`https` allowlist, and a real approval token for final actions.
5. M3 pin bridge instance and port; do not lease commands with a null arm id.
6. M4 CDP allowlist and narrower host permissions.

Large refactors (WebSocket transport, MCP, side panel) are out of scope for this review's PR.
