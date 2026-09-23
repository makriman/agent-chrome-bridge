# Agent Chrome Bridge — agent guide

Canonical public name: **Agent Chrome Bridge**.

Repository: [makriman/Agent-Chrome-Bridge](https://github.com/makriman/Agent-Chrome-Bridge). Older `codex-chrome-bridge` clone URLs redirect here. Wire compatibility still uses the `codex-chrome-bridge` package name, extension message source, `x-codex-bridge-token`, `x-codex-bridge-extension-token`, and `CODEX_CHROME_BRIDGE_*` env vars. Do not rename those.

## Product

Local-only Chrome MV3 extension plus a Node bridge. The user signs in with their normal Chrome profile, arms **one tab**, and a local agent drives that tab through `http://127.0.0.1:18474`. Protocol version is **3**.

The session stays in Chrome. This repo has no cookie export, no remote relay, and no MCP server.

Read first:

- [SKILL.md](SKILL.md) — operator skill and command reference
- [GROK_BOT.md](GROK_BOT.md) — Grok Bot host path
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md) — workflow runner and real wait APIs (`tab.sleep`, `tab.waitForText`, `tab.waitForUrl`, `tab.waitForSelector`; there is no `tab.wait`)
- [docs/partners-cookbook.md](docs/partners-cookbook.md) — Shopify Partners is an example gate, not the product
- [SECURITY.md](SECURITY.md) and [docs/SECURITY-REVIEW-2026-09-23.md](docs/SECURITY-REVIEW-2026-09-23.md) — 2026-09-23 localhost review. That write-up is the findings draft. This branch does not re-open the High poll/event or postMessage fixes.

## How to run

On the machine that has the user's Chrome:

```bash
npm install
npm run bridge
node bridge/control.mjs doctor
node bridge/control.mjs pair
```

Load `extension/` unpacked at `chrome://extensions`. Pair, open the target site, then click **Arm tab**. Agents cannot arm a tab for the user.

`doctor` exits 0 only when all of these are true:

- This checkout's `.bridge-token` fingerprint matches the live listener, and the listener's file matches the token it loaded.
- The URL is `http://127.0.0.1:18474` and the listener reports that port.
- `protocolVersion` is 3.
- `doctor.extensionSession.paired` is true.

Before the first pair, exit 1 with `extension_unpaired` is expected. Pair, then run `doctor` again. Do not arm on `token_mismatch`, `token_file`, `wrong_port`, `protocol_mismatch`, or `listener_unreachable`.

```bash
npm run check
```

`npm run check` is syntax plus unit tests. It does not start Chrome and it does not run Mac smoke.

A cloud VM is not the user's Mac. Do not ask them to paste cookies, a session dump, `.bridge-token`, `.bridge-extension-session`, or a pairing code.

## Extension credential

Pairing is `node bridge/control.mjs pair`. The user pastes the one-time code into the popup, or opens `http://127.0.0.1:18474/pair#…` and clicks **Pair from tab**. There is no second pairing protocol.

- The operator token in `.bridge-token` authorizes the CLI only (`x-codex-bridge-token`).
- The extension token is returned once by `/pair/redeem` and sent as `x-codex-bridge-extension-token`.
- `/poll` and `/event` reject unpaired clients and any other extension instance id.
- The extension stores that token in `chrome.storage.session` under `extensionCredential`. It is stripped from the rest of extension state, so it is not written to `chrome.storage.local`.
- Reloading the unpacked extension clears session storage. Pair again after every reload. A bridge restart keeps `.bridge-extension-session`; re-arm, and pair again only if `doctor` reports `extension_unpaired`.
- Before the extension sends its token, it calls `GET /session-proof?nonce=…` and checks that the listener can hash the token with that nonce. It also refuses poll commands whose response lacks protocol `3` and `x-codex-bridge-extension-session: paired`.

Do not print the pairing code, either token, or the session file.

## Safety

- Never commit or paste `.bridge-token`, `.bridge-token.meta.json`, `.bridge-extension-session`, or `.bridge-extension-session.meta.json`.
- Never export cookies, `document.cookie`, CDP `Network.getCookies`, or profile session files. `sendCdp` allowlists input and `Page.captureScreenshot` only.
- Do not add `<all_urls>`. Arm requests host access for that tab's http(s) origin. The debugger alarm detaches when the arm expires.
- Keep JSON bodies at or under 12 MiB. Do not extend a command lease past `deadlineAt`. Do not retain more than one screenshot data URL, and do not retain one over 8 MiB.
- The bridge is loopback-only. Do not bind `0.0.0.0`, add a tunnel, or turn this into a remote control plane.
- One armed tab. Do not add a second concurrent arm target.
- Keep screenshot paths and workflow `--run-dir` values under `artifacts/`. Absolute paths and `..` are rejected.
- Stop before submit, purchase, delete, send, post, pay, or Enter unless the user approved that action. Popup **Approve final action** mints the one-time token. `--approve` and `CODEX_CHROME_BRIDGE_APPROVE` are not that approval.
- Mac smoke is human-run. Follow [docs/MAC-SMOKE-CHECKLIST.md](docs/MAC-SMOKE-CHECKLIST.md) on a Mac with the user's Chrome. CI does not run that checklist and does not need Mac hardware.
- After a bridge restart, ask the user to arm the tab again.

## Drafts this branch depends on

This M4/L2/L3 draft is stacked on `cursor/residual-credential-doctor-docs-74c0` (open PR #7), which is stacked on `cursor/fix-poll-event-postmessage-e146` (open PR #5). Retarget it to `main` after PRs #4–#7 land. Do not merge it before that, and do not merge it in this pass.

This branch re-applies PR #6 (`cursor/medium-path-arm-loopback-c922`) on the tip of PR #9. It keeps the CDP allowlist, loopback-only required host permissions, arm-expiry debugger detach, token `chmod`, body cap, lease cap, and screenshot memory bound, and adds path confinement, an origin-scoped arm, popup final-action approval, and the pinned `127.0.0.1:18474` listener. PR #4 is the findings write-up. Do not merge or deploy this draft.

Do not merge until founder review.
