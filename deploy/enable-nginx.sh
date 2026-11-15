#!/bin/bash
# Adds the /numen and /numen-voice locations to the shared 443 server block (same approach as
# glumen and cla-kb). Backs up first, tests, and rolls back on failure. Safe to re-run.
set -e
F=/etc/nginx/conf.d/chatbot.conf
SNIP=/etc/nginx/snippets/numen-locations.conf
STAMP=$(date +%Y%m%d%H%M%S)
HERE=$(cd "$(dirname "$0")" && pwd)
sudo cp -p "$F" "$F.bak-numen-$STAMP"
[ -f "$SNIP" ] && sudo cp -p "$SNIP" "$SNIP.bak-$STAMP"
sudo cp "$HERE/nginx-numen.conf" "$SNIP"
if ! sudo grep -q "numen-locations.conf" "$F"; then
  sudo sed -i "s#^\(\s*include /etc/nginx/snippets/cla-kb-locations.conf;\)#\1\ninclude /etc/nginx/snippets/numen-locations.conf;#" "$F"
fi
if sudo nginx -t; then
  sudo systemctl reload nginx
  echo "OK: nginx reloaded. Backup: $F.bak-numen-$STAMP"
else
  sudo cp -p "$F.bak-numen-$STAMP" "$F"
  if [ -f "$SNIP.bak-$STAMP" ]; then sudo cp -p "$SNIP.bak-$STAMP" "$SNIP"; else sudo rm -f "$SNIP"; fi
  echo "nginx test failed; restored the original config. Nothing changed."
  exit 1
fi
