# Testing dotme end to end

This guide tests everything on `main`: the automated checks, a deploy of your
own instance, owner sign-in with passkeys, and every Tier 1 client (Claude
Code, Codex, claude.ai). Work through it in order; each step says how to tell
it passed. Record the results in the table at the end.

CI already runs steps 1 and 2 on every push. Steps 3 and later need a real
Cloudflare account, a real data repo and real clients, so they run on your
own machine.

**Human only** marks steps an agent must hand to you: signing in, typing a
secret, tapping a passkey, clicking Approve.

Placeholders used below:

- `<url>`: your Worker's origin, for example `https://dotme.<your-subdomain>.workers.dev`
- `<repo>`: the GitHub repo you install dotme from, as `owner/name`
- `<data-repo>`: your private preferences repo, as `owner/name`

## 0. Before you start

You need Node 24 or later, `git`, `curl`, `openssl`, a Cloudflare account,
the private data repo, and the clients you want to test (Claude Code, Codex,
claude.ai in a browser, a phone for the passkey step).

Use `main` only:

```bash
cd <your dotme checkout>
git checkout main
git pull --ff-only origin main
git status            # must say "On branch main" and "nothing to commit"
npm ci
```

## 1. Automated checks

```bash
npm run typecheck
npm test
npm run check:plugins
npm run e2e
```

Pass:

- `typecheck` prints no errors.
- `npm test` ends with `Tests  N passed`.
- `check:plugins` prints `plugins ok`.
- `npm run e2e` starts a throwaway `wrangler dev` with KV storage and prints
  `e2e: all checks passed`, `elicit: all checks passed` and a list of `ok`
  lines for the export endpoint and the SessionStart hook, with no `FAIL`.

The same four steps are the CI job; the badge on the commit in GitHub should
be green.

## 2. Local server by hand (optional)

Use this to poke at the pages without touching your real instance:

```bash
printf 'OWNER_PASSPHRASE=local-test-passphrase\nMCP_RESOURCE=http://localhost:8787/mcp\nSTORAGE=kv\nEXPORT_TOKEN=local-export-token\n' > .dev.vars
npm run dev
```

In a second terminal:

```bash
node scripts/e2e.mjs
node scripts/export.mjs
```

Open `http://localhost:8787/approve` and sign in with `local-test-passphrase`.

## 3. Deploy from main

Never run a bare `wrangler deploy` (or `npx wrangler deploy`). It uses the
template `wrangler.jsonc`, which would create a new KV namespace and bind the
Worker to `localhost`, breaking every existing connection. Always use
`npm run deploy` and `npm run wrangler -- <command>`.

### 3.1 Install config

`dotme.config.json` is gitignored and holds your instance's values. Create
it once per checkout:

```bash
cp dotme.config.example.json dotme.config.json
```

Fill in the four fields:

| Field | Value |
|---|---|
| `workerName` | Your Worker's name. For an existing instance, the name it already has. |
| `url` | `<url>`, with no path and no trailing slash. |
| `kvNamespaceId` | The `OAUTH_KV` namespace id. For an existing instance, reuse its id so grants, sessions and passkeys survive. New install: `npx wrangler kv namespace create OAUTH_KV`. |
| `githubRepo` | `<data-repo>`. |

An existing instance's name and KV id are in the Cloudflare dashboard, or:

```bash
npx wrangler whoami                  # human: sign in with `npx wrangler login` if asked
npx wrangler kv namespace list
```

Then:

```bash
npm run configure
```

Pass: it prints `configure: wrote wrangler.deploy.jsonc for <workerName> at <url>`.
Check the generated file:

```bash
grep -E '"name"|MCP_RESOURCE|GITHUB_REPO|"id"' wrangler.deploy.jsonc
git status --short   # dotme.config.json and wrangler.deploy.jsonc must NOT appear
```

`MCP_RESOURCE` must be `<url>/mcp`, and the KV `id` must be the one you chose.

### 3.2 Secrets

```bash
npm run wrangler -- secret list
```

Pass: `OWNER_PASSPHRASE`, `GITHUB_TOKEN` and (once step 5.1 is done)
`EXPORT_TOKEN` are listed. Only names are shown, never values. For a new
install, set the missing ones (**human only**, type the value into the prompt):

```bash
npm run wrangler -- secret put OWNER_PASSPHRASE
npm run wrangler -- secret put GITHUB_TOKEN   # fine-grained token, Contents read and write on <data-repo> only
```

A new data repo starts from the files in `seed/`: copy `collab.md`,
`coding.md` and `life.md` to the repo's root and push.

### 3.3 Deploy

```bash
npm run deploy
```

Pass: wrangler prints the Worker's URL, and it matches `<url>`. Then:

```bash
curl -sS <url>/                                         # prints: dotme
curl -sS <url>/.well-known/oauth-authorization-server | head -c 200; echo
curl -sS -o /dev/null -w '%{http_code}\n' <url>/mcp     # 401: OAuth required
curl -sS -o /dev/null -w '%{http_code}\n' <url>/export  # 401: token required
```

If anything is off, `npm run wrangler -- tail` streams the Worker's logs.

## 4. Owner sign-in and passkeys

### 4.1 Mac

1. Open `<url>/approve` in your browser.
2. **Human only:** sign in with the passphrase. You land on the pending list.
3. Click **Set up a passkey** (or **Add a passkey on this device**) and
   confirm with Touch ID.
4. Open `<url>/approve` in a private window. Pass: a **Sign in with passkey**
   button is shown, and it signs you in with Touch ID, no passphrase.
5. Type a wrong passphrase once. Pass: `Wrong passphrase.` and no sign-in.

### 4.2 Phone

1. Open `<url>/approve` on the phone and sign in with the passphrase.
2. Add a passkey on the phone (Face ID).
3. Open the page in a private tab. Pass: the passkey signs you in.

The owner session lasts 30 days per browser.

## 5. Claude Code

### 5.1 Export token (once per machine)

The SessionStart hook reads preferences with a read-only export token kept in
`~/.config/dotme/auth-header`.

If you already have one (for example from the old `sync.sh` hook), check it
still works and skip to 5.2:

```bash
ls -l ~/.config/dotme/url ~/.config/dotme/auth-header   # auth-header must be -rw-------
sh clients/shared/session-start.sh | head -3
```

Pass: the first line ends with `(fetched at session start).`

Otherwise create one. These commands never print the token:

```bash
mkdir -p ~/.config/dotme && chmod 700 ~/.config/dotme
printf '<url>\n' > ~/.config/dotme/url
( umask 077; t=$(openssl rand -hex 32)
  printf 'Authorization: Bearer %s\n' "$t" > ~/.config/dotme/auth-header
  printf '%s' "$t" | npm run -s wrangler -- secret put EXPORT_TOKEN )
sh clients/shared/session-start.sh | head -3
```

Then check the error paths:

```bash
DOTME_CATEGORIES=nope sh clients/shared/session-start.sh | head -1   # "server answered HTTP 400: Unknown category ..."
DOTME_URL=http://127.0.0.1:9 sh clients/shared/session-start.sh | head -1   # "server unreachable; last copy from ..."
```

### 5.2 Remove the old setup

So preferences are not loaded twice:

- If `~/.claude/settings.json` has a `SessionStart` hook running
  `~/.config/dotme/sync.sh`, delete that entry.
- If you added the MCP server by hand, remove it:
  `claude mcp list`, then `claude mcp remove dotme -s user` (or the scope it
  shows).

### 5.3 Install the plugin from main

```bash
claude plugin marketplace add <repo>
claude plugin install dotme@dotme --config server_url=<url> --config categories=collab,coding
```

The marketplace is read from the repo's default branch, which is `main`. If
the repo is private and the add fails, add your local checkout instead:
`claude plugin marketplace add "$(pwd)"` (with `main` checked out). If
`--config` is not accepted by your Claude Code version, run
`claude plugin install dotme@dotme` and enter the server URL when asked, or
use `/plugin` inside a session.

Pass: `claude plugin list` shows `dotme` enabled. Optional:
`claude plugin validate .` in the checkout reports no errors.

### 5.4 Connect the MCP server

1. Start `claude`, run `/mcp`, pick `dotme`, choose to authenticate.
2. **Human only:** on the consent page, name the agent `claude-code`, keep
   `collab` and `coding` ticked (add `life` if you want), tick **Let this app
   ask me to approve changes in its own dialog**, and click Allow. If you
   signed in to `/approve` in this browser, no passphrase is needed;
   otherwise type it.
3. Pass: `/mcp` shows `dotme` connected.

### 5.5 The hook

1. Quit and start a new session in any project.
2. Ask: "Which dotme preferences were loaded at the start of this session?"
3. Pass: it lists your `collab` and `coding` preferences, and says they were
   fetched at session start. Running `claude --debug` shows the SessionStart
   hook from the dotme plugin running.
4. Change the categories with `/plugin configure dotme@dotme` (for example
   `collab`), start a new session, and check only that category loads. Set
   it back.

### 5.6 Tools and the approval dialog

In a session:

1. "Call dotme whoami." Pass: agent `claude-code`, the categories you ticked.
2. "Propose to dotme, in coding: I prefer pnpm over npm in new projects.
   Evidence: I said so just now." Pass: Claude Code shows a dotme dialog with
   the change and evidence, offering approve or reject.
3. **Human only:** approve. Pass: the tool answers `approved and saved`, and
   `<data-repo>` has a new commit touching `coding.md` that names
   `claude-code` and the evidence.
4. Propose another throwaway preference and reject it in the dialog. Pass:
   `Nothing was saved.` and no new commit.
5. Propose a third one and dismiss the dialog (Escape). Pass: the agent gives
   you a `<url>/approve/q-...` link. Open it, check the diff and evidence,
   then reject it there.
6. Start a new session. Pass: the pnpm preference from step 3 is in the
   loaded preferences.

Keep the pnpm preference for the Codex test, then remove it in step 6.5.

## 6. Codex

### 6.1 Install the plugin from main

```bash
codex plugin marketplace add <repo>
```

(Or the local checkout path, as in 5.3.) In Codex, open `/plugins`, install
and enable `dotme`. **Human only:** Codex asks you to review and trust the
plugin's hook; trust it.

### 6.2 Connect the MCP server

```bash
codex mcp add dotme --url <url>/mcp
codex mcp login dotme
```

**Human only:** on the consent page, name the agent `codex`, tick the
categories and the dialog option, and Allow.

Pass: `codex mcp list` shows `dotme`.

### 6.3 The hook and the cross-agent check

1. Start a new Codex session.
2. Ask: "Which dotme preferences were loaded at the start of this session?"
3. Pass: the list includes the pnpm preference you approved in Claude Code.
   This is the core promise: said once in one agent, followed in the next.

If no preferences are loaded, the plugin hook did not run in your Codex
build. Add the hook by hand and try again:

```bash
cp clients/shared/session-start.sh ~/.config/dotme/session-start.sh
```

`~/.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "sh ~/.config/dotme/session-start.sh" }] }
    ]
  }
}
```

Note which way worked in the results table.

### 6.4 Approval: link, then dialog

1. Without any feature flag, ask Codex to propose a throwaway preference.
   Pass: it gives you a `<url>/approve/q-...` link. Reject it on the page.
2. Turn on the newer MCP protocol in `~/.codex/config.toml`:

   ```toml
   [features]
   mcp_2026_07_28 = true
   ```

3. Start a new session and propose another throwaway preference. Pass: Codex
   shows dotme's approval dialog. Reject it. Pass: `Nothing was saved.`

### 6.5 Clean up

Ask Codex (or Claude Code): "Propose to dotme to remove the pnpm preference
in coding." Approve it. Pass: a new commit in `<data-repo>` removes it, and
`<url>/approve` shows no pending proposals.

## 7. claude.ai

1. In claude.ai, open Settings, Connectors. If dotme is not there, add a
   custom connector with the URL `<url>/mcp`, connect, and on the consent
   page name the agent `claude-ai`. Leave the dialog option unticked;
   claude.ai approves through the link.
2. In a new chat with the connector on: "Call dotme whoami, then show my
   collab preferences." Pass: agent `claude-ai`, and the preferences match
   your data repo.
3. "Propose to dotme: <a throwaway preference>." Pass: Claude gives a
   `<url>/approve/q-...` link.
4. Open the link **on your phone**, sign in with the passkey, and reject.
   Pass: the proposal is gone from `<url>/approve`.

## 8. Other remote MCP clients (optional)

Any client that supports remote MCP servers with OAuth (ChatGPT, Cursor,
Grok) connects to `<url>/mcp` the same way as claude.ai: name the agent on
the consent page and approve through the link. These are Tier 2 and not
release blockers; note in the table whether connecting and `whoami` work.

## 9. Results

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Automated checks on main | | |
| 3 | Deploy with `npm run deploy`, URL and KV unchanged | | |
| 4.1 | Passkey sign-in on Mac | | |
| 4.2 | Passkey sign-in on phone | | |
| 5.1 | Export token and hook script | | |
| 5.3 | Claude Code plugin installs from the marketplace | | |
| 5.5 | Claude Code SessionStart hook loads preferences | | |
| 5.6 | Claude Code approval dialog: approve, reject, link fallback | | |
| 6.1 | Codex plugin installs, hook trusted | | |
| 6.3 | Codex hook loads preferences (plugin or manual) | | |
| 6.4 | Codex link approval, then dialog with `mcp_2026_07_28` | | |
| 7 | claude.ai connector, link approval on phone | | |
| 8 | Tier 2 clients (optional) | | |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Clients fail to reconnect after a deploy | `url` or `kvNamespaceId` in `dotme.config.json` differs from the old instance, or a bare `wrangler deploy` was run. Fix the config and `npm run deploy` again. |
| Hook says `the export token was refused (HTTP 401)` | `~/.config/dotme/auth-header` does not match the server's `EXPORT_TOKEN`; redo 5.1. Setting a new token on one machine breaks the old one on others; copy the two files instead. |
| Hook says `not set up on this machine` | `~/.config/dotme/url` or `auth-header` is missing. |
| Preferences load twice | The old `sync.sh` hook or a hand-added MCP server is still configured; see 5.2. |
| No dialog, only a link | The connection was authorized without the dialog option (reconnect and tick it), or, in Codex, `mcp_2026_07_28` is off. |
| Approval fails with a GitHub error | `GITHUB_TOKEN` expired or lacks Contents write on `<data-repo>`; set a new one with `npm run wrangler -- secret put GITHUB_TOKEN`. |
