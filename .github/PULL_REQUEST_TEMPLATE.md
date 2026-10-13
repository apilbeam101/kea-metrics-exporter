## What this changes

## Why

## Checklist

- [ ] `npm run typecheck && npm run lint && npm test && npm run build && npm run check` passes locally
- [ ] Commits are signed off (`git commit -s`). See [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] `docs/DESIGN.md` updated, if this changes exposed behaviour
- [ ] `docs/IMPLEMENTATION.md` updated, if this changes the build plan
- [ ] `CHANGELOG.md` `[Unreleased]` entry added
- [ ] No `write` command, command `arguments`, or `config-get` call introduced
- [ ] No private infrastructure details introduced in code, docs, comments or
      fixtures; any new fixture passes the sanitisation guard
