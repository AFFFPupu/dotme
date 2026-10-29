# dotme

Dotfiles for your AI agents. One private git repo holds your preferences
(how agents should talk and work with you, your stack, life facts such as
timezone). Every agent connects to the same MCP server, reads them, and
proposes changes it notices; you approve each change on a page, and it lands
as one commit.

Early: a working server for Ao's own setup, not yet a release. The design is
in Ao's memex: `wiki/ideas/memory-passport/v0-spec.md`.

## How it works

- `/mcp`: OAuth-protected MCP endpoint. Tools: `whoami`, `list_categories`,
  `get_preferences`, `propose_change`, `list_pending`.
- `/authorize`: consent page. You name the agent, tick the categories it may
  see and enter the owner passphrase. The name is stamped on its proposals.
- `/approve`: owner page. Shows each proposal's diff, evidence and conflicts;
  approve (optionally scoped with "only applies when"), or reject.
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

```bash
npx wrangler login
npx wrangler kv namespace create OAUTH_KV        # put the id in wrangler.jsonc
npx wrangler secret put OWNER_PASSPHRASE
npx wrangler secret put GITHUB_TOKEN             # fine-grained, Contents read and write on GITHUB_REPO only
npm run deploy
```

Set `MCP_RESOURCE` to `https://<worker>/mcp` and `GITHUB_REPO` to your
private repo; seed it from `seed/`. Connect a client to `https://<worker>/mcp`.
