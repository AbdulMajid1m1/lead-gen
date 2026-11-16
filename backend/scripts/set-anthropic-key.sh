#!/bin/bash
# Put a working Anthropic key into live LeadSignal and prove it with one call.
#
# The key is typed here with echo off, travels over SSH on stdin, and is never
# written to the shell history, a command line, or this machine's disk.
# It lands in both copies of backend.env: /opt/leadsignal/env (what Jenkins
# copies on every deploy) and the current release (what is running now).
# Each file is backed up first. Only the api and worker containers restart.
#
# A workspace API key (sk-ant-api03-...) needs nothing else. A user key
# (sk-ant-usr-...) may also need its workspace id (wrkspc_...), asked for below.
#
# Usage: bash scripts/set-anthropic-key.sh
set -euo pipefail

read -r -s -p "Anthropic API key: " KEY
echo
case "$KEY" in
  sk-ant-api*) WS="" ;;
  sk-ant-usr*)
    # Some user keys work on their own; others are refused without a workspace.
    read -r -p "Workspace id (wrkspc_...), or Enter if the key works without one: " WS
    [[ -z "$WS" || "$WS" =~ ^wrkspc_[A-Za-z0-9]+$ ]] || { echo "That is not a workspace id, nothing changed."; exit 1; }
    ;;
  sk-ant-admin*) echo "That is an admin key, which cannot call models. Nothing changed."; exit 1 ;;
  *) echo "That does not look like an Anthropic key, nothing changed."; exit 1 ;;
esac

REMOTE='
set -euo pipefail
IFS= read -r KEY
IFS= read -r WS || true
STAMP=$(date +%Y%m%d-%H%M%S)
for f in /opt/leadsignal/env/backend.env /var/www/leadsignal/current/backend.env; do
  cp -p "$f" "$f.bak-$STAMP"
  tmp=$(mktemp)
  grep -v -E "^(ANTHROPIC_API_KEY|ANTHROPIC_WORKSPACE_ID)=" "$f" > "$tmp" || true
  printf "ANTHROPIC_API_KEY=%s\n" "$KEY" >> "$tmp"
  [ -n "$WS" ] && printf "ANTHROPIC_WORKSPACE_ID=%s\n" "$WS" >> "$tmp"
  cat "$tmp" > "$f"
  rm -f "$tmp"
done
echo "STEP: saved in both backend.env files (backups end in .bak-$STAMP)"
cd /var/www/leadsignal/current
docker compose -p leadsignal-prod -f docker-compose.prod.yml up -d --no-deps api worker >/dev/null 2>&1
for i in $(seq 1 30); do
  [ "$(docker inspect -f "{{.State.Health.Status}}" leadsignal_api_prod 2>/dev/null)" = healthy ] && break
  sleep 2
done
echo "STEP: api and worker restarted ($(docker inspect -f "{{.State.Health.Status}}" leadsignal_api_prod))"
docker exec -w /app leadsignal_api_prod node --input-type=module -e "
const llm = await import(\"./lib/llm/index.js\");
const out = await llm.completeJson({ system: \"Reply only with this JSON: {\\\"ok\\\": true}\", user: \"ping\", maxTokens: 20, timeoutMs: 20000 });
console.log(out && out.ok === true ? \"RESULT: AI works, Claude answered.\" : \"RESULT: FAILED, Claude did not answer. See: docker logs --since 5m leadsignal_api_prod | grep llm\");
process.exit(out && out.ok === true ? 0 : 1);
" 2>/dev/null | grep "^RESULT:"
'

printf '%s\n%s\n' "$KEY" "$WS" | ssh -o BatchMode=yes deventia "bash -c $(printf '%q' "$REMOTE")" | grep -E '^(STEP|RESULT):'
