#!/bin/sh
# dotme SessionStart hook, shared by the Claude Code and Codex plugins.
#
# Prints the user's dotme preferences so they join the new session's context
# (both clients add a SessionStart hook's plain stdout as context). Keeps the
# last good copy and falls back to it when the server is unreachable.
#
# Settings, first match wins:
#   server URL   $CLAUDE_PLUGIN_OPTION_SERVER_URL (Claude Code plugin option),
#                $DOTME_URL, or the file $DOTME_DIR/url
#   categories   $CLAUDE_PLUGIN_OPTION_CATEGORIES, $DOTME_CATEGORIES,
#                the file $DOTME_DIR/categories, or collab,coding
#   export token the file $DOTME_DIR/auth-header, holding
#                "Authorization: Bearer <EXPORT_TOKEN>", mode 600
# $DOTME_DIR defaults to ~/.config/dotme. The token is only ever read from
# that file, so it never appears in a command line, an environment variable
# or the session's context.

umask 077
dir="${DOTME_DIR:-$HOME/.config/dotme}"

first() {
  for value in "$@"; do
    if [ -n "$value" ]; then printf '%s' "$value"; return; fi
  done
}
read_file() { [ -r "$1" ] && tr -d ' \t\r\n' < "$1"; }

url=$(first "$CLAUDE_PLUGIN_OPTION_SERVER_URL" "$DOTME_URL" "$(read_file "$dir/url")")
categories=$(first "$CLAUDE_PLUGIN_OPTION_CATEGORIES" "$DOTME_CATEGORIES" "$(read_file "$dir/categories")" "collab,coding")
categories=$(printf '%s' "$categories" | tr -d ' ')
# Accept the server origin or the MCP endpoint URL.
url=${url%/}
url=${url%/mcp}

setup_note() {
  echo "dotme is installed but not set up on this machine: $1. See clients/README.md in the dotme repo."
  exit 0
}
[ -n "$url" ] || setup_note "no server URL"
[ -r "$dir/auth-header" ] || setup_note "no export token in $dir/auth-header"
printf '%s' "$categories" | grep -Eq '^[a-z0-9-]+(,[a-z0-9-]+)*$' || setup_note "invalid categories \"$categories\""

cache="$dir/cache/$(printf '%s' "$categories" | tr ',' '_').md"
mkdir -p "$dir/cache"

status=$(curl -sS --max-time 5 -H @"$dir/auth-header" -o "$cache.tmp" -w '%{http_code}' \
  "$url/export?categories=$categories" 2>/dev/null)
if [ "$status" = 200 ]; then
  mv "$cache.tmp" "$cache"
  source="fetched at session start"
else
  case "$status" in
    000 | "") reason="server unreachable" ;;
    401) reason="the export token was refused (HTTP 401)" ;;
    *) reason="server answered HTTP $status: $(head -c 200 "$cache.tmp" 2>/dev/null | tr '\n' ' ' | sed 's/[ .]*$//')" ;;
  esac
  rm -f "$cache.tmp"
  if [ ! -s "$cache" ]; then
    echo "dotme preferences could not be loaded: $reason."
    exit 0
  fi
  source="$reason; last copy from $(date -r "$cache" '+%Y-%m-%d %H:%M')"
fi

echo "The user's preferences for how agents talk and work with them, from dotme ($source). Follow them."
echo "To add or change one, use the dotme MCP tools (propose_change); the user approves each change."
echo
cat "$cache"
