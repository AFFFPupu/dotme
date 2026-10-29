#!/bin/sh
# Claude Code SessionStart hook: print the dotme core (collab) so it joins the
# session's context. Falls back to the last copy when the server is unreachable.
#
# Expects in $DOTME_DIR (default ~/.config/dotme):
#   url          the server origin, e.g. https://dotme.example.workers.dev
#   auth-header  "Authorization: Bearer <EXPORT_TOKEN>", mode 600

dir="${DOTME_DIR:-$HOME/.config/dotme}"
cache="$dir/collab.md"

if curl -fsS --max-time 5 -H @"$dir/auth-header" "$(cat "$dir/url")/export/collab.md" -o "$cache.tmp" 2>/dev/null; then
  mv "$cache.tmp" "$cache"
  source="fetched at session start"
else
  rm -f "$cache.tmp"
  [ -s "$cache" ] || exit 0
  source="server unreachable; last copy from $(date -r "$cache" '+%Y-%m-%d %H:%M')"
fi

echo "The user's preferences for how agents talk and work with them, from dotme ($source). Follow them:"
cat "$cache"
