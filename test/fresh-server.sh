#!/bin/bash
# starts a clean local Worker on port 8801 (development sign-in enabled) and waits until it is ready
pkill -f workerd 2>/dev/null; pkill -f "wrangler dev" 2>/dev/null; sleep 1
rm -rf /tmp/wr-state
cd "$(dirname "$0")/.." || exit 1
(timeout 3000 npx wrangler dev --port 8801 --local --persist-to /tmp/wr-state --var DEV_MODE:1 > /tmp/wr.log 2>&1 &)
for i in $(seq 1 60); do curl -s localhost:8801/api/me >/dev/null 2>&1 && exit 0; sleep 0.5; done
echo "server did not start"; exit 1
