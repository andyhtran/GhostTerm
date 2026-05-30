# Contributing

Thanks for helping improve GhostTerm. Keep changes focused, describe the user-visible behavior, and include the verification steps you ran.

## Local Setup

```bash
npm install
npm run lint:obsidian
npm run check
npm run build
```

`npm run build` compiles the Rust PTY helper and embeds it into the bundled plugin JavaScript.

For release-oriented verification, run:

```bash
npm run review:local
npm run review:workflow
```

`review:local` runs the Obsidian guideline lint, TypeScript check, production build, and runtime dependency audit. `review:workflow` runs `actionlint` against the release workflow through Nix.

## Pull Requests

- Update documentation when behavior, requirements, or limitations change.
- Keep generated build output out of commits.
- Include concise verification steps in the pull request description.
- For terminal behavior changes, cover both the TypeScript plugin path and the Rust helper path when relevant.

## Releases

Maintainers publish releases by tagging a version that exactly matches `manifest.json`. Release assets are limited to:

```text
main.js
manifest.json
styles.css
```
