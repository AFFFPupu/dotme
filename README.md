# memory-passport (test server)

A throwaway test server for the memory passport idea: one OAuth-protected
remote MCP endpoint on Cloudflare Workers, with hard-coded sample
preferences. It exists to check which auth flow each client runs (Grok Bot,
claude.ai, Claude Code) and that the server can tell connected agents apart.
The design lives in Ao's memex: `wiki/ideas/memory-passport/v0-spec.md`.

Each connection goes through `/authorize`: you name the agent and enter the
owner passphrase. The name is stored in the token's props and returned by
the `whoami` tool.

## Run locally

```bash
npm install
printf 'OWNER_PASSPHRASE=local-test-passphrase\n' > .dev.vars
npm run dev
node scripts/e2e.mjs
```

## Deploy

```bash
npx wrangler login
npx wrangler kv namespace create OAUTH_KV   # put the id in wrangler.jsonc
npx wrangler secret put OWNER_PASSPHRASE
npm run deploy                              # then set MCP_RESOURCE to https://<worker>/mcp and deploy again
```

Connect a client to `https://<worker>/mcp`.
