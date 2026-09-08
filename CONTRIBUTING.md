# Contributing to AREA 51

Thanks for helping improve AREA 51. Bug reports, new capture playbooks, and
setup/portability fixes are all especially welcome.

## Ground rules

- Be respectful and constructive.
- AREA 51 is **offensive-security tooling for authorized testing only.** Don't
  contribute anything designed to facilitate unauthorized access or illegal use.
- **Never commit secrets or real engagement data.** That means no API tokens, no
  account IDs, no live black-hole domains, no captured requests or emails, no
  client hostnames.
- **Use angle-bracket placeholders, never a domain that resolves.** Docs and
  examples say `<black-hole.tld>`, `<sub.black-hole.tld>`,
  `<other-black-hole.tld>`, `<you@domain.tld>`, `<teammate@domain.tld>`. They
  read as "fill this in", and unlike an invented domain they can never turn out
  to belong to somebody. A reader who pastes one gets an obvious error instead of
  a command that quietly targets a stranger.

## Before you start

Read **[CLAUDE.md](CLAUDE.md)** first. It documents the invariants that must not
be broken: D1/R2 write ordering, the Autopilot `/-/` fence, no `COUNT(*)`, no
frontend build step, `.env` as the only state. Several of them look like
accidents and aren't, and the reasoning behind each one is in
**[docs/decisions.md](docs/decisions.md)**.

## Development setup

AREA 51 deploys to **your own Cloudflare account**. There's no shared instance,
so you'll need Node.js 20+, the prerequisites listed in
[docs/guides/getting-started.md](docs/guides/getting-started.md), and a throwaway
domain to test against.

```bash
git clone https://github.com/thoropass-public/area51.git && cd area51
npm install
cp .env.example .env      # your own values; never commit this file
./a51 setup               # provision + deploy (idempotent, safe to re-run)
./a51 doctor              # acceptance test: checks bindings, probes live hosts
```

There is **no test suite**. `./a51 doctor` is how a deployment gets verified. For
CLI edits, syntax-check with `node --check <file>`; the CLI is plain ESM with no
build step. The `wrangler.toml` files are generated from `*.template` + `.env`
and are gitignored, so edit the template or `.env` and never the rendered file.

## Making a change

1. Fork and branch from `main`, naming it something like `fix/mail-parse` or
   `feat/blocklist-cidr`.
2. Keep the change focused. One logical change per PR.
3. **Match the surrounding style.** These files carry unusually thorough "why"
   comments; preserve them.
4. **Update the docs in the same commit.** `docs/` is tiered, and a behavior
   change has to update the matching page:
   - `docs/guides/` for setup, an operator workflow, or a failure mode
   - `docs/reference/` for a command or flag, a `.env` value, a route, a column
   - `docs/internals/` for how a runtime piece behaves
   - plus `docs/decisions.md` if you change a documented trade-off.
5. Run `node --check` on any edited CLI or worker JS, and `./a51 doctor` against
   a live deploy where it's relevant.
6. **Scrub your diff** for secrets and real infrastructure before pushing.

## Pull requests

Open the PR against `main` with a clear description of what changed, why, and
how you verified it. A maintainer will review it. Please be patient: this is a
community project maintained on a best-effort basis.

## License

By contributing, you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE) on an inbound=outbound basis (Apache-2.0 §5), so
no separate CLA is required. Don't add third-party code without confirming its
license is compatible and recording it in [NOTICE](NOTICE).
