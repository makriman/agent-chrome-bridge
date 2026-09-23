# Agent Chrome Bridge

**Give Grok Bot and other agents your Chrome.**

Local-only, user-armed Chrome control. Your session stays in your browser. Agents get the tab you arm — not a datacenter Chrome that Cloudflare already blocked.

Canonical repository: [github.com/makriman/Agent-Chrome-Bridge](https://github.com/makriman/Agent-Chrome-Bridge).

## Mission

Cloud Chrome is not user Chrome.

Agents running in datacenters, CI, or hosted browser farms hit Cloudflare **Verify you are human**, **Access denied**, and other bot-score walls that a signed-in personal Chrome tab does not. Exporting cookies, standing up a remote relay, or launching another headless farm does not fix that. Those approaches also ask the user to give up the session.

Agent Chrome Bridge keeps authentication in the user's Chrome profile. The user signs in normally, arms one tab, and lets Grok Bot or another local agent inspect and operate only that tab through a loopback control plane.

Shopify Partners is example proof of the same class of gate — not the product itself. Partner org IDs, Dev Dashboard IDs, and Polaris admin surfaces sit behind human-only challenges that datacenter Chrome fails. This repository exists so agents can work those pages in the user's real Chrome.

## What This Repository Contains

A Chrome extension plus a Node bridge on `127.0.0.1`. Arm a tab. Inspect, click, type, scroll, screenshot, and run workflows against that tab.

This tree is local-only. There is no remote relay and no MCP server here.

## Highlights

- Give Grok Bot and other agents your Chrome — one armed tab, credentials stay in Chrome.
- Inspect pages, click by ref, type, scroll, navigate, and capture screenshots.
- Run scripted workflows with dry-run and resume support.
- Local loopback only. The user arms the tab. The user can stop it.

## Compatibility

The GitHub repo is **Agent-Chrome-Bridge**. Older `codex-chrome-bridge` clone URLs redirect here. Keep that old name only for env vars, wire headers, and existing local checkout folders — not as the public repo slug.

| Surface | Name | Notes |
| --- | --- | --- |
| GitHub repo | `makriman/Agent-Chrome-Bridge` | Canonical slug (casing exact) |
| npm `name` | `codex-chrome-bridge` | Package alias only; display name is Agent Chrome Bridge |
| Extension message `source` | `codex-chrome-bridge` | Wire compat; do not rename |
| Auth header | `x-codex-bridge-token` | Operator CLI only; do not rename |
| Extension header | `x-codex-bridge-extension-token` | Paired extension on `/poll` and `/event` |
| Protocol | v3 | Restart the bridge and reload the extension after an upgrade |
| Listen address | `http://127.0.0.1:18474` | `doctor` fails closed on another host or port |
| Approval env | `CODEX_CHROME_BRIDGE_APPROVE` | Does not grant final actions. Use the popup approval from the arm draft |

Existing `~/codex-chrome-bridge` checkouts and `CODEX_CHROME_BRIDGE_*` scripts remain valid.

## Tech Stack

- Vanilla JavaScript Chrome extension
- Node.js ESM bridge server
- Local HTTP control API on 127.0.0.1
- Workflow scripts for repeatable browser tasks

## Getting Started

```bash
npm install
npm run bridge
node bridge/control.mjs doctor
```

Load `extension/` in `chrome://extensions` (Developer mode → Load unpacked). `doctor` exits 0 only when this checkout's token matches the live listener, the protocol is v3, the port is `127.0.0.1:18474`, and an extension session is paired. Before the first pair, `extension_unpaired` is expected.

```bash
node bridge/control.mjs pair
```

Paste the one-time code into the popup, or open the printed `http://127.0.0.1:18474/pair#…` page and click **Pair from tab**. `/poll` and `/event` reject unpaired clients. The extension stores its token in `chrome.storage.session` and asks the listener to prove it knows that token before sending the header. Reloading the unpacked extension clears the session — pair again. A bridge restart keeps `.bridge-extension-session`; re-arm, and pair again only if `doctor` still reports `extension_unpaired`.

Do not point `CODEX_CHROME_BRIDGE_URL` at another host or port. `doctor` fails closed if you do. Screenshot and workflow outputs stay under `artifacts/` (absolute paths and `..` are rejected by the path draft). Final actions — submit, purchase, delete, send, post, pay, and Enter — need the popup **Approve final action** from the arm draft. Do not treat `CODEX_CHROME_BRIDGE_APPROVE` or `--approve` as that approval. Mac smoke is human-run via [docs/MAC-SMOKE-CHECKLIST.md](docs/MAC-SMOKE-CHECKLIST.md). CI does not run it.

The 2026-09-23 findings are in [docs/SECURITY-REVIEW-2026-09-23.md](docs/SECURITY-REVIEW-2026-09-23.md). Agent notes are in [AGENTS.md](AGENTS.md).

## Quality Checks

```bash
npm run check
```

## Repository Notes

- Do not commit generated tokens, screenshots, or zip artifacts.
- The extension should only be loaded from a trusted local checkout.
- Pack the extension with `npm run zip` (writes `dist/agent-chrome-bridge-extension.zip`).

## Contributing

Contributions are welcome. The best contributions are specific, tested, and grounded in the product mission. Good places to help include documentation, accessibility, tests, bug reports, UI polish, data validation, and safer agent behavior.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Please do not open public issues for secrets, auth bypasses, data exposure, provider key leaks, or abuse vectors. Follow [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be direct, kind, and useful.

## License

MIT. See [LICENSE](LICENSE).
