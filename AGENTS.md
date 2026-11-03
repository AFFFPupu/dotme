# dotme

Dotfiles for your AI agents: a self-hosted MCP server (Cloudflare Workers)
over the user's private GitHub repo of preferences. Agents read preferences
and propose changes; the owner approves each one.

Read [docs/v1-scope.md](docs/v1-scope.md) before planning or building. It
holds the decided v1 scope, decisions and release criteria, and wins over any
earlier plan or review.

## Rules

- This repo is an open-source template that each user deploys for themselves.
  Ao's own deployment is just one install; never put account-specific values
  (Worker name, KV ids, data repo, URLs) in tracked files. They live in the
  gitignored `dotme.config.json`; deploy with `npm run deploy` and run account
  commands as `npm run wrangler -- <command>`. A bare `wrangler deploy` uses
  the template and would point the Worker at a new KV namespace.
- Setup must stay agent-friendly: copy-pasteable commands, human-only steps
  clearly marked, every step verifiable through `/setup/status`.
- Secrets are typed by a human directly into a prompt such as
  `wrangler secret put`. Never print, log, store or ask for secret values.
- Talk to Ao in natural Chinese. Everything in the repo and on GitHub (code,
  comments, docs, commits, PRs, issues) is in English.
- No em dashes anywhere.
- Deploys (`wrangler deploy`) and real-device tests (passkeys, approval
  dialogs in Claude Code and Codex) run on Ao's Mac, not in a cloud thread.
- Making the repo public, rewriting history and force-pushing need Ao's
  explicit go-ahead.

## Develop

```bash
npm install
printf 'OWNER_PASSPHRASE=local-test-passphrase\nMCP_RESOURCE=http://localhost:8787/mcp\nSTORAGE=kv\n' > .dev.vars
npm run dev
node scripts/e2e.mjs
npx tsc --noEmit
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push; run them
before pushing:

```bash
npm run typecheck
npm test          # unit tests (vitest) for parsing, serializing, proposals, conflicts
npm run e2e       # starts its own wrangler dev on :8788 with fresh KV state
```
