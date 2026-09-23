# Mac smoke checklist

Manual checks for the local Agent Chrome Bridge on a Mac. This file is documentation only. CI does not run these steps and does not need Mac hardware.

Run `npm run check` on any machine before this list. The checks below need a person's Chrome and are not a CI job.

## Before you start

- Node.js 20 or newer, Google Chrome, and a checkout of this repo.
- Do not commit `.bridge-token`, `.bridge-token.meta.json`, or anything under `artifacts/`.
- The bridge listens only on `127.0.0.1:18474`. Leave `AGENT_CHROME_BRIDGE_PORT`, `CODEX_CHROME_BRIDGE_PORT`, and `CODEX_CHROME_BRIDGE_URL` unset.

## 1. Start the bridge

```bash
cd "$HOME/Agent-Chrome-Bridge"
npm run bridge
```

- [ ] The log says `listening on http://127.0.0.1:18474`.
- [ ] The log prints a token fingerprint. Leave this shell running.
- [ ] If the port is already in use, the process exits. Do not arm until doctor in step 3 passes. See who is listening with `lsof -nP -iTCP:18474 -sTCP:LISTEN`.

## 2. Load the extension

- [ ] Open `chrome://extensions`, enable Developer mode, and Load unpacked `extension/`.
- [ ] If the extension was already installed, click Reload on its card so origin checks and final-action approval are the new service worker.
- [ ] Pin Agent Chrome Bridge.

## 3. Doctor

In a second shell, from the same checkout:

```bash
node bridge/control.mjs doctor
```

- [ ] `ok` is true and `protocolVersion` is `3`.
- [ ] `doctor.listen.port` is `18474` and `doctor.listen.pinned` is true.
- [ ] `doctor.tokenFile.matchesRunningBridge` is true.
- [ ] The fingerprint matches the bridge log. If doctor fails auth, stop and do not arm. A different program may own the port.

## 4. Status

```bash
node bridge/control.mjs status
```

- [ ] `connected` becomes true within a few seconds. A first `false` can be extension hello warm-up. Poll again.
- [ ] `latestExtensionState.armed` is null until you arm.

## 5. Arm

- [ ] In Chrome, open an `https://` page you can test on. One origin only.
- [ ] Open the extension popup and click **Arm tab**.
- [ ] The popup shows that origin and a `tokenFingerprint`.
- [ ] Compare the popup fingerprint with doctor. If they differ, click **Stop** and do not queue commands.
- [ ] `node bridge/control.mjs status` shows the armed origin and the same `armSessionId` the popup printed.

Arm does not follow the tab onto another origin. Reloading the same site keeps the arm. Navigating to a different site clears it.

## 6. Inspect

```bash
node bridge/control.mjs inspect 30
```

- [ ] The command status is `succeeded`.
- [ ] The result URL is the armed origin, without the query string.

## 7. Screenshot

```bash
node bridge/control.mjs screenshot artifacts/mac-smoke.png
```

- [ ] The PNG is written under `artifacts/`.
- [ ] The command result says the file was saved there.

Path confinement:

```bash
node bridge/control.mjs screenshot ../outside.png
node bridge/control.mjs screenshot /tmp/outside.png
```

- [ ] Both commands fail before writing a file outside `artifacts/`.

## 8. Origin and final-action checks

With the tab still armed on the original origin:

```bash
node bridge/control.mjs nav "javascript:alert(1)"
node bridge/control.mjs nav "https://example.com"
```

- [ ] `javascript:` is rejected.
- [ ] `https://example.com` is rejected when that origin is not the armed origin. Same-origin paths, such as `/`, are allowed.

```bash
node bridge/control.mjs click-text "Send"
node bridge/control.mjs key Enter
```

- [ ] Both fail and ask for a popup approval token. Nothing is submitted.

- [ ] In the popup, click **Approve final action** and copy the token.
- [ ] Retry one final action within 2 minutes:

```bash
node bridge/control.mjs click-text "Send" --approval-token <popup-token>
```

Use a page where a real Send click is safe. The token is single use and bound to the armed origin.

- [ ] `CODEX_CHROME_BRIDGE_APPROVE=1` does not replace the popup token.

## 9. Stop

- [ ] Popup **Stop**, or `node bridge/control.mjs stop` while the tab is armed.
- [ ] Status no longer shows an active arm.
- [ ] A command queued for the old arm is not picked up by a later arm. Arm again before the next inspect.

## Pass

Doctor authenticated the listener, arm stayed on one origin, inspect and the artifacts screenshot succeeded, escaped paths and non-http navigation were rejected, and a final action required the popup token.
