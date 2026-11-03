# dotme

Dotfiles for your AI agents. One private git repo holds your preferences
(how agents should talk and work with you, your stack, life facts such as
timezone). Every agent connects to the same MCP server, reads them, and
proposes changes it notices; you approve each change on a page, and it lands
as one commit.

Early: a working server, not yet a release. Each user deploys their own copy
to Cloudflare Workers ([INSTALL.md](INSTALL.md)); the design and v1 plan are in
[docs/v1-scope.md](docs/v1-scope.md). To test a deploy end to end, follow
[docs/testing.md](docs/testing.md).

## How it works

- `/mcp`: OAuth-protected MCP endpoint. Tools: `whoami`, `list_categories`,
  `get_preferences`, `propose_change`, `list_pending`.
- `/authorize`: consent page. You confirm the agent's name (pre-filled from
  the app) and the categories it may see, and sign in if you are not already.
  The name is stamped on its proposals. What each choice means:
  [clients/README.md](clients/README.md#what-you-choose-and-what-to-pick).
- `/approve`: owner page. Shows each proposal's diff, evidence and conflicts;
  approve (optionally scoped with "only applies when"), or reject. Sign in
  with the passphrase once per device, then set up a passkey right there to
  use Face ID or Touch ID from then on. The consent page and `/approve` share
  one owner session, so signing in on either signs you in on both. After 5
  wrong passphrases from one address, passphrase sign-in is locked for 15
  minutes there; passkeys still work.
- Approval in the client: connections you trust (Claude Code) can show the
  proposal in their own dialog instead of a link. Accept saves; Decline or
  closing it falls back to the link.
- `/export?categories=collab,coding`: preferences as plain Markdown, for the
  SessionStart hook that copies them into each new session (default
  `collab,coding`). Needs `Authorization: Bearer <EXPORT_TOKEN>`.
- Storage: the private repo in `GITHUB_REPO` (one Markdown file per
  category, `pending/` for open proposals), or KV with `STORAGE=kv` for
  local development.
- Categories: `collab`, `coding` and `life` always exist. Add your own by
  pushing a Markdown file with a lowercase name, such as `work.md`, to the
  root of the data repo. Existing connections do not see it until you
  connect them again and tick it on the consent page, so a new private
  category never leaks to an agent you already trusted.

## Install

Paste this into Claude Code or Codex, opened in an empty folder:

> Install dotme by following INSTALL.md in https://github.com/AFFFPupu/dotme

[INSTALL.md](INSTALL.md) walks the agent through the whole setup: a private
data repo, a Cloudflare Worker, secrets you type yourself, passkeys and the
client plugins. `<url>/setup/status` reports what is configured and what is
missing, so you and the agent can check every step.

This repo is a template and holds no account-specific values. Your own
Worker name, URL, KV namespace and data repo go in the gitignored
`dotme.config.json`; `npm run deploy` and `npm run wrangler -- <command>` use
them. Never run a bare `wrangler deploy`.

## Run locally

```bash
npm install
printf 'OWNER_PASSPHRASE=local-test-passphrase\nMCP_RESOURCE=http://localhost:8787/mcp\nSTORAGE=kv\n' > .dev.vars
npm run dev
node scripts/e2e.mjs
```

## Claude Code and Codex

Plugins for both clients load your preferences at the start of every session
and connect the MCP server. Current Codex builds no longer run plugin hooks,
so Codex needs one manual hook entry. See [clients/README.md](clients/README.md).
