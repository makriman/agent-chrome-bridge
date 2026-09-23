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

## Secrets and Data

- Never commit env files, provider keys, tokens, database dumps, or production user data.
- Keep model provider keys and integration credentials outside client bundles.
- Avoid logging personal data, private content, or raw secrets.

## Local bridge limits

The control server binds to `127.0.0.1:18474` only. Screenshot and workflow writes must stay inside `artifacts/`. An arm is limited to one http(s) origin. Submit, purchase, delete, send, post, pay, and Enter are blocked until the extension popup mints a one-time approval token. `CODEX_CHROME_BRIDGE_APPROVE` does not grant those actions.

`doctor` is the check that the process on that port holds this checkout's bridge token. Run it before arming. A different local program that binds the port first can still speak to the extension; do not arm when doctor fails.

## Supported Versions

Security fixes target the current default branch unless maintainers announce a release policy.
