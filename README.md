# dotme

Dotfiles for your AI agents. One private git repo holds your preferences
(how agents should talk and work with you, your stack, life facts such as
timezone). Every agent connects to the same MCP server, reads them, and
proposes changes it notices; you approve each change on a page, and it lands
as one commit.

Early: a working server, not yet a release. Each user deploys their own copy
to Cloudflare Workers; the design and v1 plan are in
[docs/v1-scope.md](docs/v1-scope.md). To test a deploy end to end, follow
[docs/testing.md](docs/testing.md).

## How it works

- `/mcp`: OAuth-protected MCP endpoint. Tools: `whoami`, `list_categories`,
  `get_preferences`, `propose_change`, `list_pending`.
- `/authorize`: consent page. You name the agent, tick the categories it may
  see and enter the owner passphrase. The name is stamped on its proposals.
- `/approve`: owner page. Shows each proposal's diff, evidence and conflicts;
  approve (optionally scoped with "only applies when"), or reject. Sign in
  with the passphrase once per device, then set up a passkey right there to
  use Face ID or Touch ID from then on.
- Approval in the client: connections you trust (Claude Code) can show the
  proposal in their own dialog instead of a link. Accept saves, Decline
  drops, closing it falls back to the link.
- `/export?categories=collab,coding`: preferences as plain Markdown, for the
  SessionStart hook that copies them into each new session (default
  `collab,coding`). Needs `Authorization: Bearer <EXPORT_TOKEN>`.
- Storage: the private repo in `GITHUB_REPO` (one Markdown file per
  category, `pending/` for open proposals), or KV with `STORAGE=kv` for
  local development.

## Run locally

```bash
npm install
printf 'OWNER_PASSPHRASE=local-test-passphrase\nMCP_RESOURCE=http://localhost:8787/mcp\nSTORAGE=kv\n' > .dev.vars
npm run dev
node scripts/e2e.mjs
```

## Deploy

This repo is a template: it holds no account-specific values. Your own
Worker name, URL, KV namespace and data repo go in `dotme.config.json`, which
is gitignored. `npm run configure` merges it into `wrangler.jsonc` and writes
`wrangler.deploy.jsonc` (also gitignored); `npm run deploy` and
`npm run wrangler -- <command>` run it first, so they always use your values.

```bash
npx wrangler login                               # human: sign in to Cloudflare
npx wrangler kv namespace create OAUTH_KV        # prints the namespace id
cp dotme.config.example.json dotme.config.json   # then fill in the four values
npm run configure                                # checks them, writes wrangler.deploy.jsonc
npm run wrangler -- secret put OWNER_PASSPHRASE  # human: type the passphrase
npm run wrangler -- secret put GITHUB_TOKEN      # human: paste a fine-grained token, Contents read and write on the data repo only
npm run deploy
```

| Field | Value |
|---|---|
| `workerName` | The Worker's name, for example `dotme`. |
| `url` | The Worker's origin, `https://<workerName>.<your-subdomain>.workers.dev`. Clients connect to `<url>/mcp`. |
| `kvNamespaceId` | The id printed by `kv namespace create`. |
| `githubRepo` | Your private data repo, `owner/name`. Seed it with the example files in `seed/`. |

Connect a client to `<url>/mcp`.

## Claude Code and Codex

Plugins for both clients load your preferences at the start of every session
and connect the MCP server. Current Codex builds no longer run plugin hooks,
so Codex needs one manual hook entry. See [clients/README.md](clients/README.md).
