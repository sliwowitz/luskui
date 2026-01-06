# Contributing

Thank you for helping improve Codex-in-Podman! Please use the tooling in this repo to keep changes consistent before opening a pull request or committing.

## Linting and formatting

We use ESLint and Prettier to keep TypeScript, JavaScript, and documentation files clean and consistent. Run the following commands and address any findings before committing changes:

- `npm run lint` — verifies code quality and fails on warnings.
- `npm run format` — formats supported files in-place using the shared Prettier rules.

The CI workflow runs `npm run lint` and `npm run format:check` for every push and pull request, so running these locally helps avoid surprises.
