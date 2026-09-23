# Security Policy

Security matters for this project because public repositories often connect to real users, provider APIs, deployment systems, or operational data.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security problems.

If you find a vulnerability, contact the repository owner privately with:

- A short summary.
- Steps to reproduce.
- The affected route, API, package, or workflow.
- Screenshots or logs with secrets removed.
- The impact you believe it may have.

If you are unsure whether something is security-sensitive, report it privately first.

## Report Privately

- Exposed API keys, OAuth secrets, database URLs, or tokens.
- Authentication or authorization bypasses.
- Cross-user data exposure.
- Prompt or tool behavior that leaks private data.
- Unsafe file, network, or database access.
- Admin route bypasses.
- Production data leaks.

## Local Control Plane

The bridge listens on `127.0.0.1:18474`. Protocol is v3. CLI routes use `x-codex-bridge-token`. `/poll` and `/event` do not accept that operator token. They accept `x-codex-bridge-extension-token` only after `node bridge/control.mjs pair` binds one extension instance. The pairing code is single-use. `.bridge-token` and `.bridge-extension-session` are gitignored. The extension keeps its token in `chrome.storage.session` only. Reloading the unpacked extension clears it; pair again. The extension will not send that token until `GET /session-proof` shows the listener knows it, and it will not run a command unless the response is marked protocol v3 and `paired`.

`node bridge/control.mjs doctor` fails closed unless this checkout's token fingerprint matches the live listener, the listener file matches the loaded token, the port is `127.0.0.1:18474`, the protocol matches, and `doctor.extensionSession.paired` is true. It does not print secrets. The CLI does not overwrite `.bridge-token` when it cannot read the file.

Screenshot and workflow paths belong under `artifacts/`. The path, origin-arm, and loopback draft rejects escapes, pins an arm to one http(s) origin, and requires popup **Approve final action** for submit, purchase, delete, send, post, pay, and Enter. `CODEX_CHROME_BRIDGE_APPROVE` is not that approval. Mac smoke is a human checklist, [docs/MAC-SMOKE-CHECKLIST.md](docs/MAC-SMOKE-CHECKLIST.md). CI does not run it.

Findings and residual status: [docs/SECURITY-REVIEW-2026-09-23.md](docs/SECURITY-REVIEW-2026-09-23.md) and [AGENTS.md](AGENTS.md).

The content script is injected into the armed tab when a command needs the DOM. It does not accept `window.postMessage` from the page. Frame inspect, find, and fill go through `chrome.tabs.sendMessage` from this extension.

## Secrets and Data

- Never commit env files, provider keys, tokens, database dumps, or production user data.
- Keep model provider keys and integration credentials outside client bundles.
- Avoid logging personal data, private content, or raw secrets.

## Supported Versions

Security fixes target the current default branch unless maintainers announce a release policy.
