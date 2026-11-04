# dotme v1 scope

Decided with Ao on 2026-11-02. This document is the source of truth for v1;
where an earlier plan or review disagrees, this one wins.

## Goals

1. **Smooth daily use for Ao** across Claude Code, Codex, claude.ai and Grok Bot.
2. **Open source as a showcase project**: a clear, attractive README and easy
   setup. No revenue goal, no hosted service.

## Ground rule: agent-friendly setup

Most users will paste the repo link or README into their coding agent and say
"install dotme". Every setup step must work that way:

- Every step is a copy-pasteable command, never "click around in a dashboard".
- Steps only a human can do are marked, and the agent stops and hands over:
  signing in to Cloudflare and GitHub, choosing the passphrase, creating the
  GitHub token. **Secrets are typed by the human straight into a prompt**
  (for example `wrangler secret put`) and never pass through the agent's context.
- Every step is verifiable: `/setup/status` reports what is configured and
  what is missing, so an agent can check its own work.

## Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Who runs the server | Each user deploys their own copy. Ao's own instance is one deployment of the template, nothing more. | Cloud clients (claude.ai, ChatGPT, Grok Bot) can only reach a public HTTPS MCP server; a hosted service is out of scope. |
| 2 | Platform | Cloudflare Workers only. Keep storage and platform code easy to swap; "other platforms welcome as PRs". | `workers-oauth-provider` gives a full OAuth server and KV for free. Vercel needs an external auth server plus Upstash. |
| 3 | Data storage | The user's own private GitHub repo, one Markdown file per category. KV storage stays for local development only. | Every approval is a commit with agent, time and evidence: a free audit trail, and the data stays the user's. |
| 4 | Server install | Agent-led install is the main path (`INSTALL.md`, run with `wrangler` and `gh`). A "Deploy to Cloudflare" button is the secondary path. No web setup wizard; `/setup/status` replaces it. | Ground rule above. The install itself shows off the idea. |
| 5 | Client tiers | Tier 1, tested with full guides: Claude Code, claude.ai, Codex. Tier 2, one generic section: any remote MCP client with OAuth (ChatGPT, Cursor, Grok). A compatibility table marks tested, untested and known issues. Grok Bot is not a release blocker. | Ship without waiting on clients we do not control. |
| 6 | Claude Code setup | A Claude Code plugin bundling the MCP connection, the SessionStart hook and the skills. The user pastes the export token once. | The hook makes preferences load every session instead of depending on the model to call a tool. |
| 7 | Codex setup | A Codex plugin for install and the MCP config, plus `npm run codex:hook`, which merges the shared hook into `~/.codex/hooks.json` (Codex 0.164 and later removed plugin hooks). The plugin does not flip `mcp_2026_07_28`; the README explains that turning it on enables in-app approval dialogs. Tested on Codex 0.166 (2026-11-03): manual hook loads preferences, and with the flag on the dialog appears and Accept saves. | Codex has SessionStart hooks but no longer runs them from plugins. Changing a user's global flags is their call. |
| 8 | Categories | Ship `collab`, `coding`, `life` as defaults; users add a category by adding a `.md` file. A new category is hidden from existing connections until re-authorized with it ticked. | Fits "dotfiles"; new private categories never leak to existing agents. |
| 9 | What the hook injects | Configurable in the plugin, default `collab,coding`. The export token is read-only and can read every category. | Coding agents get what they need; `life` stays out unless chosen. The token lives only on the user's machine; per-category limits belong to OAuth connections. |
| 10 | GitHub token | Fine-grained PAT through a pre-filled template URL (Contents read and write, 366 days); the user picks the data repo and pastes the token into `wrangler secret put`. `/setup/status` and the approval page warn 30 days before expiry. | `gh auth token` reaches every repo; a GitHub App is too heavy. |
| 11 | Owner sign-in | Passkey first. The passphrase is for first sign-in and recovery, rate limited (5 failures, 15 minute lock). The consent page and approval pages share one owner session, so authorizing a new agent after a passkey sign-in needs no passphrase. Install reminds the user to add a passkey on laptop and phone. | Public repo means anyone can try passphrases on any deployment. |
| 12 | Template vs Ao's instance | The public repo holds no account-specific values. Install writes each user's config (Worker name, KV id, data repo, URL) to a gitignored local file used at deploy time. Ao reinstalls his own instance through the same path, reusing `AFFFPupu/dotme-data` and the existing KV. | Ao is the first real test of `INSTALL.md`. |
| 13 | Git history | Before going public, rebuild history as one clean initial commit authored with Ao's GitHub noreply address; later commits use the same address. Keep the old history in a private backup. The exact mechanics need Ao's go-ahead. | Removes the work email and old personal config from history. |
| 14 | README | First screen: name, tagline "Dotfiles for your AI agents", then a ~30 second real screen recording: state a preference in Claude Code, approve it in the dialog, open a new Codex session that already follows it. Then "paste this repo into your agent to install", a small architecture diagram and the compatibility table. | The cross-agent moment is the pitch and is hard to explain in words. |
| 15 | License | MIT. | Widest reuse for a showcase. |
| 16 | Quality | GitHub Actions on every push: `tsc`, unit tests for parsing, serializing, applying proposals and conflict checks, and an end-to-end run against `wrangler dev` with KV storage (OAuth, propose, approve, reject, elicitation). CI badge in the README. A manual checklist covers what CI cannot: passkeys on real devices and dialogs in Claude Code and Codex. | The end-to-end scripts already exist; parsing bugs would corrupt user data. |

## v1 features

Already working: MCP server with OAuth (dynamic registration), `whoami`,
`list_categories`, `get_preferences`, `propose_change`, `list_pending`,
approval page with passkeys, in-client approval through elicitation with a
link fallback, per-connection categories, agent attribution in commits.

To build:

- Template cleanup and the gitignored local config (decision 12).
- Dynamic categories (decision 8).
- Unified owner session and passphrase rate limiting (decision 11).
- `/setup/status`, including token expiry (decisions 4, 10).
- Claude Code and Codex plugins with a shared hook (decisions 6, 7, 9).
- `/dotme-import` skill: reads existing `~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md` and memory exports, and files them as proposals.
- `/dotme-review` skill: reviews recent conversations and proposes what it noticed.
- Approval page: approve all, and a layout that works on a phone.
- Server instructions updated for in-client approval (agents are currently
  told approval only happens on a page).
- `INSTALL.md`, README, LICENSE, CI (decisions 4, 14, 15, 16).

Not in v1: scheduled reviews (the README shows how to schedule
`/dotme-review` with the client's own scheduler), MCP Apps approval cards in
claude.ai, preference expiry, platforms other than Cloudflare, a hosted service.

## Release criteria

Flip the repo to public, with Ao's go-ahead, when all of these hold:

1. Every v1 feature above is done.
2. CI is green.
3. Ao installs from scratch: a new Claude Code session, paste the repo link,
   "install dotme", only the human-only steps by hand, `/setup/status` all
   green. This also migrates his current deployment.
4. The manual checklist passes: passkeys on Mac and phone, dialogs in Claude
   Code and Codex, link approval in claude.ai.
5. The demo recording is in the README.
6. History is rebuilt as one clean commit with the noreply author.
7. Ao has read the README's first screen and approved it.

Announcing it on X or LinkedIn is separate and follows Ao's own distribution rules.

## Outside v1, Ao's own setup

- How Ao's memex `core.md` relates to dotme `collab` (they overlap today).
