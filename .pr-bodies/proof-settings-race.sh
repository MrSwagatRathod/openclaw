#!/usr/bin/env bash
# Two real OS processes racing to create ~/.openclaw/settings.json for the first time.
set -u
AGENT_DIR=$(mktemp -d /tmp/openclaw-settings-race-XXXXXX)
START=$(( $(date +%s%3N) + 1500 ))
echo "agent dir: $AGENT_DIR"
echo "no settings.json yet:"
ls -la "$AGENT_DIR" | tail -n +2

npx tsx /tmp/proof/racer.mts "$AGENT_DIR" defaultModel anthropic/claude-opus-4 "$START" &
P1=$!
npx tsx /tmp/proof/racer.mts "$AGENT_DIR" theme dracula "$START" &
P2=$!
wait $P1; wait $P2

echo "--- resulting settings.json ---"
cat "$AGENT_DIR/settings.json"
echo
echo "--- verdict ---"
HAS_MODEL=$(grep -c 'claude-opus-4' "$AGENT_DIR/settings.json" || true)
HAS_THEME=$(grep -c 'dracula' "$AGENT_DIR/settings.json" || true)
if [ "$HAS_MODEL" -ge 1 ] && [ "$HAS_THEME" -ge 1 ]; then
  echo "PASS: both settings survived the first-write race"
else
  echo "FAIL: a setting was silently lost (model=$HAS_MODEL theme=$HAS_THEME)"
fi
rm -rf "$AGENT_DIR"
