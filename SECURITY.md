# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via
[GitHub security advisories](https://github.com/1sakshm/reflex/security/advisories/new).
You should get a response within 7 days. Please include a minimal reproduction.

## Scope

Reflex makes decisions about which actions an AI agent runs, so these are in scope:

- Any way to make Reflex **auto-execute a `destructive` action**, or a `stateful` action without `allowStateful`.
- Any way for `decide()` to **throw, hang, or exceed `timeoutMs`** (fail-open bypass).
- Bypassing `REFLEX_DISABLE` / `REFLEX_MODE`.
- **Secrets reaching traces or policies** despite redaction.
- Claude Code hook bypasses: destructive commands that aren't flagged, or a hook crash that blocks legitimate work.
- Sidecar exposure: unauthenticated access when bound to a non-loopback host.

## Known limitations

- **Prompt injection is not solved.** Tool outputs the agent reads can try to steer decisions. Reflex's protections are structural (risk classes, never auto-executing destructive actions, rules, audit sampling), not a guarantee that a decision is correct.
- Risk classes are declared by the integrator. An action wrongly declared `safe` will be treated as safe.
- The Claude Code destructive-command check is a best-effort parser, not a sandbox.

## Supported versions

Security fixes are released for the latest minor version.
