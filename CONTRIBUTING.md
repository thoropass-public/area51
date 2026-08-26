# Contributing to AREA 51

Thanks for helping improve AREA 51! Bug reports, new capture playbooks, and
setup/portability fixes are all especially welcome.

## Ground rules

- Be respectful and constructive.
- AREA 51 is **offensive-security tooling for authorised testing only.** Don't
  contribute anything designed to facilitate unauthorised access or illegal use.
- **Never commit secrets or real engagement data** — no API tokens, account IDs,
  live black-hole domains, captured requests/emails, or client hostnames. Use
  placeholder domains (e.g. `oob.example`) in docs and examples.

## Before you start

Read **[CLAUDE.md](CLAUDE.md)** first. It documents the invariants that must not
be broken (D1↔R2 ordering, the Autopilot `/-/` fence, no `COUNT(*)`, no frontend
build step, `.env` as the only state). Several of these look like accidents and
are not — the reasoning is in **[docs/decisions.md](docs/decisions.md)**.

## Development setup

AREA 51 deploys to **your own Cloudflare account** — there's no shared instance.
You'll need Node.js 20+, the prerequisites in
[docs/guides/getting-started.md](docs/guides/getting-started.md), and a throwaway
domain to test against.

```bash
git clone https://github.com/heylaika/area51.git && cd area51
npm install
cp .env.example .env      # your own values; never commit this file
./a51 setup               # provision + deploy (idempotent — safe to re-run)
./a51 doctor              # acceptance test: checks bindings, probes live hosts
```

There is **no test suite** — `./a51 doctor` is how a deployment is verified. For
CLI edits, syntax-check with `node --check <file>` (the CLI is plain ESM, no build
step). `wrangler.toml` files are generated from `*.template` + `.env` and are
gitignored — edit the template or `.env`, never the rendered file.

## Making a change

1. Fork and branch from `public` (e.g. `fix/mail-parse` or `feat/blocklist-cidr`).
2. Keep the change focused — one logical change per PR.
3. **Match the surrounding style.** These files carry unusually thorough "why"
   comments; preserve them.
4. **Update the docs in the same commit.** `docs/` is tiered — a behaviour change
   must update the matching page:
   - `docs/guides/` — setup, an operator workflow, or a failure mode
   - `docs/reference/` — a command/flag, a `.env` value, a route, or a column
   - `docs/internals/` — how a runtime piece behaves
   - and `docs/decisions.md` if you change a documented trade-off.
5. Run `node --check` on any edited CLI/worker JS, and `./a51 doctor` against a
   live deploy where relevant.
6. **Scrub your diff** for secrets and real infrastructure before pushing.

## Pull requests

Open the PR against `public` with a clear description of what changed and why, and
how you verified it. A maintainer will review — please be patient; this is a
community project maintained on a best-effort basis.

## License

By contributing, you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE) on an inbound=outbound basis (Apache-2.0 §5) — no
separate CLA is required. Don't add third-party code without confirming its
license is compatible and recording it in [NOTICE](NOTICE).
