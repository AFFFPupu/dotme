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
3. Pass: a box at the top says you signed in with the passphrase and offers
   **Set up a passkey**. Click it and confirm with Touch ID. The page reloads
   without the box.
4. Open `<url>/approve` in a private window. Pass: a **Sign in with passkey**
   button is shown, and it signs you in with Touch ID, no passphrase.
5. Type a wrong passphrase once. Pass: `Wrong passphrase.` and no sign-in.
6. Back in the normal window, click **Add a passkey on this device** on the
   pending list. Pass: `This device already has a dotme passkey.`, not a
   browser error.

### 4.2 Phone

The phone usually first sees dotme through an approval link, so test that
path:

1. Have any agent propose a throwaway preference (see 7.3) and open its
   `<url>/approve/q-...` link on the phone, signed out.
2. Sign in with the passphrase. Pass: you land on that proposal, with the
   **Set up a passkey** box above it.
3. Set up the passkey with Face ID. Pass: you stay on the same proposal and
   it is still pending. Reject it.
4. Open `<url>/approve` in a private tab. Pass: the passkey signs you in.

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
- If you added dotme as a connector on claude.ai, Claude Code syncs it in as
  `claude.ai dotme`, with the same URL as the plugin's server, and uses it
  instead. That connection is named `claude-ai` and cannot show the dialog.
  After 5.4, run `/mcp`, pick `claude.ai dotme` and choose Disable. Claude
  Code remembers this per directory, so repeat it in each project, or remove
  the connector from claude.ai if you only use dotme in Claude Code.

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

1. Start `claude`, run `/mcp`, pick `plugin:dotme:dotme`, choose to
   authenticate.
2. **Human only:** on the consent page, set the agent name to `claude-code`
   (it is pre-filled from the app's name), keep the categories, and click
   Allow. Pass: the dialog option is already ticked, because Claude Code is
   an app on this computer. If you signed in to `/approve` in this browser,
   the page says "Signed in as the owner" and asks for no passphrase;
   otherwise **Sign in with passkey** or the passphrase.
3. Pass: `/mcp` shows `plugin:dotme:dotme` connected.
4. The first time an agent calls a dotme tool, Claude Code asks for
   permission. Choose "Yes, and don't ask again". dotme's own approval is
   the real check for changes, so a second prompt per proposal adds
   nothing.

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

The dialog has an optional "only applies when" field and the client's own
buttons: **Accept** saves the change; **Decline** or closing the dialog
(Escape) keeps it pending with a link, where you approve or reject it. A
client with no window for the dialog (such as `claude -p`) declines by
itself, so nothing is lost there.

`evidence` must be at least 10 characters, so the prompts below spell it
out. With a shorter one, such as "test", the agent stops and asks you.

1. "Call dotme whoami." Pass: agent `claude-code`, `inlineApproval: true`,
   the categories you ticked. If the agent is `claude-ai`, see 5.2.
2. "Propose to dotme, in coding: I prefer pnpm over npm in new projects.
   Evidence: I said so in this session, during the dotme test." Pass: Claude
   Code shows a dotme dialog with the change and evidence.
3. **Human only:** Accept. Pass: the tool answers `approved and saved`, and
   `<data-repo>` has a new commit touching `coding.md` that names
   `claude-code` and the evidence.
4. "Propose to dotme, in coding: Throwaway test preference two. Evidence:
   dotme test run, step 5.6.4." Decline it. Pass: the agent gives you a
   `<url>/approve/q-...` link and there is no new commit. Open the link,
   check the diff and evidence, then reject it there.
5. "Propose to dotme, in coding: Throwaway test preference three. Evidence:
   dotme test run, step 5.6.5." Close the dialog with Escape. Pass: same as
   step 4; reject it on the page.
6. Start a new session. Pass: the pnpm preference from step 3 is in the
   loaded preferences.

Keep the pnpm preference for the Codex test, then remove it in step 6.5.

### 5.7 A new category

CI covers this with KV storage; this checks it against the GitHub data repo.

1. In `<data-repo>`, add `work.md` at the root with one line, `# work`, and
   push.
2. In the Claude Code session from 5.6: "Call dotme list_categories."
   Pass: `work` is not listed, because this connection was authorized
   before the file existed.
3. Run `/mcp`, pick `plugin:dotme:dotme` and authenticate again. Pass: the
   consent page lists `work` after `collab`, `coding` and `life`. Keep it
   ticked and Allow.
4. "Call dotme list_categories." Pass: `work` is listed with 0 preferences.
5. Delete `work.md` from `<data-repo>` and push, unless you want to keep it.

## 6. Codex

### 6.1 Install the plugin and the hook

```bash
codex plugin marketplace add <repo>
```

(Or the local checkout path, as in 5.3.) In Codex, open `/plugins`, install
and enable `dotme`.

Codex 0.164 and later list `plugin_hooks` as removed, so the plugin's hook
never runs there. Install the hook by hand (check with
`codex features list | grep plugin_hooks`; skip this only if it is on):

```bash
cp clients/shared/session-start.sh ~/.config/dotme/session-start.sh
```

`~/.codex/hooks.json` (merge into it if the file exists):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "sh ~/.config/dotme/session-start.sh" }] }
    ]
  }
}
```

**Human only:** the next session asks you to review and trust the hook;
trust it.

### 6.2 Connect the MCP server

```bash
codex mcp add dotme --url <url>/mcp
codex mcp login dotme
```

**Human only:** on the consent page, set the agent name to `codex`, keep
the categories and the ticked dialog option, and Allow. If Codex asks
whether to allow a dotme tool call, allow it for the session or always.

Pass: `codex mcp list` shows `dotme`.

### 6.3 The hook and the cross-agent check

1. Start a new Codex session.
2. Ask: "Which dotme preferences were loaded at the start of this session?"
3. Pass: the list includes the pnpm preference you approved in Claude Code.
   This is the core promise: said once in one agent, followed in the next.

If no preferences are loaded, check that `~/.codex/hooks.json` is in place
and trusted (6.1). Note which hook worked, plugin or manual, in the results
table.

### 6.4 Approval: link, then dialog

1. Without any feature flag: "Propose to dotme, in coding: Throwaway test
   preference four. Evidence: dotme test run, step 6.4.1." Pass: it gives you
   a `<url>/approve/q-...` link. Reject it on the page.
2. Turn on the newer MCP protocol in `~/.codex/config.toml`:

   ```toml
   [features]
   mcp_2026_07_28 = true
   ```

3. Start a new session and propose another throwaway preference the same
   way (step 6.4.3). Pass: Codex shows dotme's approval dialog. Decline it.
   Pass: you get a link; reject it on the page.

If Codex still gives a link, run `npm run wrangler -- tail` in your checkout
while proposing. Each proposal logs one line such as
`{"proposal":{"agent":"codex","inlineApproval":true,"protocolVersion":null,"clientCapabilities":null,"dialog":false}}`.
`inlineApproval: false` means the connection was authorized without the
dialog option: reconnect and tick it. `protocolVersion: null` or no
`elicitation` in `clientCapabilities` means Codex did not send the newer
protocol, so it is a Codex limit; note it in the table.

### 6.5 Clean up

Ask Codex (or Claude Code): "Propose to dotme to remove the pnpm preference
in coding." Approve it. Pass: a new commit in `<data-repo>` removes it, and
`<url>/approve` shows no pending proposals.

## 7. claude.ai

1. In claude.ai, open Settings, Connectors. If dotme is not there, add a
   custom connector with the URL `<url>/mcp`, connect, and on the consent
   page set the agent name to `claude-ai`. Pass: the dialog option is
   unticked, because claude.ai is a web app; it approves through the link.
2. In a new chat with the connector on: "Call dotme whoami, then show my
   collab preferences." Pass: agent `claude-ai`, and the preferences match
   your data repo.
3. "Propose to dotme, in collab: Throwaway test preference five. Evidence:
   dotme test run, step 7.3." Pass: Claude gives a `<url>/approve/q-...`
   link.
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
| No dialog, only a link | The connection was authorized without the dialog option (reconnect with it ticked); in Claude Code, the synced `claude.ai dotme` connector is used instead of the plugin (5.2); in Codex, `mcp_2026_07_28` is off or not sent (6.4). `npm run wrangler -- tail` shows which. |
| `whoami` in Claude Code says `claude-ai` | The claude.ai connector shadows the plugin's server; disable `claude.ai dotme` in `/mcp` (5.2). |
| The agent stops and asks for evidence | `evidence` is under 10 characters. Say what you said or did, and when. |
| Codex loads no preferences | Codex 0.164 and later removed plugin hooks; install the manual hook (6.1). |
| Approval fails with a GitHub error | `GITHUB_TOKEN` expired or lacks Contents write on `<data-repo>`; set a new one with `npm run wrangler -- secret put GITHUB_TOKEN`. |
