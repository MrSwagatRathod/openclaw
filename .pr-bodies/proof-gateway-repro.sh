#!/usr/bin/env bash
# Reproduces openclaw#119065: `openclaw gateway stop` on a host with no lsof and
# no usable gateway lock, while the gateway is still serving on its port.
set -u
LOCKDIR=$(dirname "$(find "$HOME/.openclaw/tmp" -name 'gateway.*.lock' 2>/dev/null | head -1)")

echo "\$ command -v lsof || echo 'lsof: not installed'"
command -v lsof || echo "lsof: not installed"

echo
echo "\$ curl -s -o /dev/null -w 'gateway HTTP %{http_code}\\n' http://127.0.0.1:18789/"
curl -s -o /dev/null -w "gateway HTTP %{http_code}\n" http://127.0.0.1:18789/

echo
echo "# a missing/stale gateway lock is the #119065 condition"
echo "\$ rm -f \$LOCKDIR/gateway.*.lock"
rm -f "$LOCKDIR"/gateway.*.lock

echo
echo "\$ openclaw gateway stop --json --force"
timeout 150 node /home/user/openclaw/openclaw.mjs gateway stop --json --force 2>&1 | tail -14

echo
echo "# is the gateway actually stopped?"
echo "\$ curl -s -o /dev/null -w 'gateway HTTP %{http_code}\\n' http://127.0.0.1:18789/"
curl -s -o /dev/null -w "gateway HTTP %{http_code}\n" http://127.0.0.1:18789/ || echo "connection refused (really stopped)"
