# Mac smoke checklist

Manual checks for the local Agent Chrome Bridge on a Mac. This file is documentation only. CI does not run these steps and does not need Mac hardware.

Run `npm run check` on any machine before this list. That command syntax-checks the extension and bridge and runs `bridge/residuals.test.mjs`. The checks below need a person's Chrome.

Protocol stays at version 2. The extension still has no credential of its own. Compare fingerprints before arming. See [EXTENSION-CREDENTIAL.md](EXTENSION-CREDENTIAL.md).

## Before you start

- Node.js 20 or newer, Google Chrome, and a checkout of this repo.
- Do not commit `.bridge-token`, `.bridge-token.meta.json`, or anything under `artifacts/`.
- Do not paste the token file. Doctor and the popup show a 12-character fingerprint only.
- Leave the bridge on `127.0.0.1:18474`.

## 1. Start the bridge

```bash
cd "$HOME/Agent-Chrome-Bridge"
npm run bridge
```

- [ ] The log says `listening on http://127.0.0.1:18474`.
- [ ] The log prints a token fingerprint. Leave this shell running.
- [ ] If the port is already in use, do not arm. See who is listening with `lsof -nP -iTCP:18474 -sTCP:LISTEN`.

## 2. Load the extension

- [ ] Open `chrome://extensions`, enable Developer mode, and Load unpacked `extension/`.
- [ ] If the extension was already installed, click Reload on its card so the popup fingerprint check is the new service worker.
- [ ] Pin Agent Chrome Bridge.
- [ ] Open the popup. It says the extension has no credential of its own.

## 3. Doctor

In a second shell, from the same checkout:

```bash
node bridge/control.mjs doctor
```

- [ ] `ok` is true, `code` is `match`, and `protocolVersion` is `2`.
- [ ] `doctor.tokenFile.matchesRunningBridge` is true.
- [ ] `doctor.extensionCredential.present` is false.
- [ ] The fingerprint matches the bridge log. If doctor prints `token_mismatch`, `token_unverified`, `token_file_drift`, or `token_rejected`, stop and do not arm.
- [ ] `localTokenFile` has a fingerprint and no token string.

Public liveness, still without a token:

```bash
curl -s http://127.0.0.1:18474/public-status
curl -s http://127.0.0.1:18474/hello
```

- [ ] Both include `tokenFingerprint`.
- [ ] `/public-status` does not include `activeCommand` or command text.

## 4. Token mismatch (do not arm)

This step checks the failure path. Use a second checkout or a temporary copy of the repo, not a machine you do not own.

- [ ] In the copy, replace `.bridge-token` with a different 64-hex string that is not the running bridge's token.
- [ ] From that copy, `node bridge/control.mjs doctor` exits non-zero with `code` `token_mismatch`.
- [ ] The JSON has no token value. The running bridge log does not show the other file's token.
- [ ] Restore the copy or delete it. Arm only from the checkout whose doctor code is `match`.

A missing or unreadable `.bridge-token` prints `token_unreadable` and does not create or empty the file. Let `npm run bridge` create a missing token.

## 5. Status

```bash
node bridge/control.mjs status
```

- [ ] `connected` becomes true within a few seconds. A first `false` can be extension hello warm-up. Poll again.
- [ ] `latestExtensionState.armed` is null until you arm.
- [ ] `latestExtensionState.extensionCredential.present` is false.
- [ ] `latestExtensionState.listenerFingerprint` matches doctor.

## 6. Arm

- [ ] In Chrome, open an `https://` page you can test on.
- [ ] Open the extension popup. **Arm tab** stays disabled until a fingerprint is shown.
- [ ] Compare that fingerprint with doctor. If they differ, click **Stop** and do not continue.
- [ ] Check **I compared this fingerprint with doctor. It matches.** **Arm tab** enables. Click it.
- [ ] Changing or clearing the fingerprint clears the checkbox. Compare again before arming.
- [ ] `node bridge/control.mjs status` shows the armed tab and the same `armSessionId` the popup printed.

## 7. Inspect

```bash
node bridge/control.mjs inspect 30
```

- [ ] The command status is `succeeded`.
- [ ] The result URL is the armed tab, without the query string.

## 8. Stop

- [ ] Popup **Stop**, or `node bridge/control.mjs stop` while the tab is armed.
- [ ] Status no longer shows an active arm.

## Not part of this Mac list

`npm test` covers token-file reads that do not truncate, doctor classification for mismatched fingerprints, and the unpaired-probe rate limit. Do not burst `/hello` or `/public-status` by hand. Those routes return `429` after 30 requests in 10 seconds. `/poll` and `/event` are not given a new credential check in this pass.

## Pass

Doctor authenticated the listener with a matching fingerprint, the popup refused to arm until that fingerprint was confirmed, inspect succeeded on the armed tab, and a mismatched token file failed doctor without being overwritten.
