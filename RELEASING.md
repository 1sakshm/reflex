# Releasing

## One-time setup

1. **npm:** the `reflex-ai` organization must exist on npmjs.com. Publishing uses **npm Trusted Publishing** (GitHub OIDC), so no token or 2FA code is involved. npm only lets you add a trusted publisher to a package that already exists, so the **first version of each package is published by hand**:
   ```bash
   npm login
   npm run build
   for p in core server bench cli; do npm publish --workspace packages/$p --access public; done
   ```
   Then, for **each** of `@reflex-ai/core`, `@reflex-ai/server`, `@reflex-ai/bench`, `@reflex-ai/cli`: npmjs.com → package → Settings → **Trusted Publisher** → GitHub Actions, with owner `1sakshm`, repository `reflex`, workflow `release.yml`, environment `npm`.
2. **PyPI:** for each of `reflex-laya` and `reflex-agent-client`, add a trusted publisher (a *pending* one if the project doesn't exist yet): owner `1sakshm`, repo `reflex`, workflow `release.yml`, environment `pypi`.
3. **GitHub:** the `npm` and `pypi` environments are created automatically on first use. Optionally add a required reviewer to them. The `NPM_TOKEN` secret is no longer needed.

## Each release

```bash
npm run version:set -- 0.2.0        # bumps every package, plugin manifest and Python version
# edit CHANGELOG.md: add a "## [0.2.0] - YYYY-MM-DD" section
npm install && npm run typecheck && npm test && npm run test:python && npm run build && node scripts/smoke-test.mjs
git commit -am "release: v0.2.0" && git tag v0.2.0 && git push && git push --tags
```

The `release` workflow verifies the tag matches the package versions, reruns all tests and the packed-tarball smoke test, then publishes. Already-published versions are skipped, so a partly failed release can be re-run from the Actions tab (**release → Run workflow**):

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
