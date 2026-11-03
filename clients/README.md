# Client plugins

dotme ships a plugin for Claude Code and one for Codex. Both run the same
SessionStart hook (`shared/session-start.sh`): at the start of every session
it fetches your preferences from your dotme server and prints them, and the
client adds them to the session's context. Agents follow them without having
to remember to call a tool. When the server is unreachable, the hook uses the
last copy it fetched.

| | Claude Code | Codex |
|---|---|---|
| SessionStart hook | in the plugin | `npm run codex:hook` adds it to `~/.codex/hooks.json` (Codex 0.164 and later removed plugin hooks) |
| MCP connection | in the plugin | one `codex mcp add` command |
| Approval dialog in the client | yes | not yet, see below |

The hook loads `collab,coding` by default. `life` stays out of coding
sessions unless you add it.

## What you choose, and what to pick

Connecting a client asks you a few things. The defaults are the right answer
almost always.

| Where | Choice | Pick |
|---|---|---|
| Plugin install (Claude Code) | Server URL | Your dotme URL, `https://<worker>`. |
| Plugin install (Claude Code) | Categories loaded at session start | Keep `collab,coding`. This only controls what is copied into each new session; add `life` if you want it there too. |
| Consent page | Agent name | Pre-filled from the app's name. Use a short stable name such as `claude-code` or `codex`; it is stamped on every proposal from this app. |
| Consent page | Categories | Keep all ticked unless you want to hide one from this app. This controls what the app may read and propose to through MCP. |
| Consent page | Approve in this app's own dialog | Pre-ticked for apps on your computer (Claude Code, Codex), off for web apps. An app that cannot show a dialog gets a link anyway. Untick it for an app you do not fully trust. |
| Consent page | Passphrase | Not asked when you are already signed in to `/approve` in this browser. Otherwise sign in with your passkey, or type the passphrase. |
| First tool call in the client | Allow dotme's tools | "Yes, and don't ask again" (or Codex's equivalent). Reading is harmless, and a proposal saves nothing until you approve it. |
| The approval dialog | Accept, Decline, or close | Accept saves. Decline or closing it keeps the proposal pending with a link, where you can reject it. |

Commands below use two placeholders:

- `<worker>`: your dotme server, for example `dotme.example.workers.dev`.
- `<repo>`: the GitHub repo you install dotme from, as `owner/name`. The
  plugins hold no personal values, so the upstream repo and your fork work
  the same.

## 1. Export token (once per machine)

The hook reads your preferences with a read-only export token. These
commands create it, save it in `~/.config/dotme/auth-header` (mode 600) and
store it on the server, without the token ever being printed. Run them in
your dotme checkout, after `dotme.config.json` is set up (see the main README):

```bash
mkdir -p ~/.config/dotme && chmod 700 ~/.config/dotme
printf 'https://<worker>\n' > ~/.config/dotme/url
( umask 077; t=$(openssl rand -hex 32)
  printf 'Authorization: Bearer %s\n' "$t" > ~/.config/dotme/auth-header
  printf '%s' "$t" | npm run -s wrangler -- secret put EXPORT_TOKEN )
```

Check it:

```bash
sh clients/shared/session-start.sh | head -5
```

The first line says `fetched at session start` when everything works.

The server keeps one export token. Running the commands again on a second
machine replaces it and the first machine's hook stops working; copy
`~/.config/dotme/url` and `~/.config/dotme/auth-header` to the second machine
instead.

The export token can read every category, so keep it on your own machines.
Per-category limits belong to OAuth connections, which you set on the consent
page.

## 2. Claude Code

```bash
claude plugin marketplace add <repo>
claude plugin install dotme@dotme --config server_url=https://<worker> --config categories=collab,coding
```

Inside a session the same is `/plugin install dotme --marketplace <repo>`,
which asks for the server URL.

Then connect the MCP server once: run `/mcp`, pick `plugin:dotme:dotme`,
and Allow on the consent page with the agent name `claude-code`. Start a new
session; it opens with your preferences.

The dialog shows the change and the evidence, with an optional "only applies
when" field. **Accept** saves it. **Decline** or closing the dialog keeps it
pending with a link to the approval page, where you approve or reject it.

**If you also use dotme on claude.ai.** Claude Code syncs your claude.ai
connectors in, and it hides a plugin's MCP server when a claude.ai connector
has the same URL. The session then acts as your `claude-ai` agent and gets
links instead of the dialog (`whoami` shows it). A server you add yourself
wins over both, so add dotme once by hand:

```bash
claude mcp add --transport http --scope user dotme https://<worker>/mcp
```

Claude Code then hides the synced `claude.ai dotme` and the plugin's copy,
and uses this one, in every directory. Connect it in `/mcp` as above, with
the agent name `claude-code`. The plugin still loads your preferences at
session start. Without a claude.ai connector you do not need this step.

To change which categories the hook loads, run
`/plugin configure dotme@dotme`, or reinstall with
`--config categories=collab,coding,life`.

**Upgrading from the old hook.** If `~/.claude/settings.json` has a
`SessionStart` hook that runs `~/.config/dotme/sync.sh`, remove that entry
so preferences are not loaded twice. Keep a `dotme` MCP server you added by
hand if you also use the claude.ai connector (see above); otherwise you can
remove it (`claude mcp remove dotme -s user`). The plugin reuses
`~/.config/dotme/url` and `~/.config/dotme/auth-header`.

## 3. Codex

```bash
codex plugin marketplace add <repo>
```

Install and enable `dotme` from that marketplace in `/plugins`.

**Add the hook by hand.** Codex 0.164 and later list `plugin_hooks` as
removed, so the hook inside the plugin does not run. Run this in your dotme
checkout:

```bash
npm run codex:hook
```

It copies `shared/session-start.sh` to `~/.config/dotme/session-start.sh`
and merges one SessionStart entry into `~/.codex/hooks.json`. It keeps every
other hook in that file, never adds a second dotme entry, refuses to touch a
file that is not valid JSON, and backs the file up first
(`hooks.json.bak-dotme-<time>`). It reads and prints no token. Check it, or
take it out again, with:

```bash
npm run codex:hook -- --check
npm run codex:hook -- --remove
```

`--dry-run` prints the file it would write. Run `npm run codex:hook` again
after updating dotme to refresh the copied script. Codex asks you to review
and trust the hook in the next session. If a later Codex runs plugin hooks
again, keep only one of the two (`--remove` drops the manual one), or
preferences load twice.

Connect the MCP server; the URL is yours, so it is not in the plugin:

```bash
codex mcp add dotme --url https://<worker>/mcp
codex mcp login dotme
```

On the consent page, set the agent name to `codex` and Allow.

**Approval dialogs (experimental).** Codex can only show dotme's approval
dialog with the MCP protocol version 2026-07-28, which is behind a flag. You
do not need it: without it you approve on a link. The plugin leaves your
global flags alone; to try it, add this to `~/.codex/config.toml`:

```toml
[features]
mcp_2026_07_28 = true
```

Without it, the agent gives you a link to the approval page instead, which
works the same. In testing, Codex 0.166 still gave a link with the flag on.
To see what Codex sends, run `npm run wrangler -- tail` while it proposes;
each proposal logs the protocol version and client capabilities it arrived
with.

## Settings

The hook takes the first setting it finds:

| Setting | Claude Code plugin option | Environment | File in `~/.config/dotme/` | Default |
|---|---|---|---|---|
| Server URL | `server_url` | `DOTME_URL` | `url` | none |
| Categories | `categories` | `DOTME_CATEGORIES` | `categories` | `collab,coding` |
| Export token | | | `auth-header` | none |

`DOTME_DIR` moves the folder. The token is only read from the file, so it
never appears in a command line, an environment variable or a session.

## What the session sees

| Hook output | Meaning |
|---|---|
| `... (fetched at session start)` | Working. |
| `... (server unreachable; last copy from ...)` | Offline; using the cached copy. |
| `the export token was refused (HTTP 401)` | `auth-header` does not match the server's `EXPORT_TOKEN`; redo step 1. |
| `server answered HTTP 400: Unknown category` | A category in your setting does not exist on the server. |
| `not set up on this machine` | No server URL or no `auth-header`; do step 1. |

## Developing the plugins

The plugins keep their own copy of the hook, because each client copies a
plugin into its cache on install. Edit `shared/session-start.sh`, then run
`npm run sync:plugins`; `npm run check:plugins` fails while a copy differs.
Validate the Claude Code side with `claude plugin validate .`.

Skills (`/dotme-import`, `/dotme-review`) will ship in these plugins.
