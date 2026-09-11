# Contributing to Agent Chrome Bridge

Thank you for wanting to help.

This project exists because useful software gets better when people can understand it, run it, question it, and improve it. Contributions are welcome from engineers, designers, educators, operators, writers, testers, and curious users.

## How to Contribute

1. Open an issue for bugs, ideas, accessibility problems, documentation gaps, or confusing behavior.
2. Keep pull requests focused and easy to review.
3. Include screenshots or short recordings for UI changes.
4. Include reproduction steps for bugs.
5. Run the checks before asking for review.

## Local Setup

```bash
npm install
npm run bridge
node bridge/control.mjs doctor
```

## Checks

```bash
npm run check
```

## Pull Request Expectations

Please include:

- What changed.
- Why it changed.
- How it was tested.
- Screenshots for visual changes.
- Any migration, environment, deployment, or data notes.

## Areas That Need Care

- Product clarity: make the experience easier to understand.
- Accessibility: keyboard navigation, semantic markup, contrast, and screen reader support.
- Reliability: tests, validation, error states, and deployment hygiene.
- Security: keep secrets server-side and avoid logging private user data.
- Documentation: help the next contributor build context quickly.

## Code Style

- Prefer the patterns already used in the repository.
- Keep changes scoped.
- Avoid new dependencies unless they remove real complexity.
- Add comments only where they explain non-obvious behavior.
- Never commit real secrets, production data, provider keys, or private user content.

## Community

Be generous with context. Assume people are here because they care about making the project better.
