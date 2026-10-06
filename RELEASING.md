# Releasing

## One-time setup

1. **npm:** create the `reflex-ai` organization at npmjs.com (free for public packages). Create an automation token with publish rights and add it to the GitHub repo as the secret `NPM_TOKEN`, in an environment named `npm`.
2. **PyPI:** for both `reflex-laya` and `reflex-agent-client`, add a *pending trusted publisher* at pypi.org (Account → Publishing): owner `1sakshm`, repo `reflex`, workflow `release.yml`, environment `pypi`.
3. **GitHub:** create the environments `npm` and `pypi` (Settings → Environments). Optionally require a reviewer.

## Each release

```bash
npm run version:set -- 0.2.0        # bumps every package, plugin manifest and Python version
# edit CHANGELOG.md: add a "## [0.2.0] - YYYY-MM-DD" section
npm install && npm run typecheck && npm test && npm run test:python && npm run build && node scripts/smoke-test.mjs
git commit -am "release: v0.2.0" && git tag v0.2.0 && git push && git push --tags
```

The `release` workflow verifies the tag matches the package versions, reruns all tests and the packed-tarball smoke test, then publishes:

- npm, in dependency order with provenance
- PyPI, via trusted publishing
- a GitHub release with the CHANGELOG notes

## Manual publish (fallback)

```bash
npm login
npm run build
for p in core server bench cli; do npm publish --workspace packages/$p --access public; done
python -m build python/reflex-laya -o dist && python -m build python/reflex-agent-client -o dist && twine upload dist/*
```
