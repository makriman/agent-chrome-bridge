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

The bridge listens on `127.0.0.1` only. CLI routes use `x-codex-bridge-token`. `/poll` and `/event` do not accept that operator token. They accept `x-codex-bridge-extension-token` only after `node bridge/control.mjs pair` binds one extension instance. The pairing code is single-use, and the extension session file is gitignored.

The content script is injected into the armed tab when a command needs the DOM. It does not accept `window.postMessage` from the page. Frame inspect, find, and fill go through `chrome.tabs.sendMessage` from this extension.

## Secrets and Data

- Never commit env files, provider keys, tokens, database dumps, or production user data.
- Keep model provider keys and integration credentials outside client bundles.
- Avoid logging personal data, private content, or raw secrets.

## Supported Versions

Security fixes target the current default branch unless maintainers announce a release policy.
