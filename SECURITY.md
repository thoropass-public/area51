# Security Policy

AREA 51 is security tooling, so we take the security of the project itself
seriously. Thanks for helping keep it and its users safe.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities in AREA 51
itself.** Report privately through GitHub's
[private vulnerability reporting](https://github.com/heylaika/area51/security/advisories/new),
which is the repository's **Security** tab → "Report a vulnerability".

Please include a description and the impact, steps to reproduce (a PoC if you
have one), the affected component (Black Holes worker, Autopilot worker,
dashboard, cleanup worker, or CLI), and any suggested fix.

## What to expect

- We'll acknowledge your report within a few business days.
- We'll keep you posted as we investigate and fix.
- We're happy to credit you in the release notes. Let us know if you'd like that.

## Scope

In scope: flaws in the AREA 51 codebase, which covers the Workers, the dashboard,
the `./a51` CLI, deploy scripts, and docs. Examples worth reporting are bypassing
the Autopilot bearer auth or its `/-/` fence, escaping the 60-minute read window,
reaching the `FILES` bucket from Autopilot, an auth bypass on the dashboard or
its Access integration, and injection in the dashboard.

Out of scope: issues in your own deployment's configuration, your Cloudflare
account, or the third-party targets you test with AREA 51.

## By design, not a vulnerability

AREA 51 intentionally exposes internet-reachable catch-all endpoints that capture
arbitrary inbound HTTP and email. **That is the tool's purpose.** "It captures
what anyone sends it" is expected behavior, not a security bug. Reports should
concern something an attacker can do that the operator did **not** intend, such
as reading another operator's captures or bypassing one of the boundaries above.
