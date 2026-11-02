# Client plugins

dotme ships a plugin for Claude Code and one for Codex. Both run the same
SessionStart hook (`shared/session-start.sh`): at the start of every session
it fetches your preferences from your dotme server and prints them, and the
client adds them to the session's context. Agents follow them without having
to remember to call a tool. When the server is unreachable, the hook uses the
last copy it fetched.

| | Claude Code | Codex |
|---|---|---|
| SessionStart hook | in the plugin | in the plugin |
| MCP connection | in the plugin | one `codex mcp add` command |
| Approval dialog in the client | when you tick it on the consent page | also needs `mcp_2026_07_28`, see below |

The hook loads `collab,coding` by default. `life` stays out of coding
sessions unless you add it.

Commands below use two placeholders:

- `<worker>`: your dotme server, for example `dotme.example.workers.dev`.
- `<repo>`: the GitHub repo you install dotme from, as `owner/name`. The
  plugins hold no personal values, so the upstream repo and your fork work
  the same.

## 1. Export token (once per machine)

The hook reads your preferences with a read-only export token. These
commands create it, save it in `~/.config/dotme/auth-header` (mode 600) and
store it on the server, without the token ever being printed. Run them in
your dotme checkout, where `wrangler` deploys your Worker:

```bash
mkdir -p ~/.config/dotme && chmod 700 ~/.config/dotme
printf 'https://<worker>\n' > ~/.config/dotme/url
( umask 077; t=$(openssl rand -hex 32)
  printf 'Authorization: Bearer %s\n' "$t" > ~/.config/dotme/auth-header
  printf '%s' "$t" | npx wrangler secret put EXPORT_TOKEN )
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

Then connect the MCP server once: run `/mcp`, pick `dotme`, and sign in on
the consent page. Name the agent `claude-code` and tick "Let this app ask me
to approve changes in its own dialog". Start a new session; it opens with your
preferences.

To change which categories the hook loads, run
`/plugin configure dotme@dotme`, or reinstall with
`--config categories=collab,coding,life`.

**Upgrading from the old hook.** If `~/.claude/settings.json` has a
`SessionStart` hook that runs `~/.config/dotme/sync.sh`, remove that entry,
and remove a `dotme` MCP server you added by hand (`claude mcp remove dotme
-s user`), so preferences are not loaded twice. The plugin reuses
`~/.config/dotme/url` and `~/.config/dotme/auth-header`.

## 3. Codex

```bash
codex plugin marketplace add <repo>
```

Install and enable `dotme` from that marketplace in `/plugins`. Codex asks
you to review and trust the plugin's hook before it runs it.

Connect the MCP server; the URL is yours, so it is not in the plugin:

```bash
codex mcp add dotme --url https://<worker>/mcp
codex mcp login dotme
```

On the consent page, name the agent `codex` and tick the dialog option.

**Approval dialogs.** Codex shows dotme's approval dialog only with the MCP
protocol version 2026-07-28 turned on. The plugin leaves your global flags
alone; to turn it on, add this to `~/.codex/config.toml`:

```toml
[features]
mcp_2026_07_28 = true
```

Without it, the agent gives you a link to the approval page instead, which
works the same.

**If the plugin's hook does not run** in your Codex build, add the hook
yourself:

```bash
cp clients/shared/session-start.sh ~/.config/dotme/session-start.sh
```

and in `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "sh ~/.config/dotme/session-start.sh" }] }
    ]
  }
}
```

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
