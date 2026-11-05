#!/usr/bin/env bash
# Make this repo the single source for the fleet tooling on this machine:
#   ~/.claude/fleet/fleet            -> engine/fleet
#   ~/.claude/fleet/fleet-guard      -> engine/fleet-guard
#   ~/.claude/fleet/fleet-view       -> fleet-view/
#   ~/.claude/skills/bosun  -> skills/bosun/
#   VS Code extension local.fleet-view -> ~/.claude/fleet/fleet-view
# and registers fleet-view/hook.js for UserPromptSubmit and Stop, and engine/fleet-guard
# for PreToolUse on file edits, in ~/.claude/settings.json.
# Safe to re-run. Anything already at a target is kept as <target>.bak-<timestamp>.
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

for t in git jq bd node; do
  command -v "$t" >/dev/null 2>&1 || echo "warning: '$t' not found — the engine needs git, jq and bd (Beads); Fleet View needs node"
done

# Replace <target> with a symlink to <source>, backing up whatever was there.
link() {
  local target="$1" source="$2"
  mkdir -p "$(dirname "$target")"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then echo "ok      $target"; return; fi
  if [ -f "$target" ] && [ ! -L "$target" ]; then
    # A file (the engine) may be running right now: swap it in one atomic rename.
    cp -p "$target" "$target.bak-$STAMP"
    ln -s "$source" "$target.new-$$" && mv -f "$target.new-$$" "$target"
    echo "linked  $target -> $source (old copy: $target.bak-$STAMP)"; return
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then mv "$target" "$target.bak-$STAMP"; echo "backup  $target.bak-$STAMP"; fi
  ln -s "$source" "$target"; echo "linked  $target -> $source"
}

chmod +x "$ROOT/engine/fleet" "$ROOT/engine/fleet-guard"
link "$CLAUDE/fleet/fleet" "$ROOT/engine/fleet"
link "$CLAUDE/fleet/fleet-guard" "$ROOT/engine/fleet-guard"
link "$CLAUDE/fleet/fleet-view" "$ROOT/fleet-view"
link "$CLAUDE/skills/bosun" "$ROOT/skills/bosun"

# VS Code: link the extension folder, so the extension runs from the repo too.
EXT_DIR="$HOME/.vscode/extensions"
if command -v code >/dev/null 2>&1; then
  version="$(jq -r .version "$ROOT/fleet-view/package.json")"
  existing="$(ls -d "$EXT_DIR"/local.fleet-view-* 2>/dev/null | head -1 || true)"
  if [ -z "$existing" ]; then
    # First install on this machine: let VS Code register it, then swap the copy for a link.
    tmp="$(mktemp -d)"
    (cd "$ROOT/fleet-view" && npx -y @vscode/vsce package --allow-missing-repository --skip-license -o "$tmp/fleet-view.vsix" >/dev/null)
    code --install-extension "$tmp/fleet-view.vsix" --force >/dev/null
    rm -rf "$tmp"
    existing="$EXT_DIR/local.fleet-view-$version"
  fi
  link "$existing" "$CLAUDE/fleet/fleet-view"
else
  echo "skip    VS Code extension ('code' not on PATH)"
fi

# Claude Code hooks: record session activity and hand review comments to agents.
SETTINGS="$CLAUDE/settings.json"
HOOK='N=$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); "$N" "$HOME/.claude/fleet/fleet-view/hook.js" 2>/dev/null || true'
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
if grep -q 'fleet-view/hook.js' "$SETTINGS"; then
  echo "ok      hooks in $SETTINGS"
else
  cp -p "$SETTINGS" "$SETTINGS.bak-$STAMP"
  jq --arg c "$HOOK" '
    .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + [{hooks: [{type: "command", command: $c, timeout: 5}]}])
    | .hooks.Stop = ((.hooks.Stop // []) + [{hooks: [{type: "command", command: $c, timeout: 5}]}])' \
    "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
  echo "added   hooks to $SETTINGS (old copy: $SETTINGS.bak-$STAMP)"
fi

# The guard: edits in a fleet only in your own claimed worker, and only once the task has a brief.
GUARD='bash "$HOME/.claude/fleet/fleet-guard"'
if grep -q 'fleet/fleet-guard' "$SETTINGS"; then
  echo "ok      guard hook in $SETTINGS"
else
  cp -p "$SETTINGS" "$SETTINGS.bak-$STAMP-guard"
  jq --arg c "$GUARD" '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      + [{matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{type: "command", command: $c, timeout: 5}]}])' \
    "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
  echo "added   guard hook to $SETTINGS (old copy: $SETTINGS.bak-$STAMP-guard)"
fi

echo
echo "Done. Next: create a fleet folder with a fleet.conf (see engine/fleet.conf.example),"
echo "then 'fleet -f <fleet-dir> init' and 'fleet -f <fleet-dir> provision'. Reload VS Code."
echo "The links point into this checkout: keep it on a branch that has these files."
