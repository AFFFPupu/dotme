# Install dotme

dotme runs as your own Cloudflare Worker and keeps your preferences in your
own private GitHub repo. Installing it takes about 15 minutes. You can do it
by hand, but it is written so that your coding agent can do it with you:
open Claude Code or Codex in an empty folder and say

> Install dotme by following INSTALL.md in https://github.com/AFFFPupu/dotme

The agent runs the commands. You do the few steps marked **Human**: signing
in, choosing a passphrase, creating a GitHub token, approving in a browser.

## For the agent doing the install

- Work through the steps in order. Each one ends with a **Check**; run it
  before moving on.
- At a **Human** step, stop, tell the user exactly what to do, and wait for
  them to say it is done.
- Never ask for, print, store or log a secret: the passphrase, the GitHub
  token, the export token. Secrets go from the user's keyboard straight into
  a prompt such as `wrangler secret put`, which the user runs in their own
  terminal. The commands below that handle a token never print it.
- Never commit `dotme.config.json` or `wrangler.deploy.jsonc`; they are
  gitignored and hold this install's own values.
- Never run a bare `wrangler deploy`. Use `npm run deploy` and
  `npm run wrangler -- <command>`, which use this install's values.
- `<url>/setup/status` is the source of truth. Every item that is not `ok`
  says how to fix it; a fix that starts with `Human:` is the user's.
- If the user already has a dotme deployment, read
  [Reinstall or move an existing deployment](#reinstall-or-move-an-existing-deployment)
  first.

Placeholders used below:

| Placeholder | Meaning | Example |
|---|---|---|
| `<login>` | The user's GitHub login | `octocat` |
| `<data-repo>` | The private preferences repo, `owner/name` | `octocat/dotme-data` |
| `<worker>` | The Worker's name | `dotme` |
| `<url>` | The Worker's origin, no trailing slash | `https://dotme.octocat.workers.dev` |

## 0. Requirements

- A Cloudflare account (the free plan is enough) and a GitHub account.
- Node 24 or later, `git`, `curl` and `openssl`.
- The GitHub CLI `gh` makes step 3 one command; without it, the user creates
  the repo on github.com.

**Check:**

```bash
node --version && git --version && curl --version | head -1 && openssl version
gh --version | head -1   # optional
```

## 1. Get the code

```bash
git clone https://github.com/AFFFPupu/dotme.git
cd dotme
npm ci
```

Use your fork's URL instead if you forked it. All later commands run in this
folder.

**Check:** `npm run typecheck` prints no errors.

## 2. Sign in to Cloudflare and GitHub (Human)

```bash
npx wrangler login     # opens the browser; the user approves
gh auth login          # only if `gh auth status` says you are not signed in
```

The agent can start `npx wrangler login`; the user completes the sign-in in
the browser. `gh auth login` asks questions, so the user runs it in their own
terminal.

**Check:** `npx wrangler whoami` shows the Cloudflare account, and
`gh auth status` shows the GitHub login.

## 3. Create the private data repo

The data repo holds one Markdown file per category of preferences. Every
approved change is a commit in it. Start it from the examples in `seed/`;
show them to the user, who may edit or empty them first.

```bash
gh repo create dotme-data --private --description "My dotme preferences"
git clone "https://github.com/<login>/dotme-data.git" ../dotme-data
cp seed/*.md ../dotme-data/
git -C ../dotme-data add -A
git -C ../dotme-data commit -m "Start dotme preferences"
git -C ../dotme-data push -u origin HEAD
```

Without `gh`: **Human** creates a private, empty repo named `dotme-data` on
[github.com/new](https://github.com/new), then run the other commands.

The repo must be private. The default categories are `collab`, `coding` and
`life`; add your own later by adding a file such as `work.md`.

**Check:** `gh repo view <data-repo> --json visibility -q .visibility`
prints `PRIVATE`.

## 4. Create the KV namespace

KV holds sign-in state: OAuth grants, sessions and passkeys.

```bash
npx wrangler kv namespace create OAUTH_KV
```

Note the 32-character `id` it prints. If wrangler offers to add the binding
to `wrangler.jsonc`, answer no: the id goes in `dotme.config.json` in the
next step, and `wrangler.jsonc` stays a template.

**Check:** `npx wrangler kv namespace list` lists the new namespace.

## 5. Write this install's config

```bash
cp dotme.config.example.json dotme.config.json
```

Fill in the four values:

| Field | Value |
|---|---|
| `workerName` | `<worker>`, for example `dotme`. Lowercase letters, digits and dashes. |
| `url` | `<url>`: `https://<worker>.<subdomain>.workers.dev`, where `<subdomain>` is the account's workers.dev subdomain. If you do not know it, make your best guess; step 6 prints the real URL. |
| `kvNamespaceId` | The id from step 4. |
| `githubRepo` | `<data-repo>`. |

**Check:** `npm run configure` prints
`configure: wrote wrangler.deploy.jsonc for <worker> at <url>`.

## 6. Deploy

```bash
npm run deploy
```

The first deploy on an account without a workers.dev subdomain asks the user
to register one (**Human**: pick a name). The output ends with the Worker's
URL. If it differs from `url` in `dotme.config.json`, fix `url` and run
`npm run deploy` again.

**Check:** `curl -sS <url>/setup/status` returns JSON. `mcp_resource` and
`kv` are `ok`. `owner_passphrase` and `github_token` are `fail` until step 7;
that is expected.

## 7. Set the secrets (Human)

The user runs these in their own terminal, in the dotme folder, and types or
pastes each value at the prompt. The agent does not see them.

**Passphrase.** Used for the first sign-in on each device and for recovery.
Pick a long one (12 characters at least) and keep it in a password manager.

```bash
npm run wrangler -- secret put OWNER_PASSPHRASE
```

**GitHub token.** A fine-grained token that can only read and write the data
repo. Open this link, which fills in the name, the 366-day expiry and
Contents read and write:

<https://github.com/settings/personal-access-tokens/new?name=dotme&description=dotme+server%3A+read+and+write+the+data+repo&expires_in=366&contents=write>

Under **Repository access**, choose **Only select repositories** and pick the
data repo, and nothing else. Check that **Permissions** shows Contents: Read
and write (Metadata: Read-only is added by GitHub). Generate it, then paste
it at this prompt:

```bash
npm run wrangler -- secret put GITHUB_TOKEN
```

**Check:** `curl -sS <url>/setup/status` shows `ok: true`.
`owner_passphrase`, `github_repo`, `github_token`, `github_token_write` and
`github_token_expiry` are `ok`. `export_token` and `passkey` are `warn` until
steps 8 and 9.

## 8. Export token for session hooks

The Claude Code and Codex plugins load your preferences at the start of every
session with a read-only export token. This creates one, saves it in
`~/.config/dotme/auth-header` (mode 600) and sets it on the Worker, without
printing it. The agent can run it.

```bash
mkdir -p ~/.config/dotme && chmod 700 ~/.config/dotme
printf '%s\n' "<url>" > ~/.config/dotme/url
( umask 077; t=$(openssl rand -hex 32)
  printf 'Authorization: Bearer %s\n' "$t" > ~/.config/dotme/auth-header
  printf '%s' "$t" | npm run -s wrangler -- secret put EXPORT_TOKEN )
```

The server keeps one export token, so running this again replaces it. On a
second computer, copy `~/.config/dotme/url` and `~/.config/dotme/auth-header`
over instead of running it there.

**Check:** `sh clients/shared/session-start.sh | head -3` says
`fetched at session start`, and `/setup/status` shows `export_token` as `ok`.

## 9. Add passkeys (Human)

So you sign in with Face ID or Touch ID instead of the passphrase:

1. On your computer, open `<url>/approve`, sign in with the passphrase, and
   choose **Add a passkey on this device**.
2. Do the same on your phone. Approval links often arrive there.

After 5 wrong passphrases from one address, passphrase sign-in is locked
there for 15 minutes; passkeys keep working.

**Check:** `/setup/status` shows `passkey` as `ok`, and `allGreen: true`.

## 10. Connect your agents

Every client connects to `<url>/mcp` with OAuth. On dotme's consent page you
name the agent (its name is stamped on every proposal) and choose which
categories it may see. [clients/README.md](clients/README.md) explains each
choice and covers the details; the short version is below.

### Claude Code

```bash
claude plugin marketplace add AFFFPupu/dotme
claude plugin install dotme@dotme --config server_url=<url> --config categories=collab,coding
```

**Human:** in Claude Code, run `/mcp`, pick `plugin:dotme:dotme`, and on the
consent page keep the agent name `claude-code` and choose Allow.

**Check:** in a new session, the first message has your preferences from the
hook, and asking "Call dotme whoami." returns agent `claude-code` with
`inlineApproval: true`. If it returns `claude-ai`, see
[clients/README.md](clients/README.md#2-claude-code) for the claude.ai case.

### Codex

```bash
codex plugin marketplace add AFFFPupu/dotme
npm run codex:hook
codex mcp add dotme --url <url>/mcp
codex mcp login dotme
```

**Human:** in Codex, install and enable `dotme` in `/plugins`. On the
consent page from `codex mcp login`, name the agent `codex` and Allow. In the
next session Codex asks to trust the new hook; trust it.

Current Codex versions do not run hooks inside plugins, so
`npm run codex:hook` adds the hook to `~/.codex/hooks.json` instead (it keeps
your other hooks and makes a backup). To get the approval dialog inside Codex
rather than a link, turn on `mcp_2026_07_28`; see
[clients/README.md](clients/README.md#3-codex).

**Check:** `npm run codex:hook -- --check` passes, and a new Codex session
opens with your preferences.

### claude.ai, ChatGPT, Cursor, Grok and other web clients

**Human:** add a custom connector (claude.ai: Settings > Connectors > Add
custom connector) with the URL `<url>/mcp`, then Allow on the consent page
with a name such as `claude-ai`. Web clients approve changes on a link.
See [clients/README.md](clients/README.md#4-web-and-cloud-clients) for Grok
and the compatibility table.

## 11. Try it

In any connected agent, say:

> Propose to dotme, in collab: Reply in short paragraphs. Evidence: I asked for this while installing dotme today.

Approve it in the dialog or on the link the agent gives you. The change is
now a commit in the data repo, and the next session of every agent starts
with it.

**Check:** `git -C ../dotme-data pull` shows the new commit, with the agent's
name and the evidence in its message.

## Reinstall or move an existing deployment

Reuse what you have instead of creating it again. The Worker keeps its
secrets across deploys, the KV namespace keeps sign-ins and passkeys, and the
data repo keeps your preferences.

1. Step 1 as usual, in a fresh folder.
2. Skip steps 2 to 4 if you are signed in and keep the same repo and KV.
   Find the existing values with:

   ```bash
   npx wrangler kv namespace list   # the OAUTH_KV namespace dotme already uses
   npx wrangler deployments list --name <worker>
   ```

3. Step 5 with the same `workerName`, `url`, `kvNamespaceId` and
   `githubRepo`. A different `workerName` creates a second Worker without
   secrets; a different `url` signs every client out.
4. Step 6. `/setup/status` should already show the secrets as `ok`. Redo
   step 7 only for an item that is not; `github_token_expiry` warns 30 days
   before the GitHub token expires.
5. Step 8 only on a computer without `~/.config/dotme/auth-header`. Step 9
   only if `passkey` is not `ok`.
6. Step 10 for clients not connected yet. Existing connections keep working.

Upgrading from the old hand-written hook (`~/.config/dotme/sync.sh` in
`~/.claude/settings.json`): remove that entry so preferences are not loaded
twice. See [clients/README.md](clients/README.md#2-claude-code).

## Update

```bash
git pull --ff-only
npm ci
npm run deploy
claude plugin marketplace update dotme   # pulls the new plugin version
npm run codex:hook                       # refreshes the copied hook script
```

**Check:** `/setup/status` is still `allGreen: true`.

## Uninstall

```bash
claude plugin uninstall dotme@dotme
npm run codex:hook -- --remove
codex mcp remove dotme
rm -r ~/.config/dotme
npm run wrangler -- delete               # Human confirms; deletes the Worker and its secrets
npx wrangler kv namespace delete --namespace-id <kv-id>
```

The data repo stays yours; delete it on GitHub if you want it gone. Revoke
the GitHub token in your
[token settings](https://github.com/settings/personal-access-tokens).

## When something fails

- `/setup/status` names the broken piece and how to fix it.
- [clients/README.md](clients/README.md#what-the-session-sees) explains what
  the session hook prints.
- [docs/testing.md](docs/testing.md) has a full test run and a
  troubleshooting table.
