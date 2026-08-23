#!/usr/bin/env bash
# One-shot health snapshot of the whole LeadSignal stack.
set -uo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/var/www/leadsignal/current}"
PROJECT="${PROJECT:-leadsignal-prod}"
COMPOSE_FILE="docker-compose.prod.yml"

echo "── Release ────────────────────────────────────────"
grep -E '^IMAGE_TAG=' "$DEPLOY_DIR/.env" 2>/dev/null || echo "IMAGE_TAG=? (no $DEPLOY_DIR/.env)"
echo "last-good: $(cat /opt/leadsignal/env/.last-good-tag 2>/dev/null || echo none)"

echo
echo "── Containers ─────────────────────────────────────"
docker compose -f "$DEPLOY_DIR/$COMPOSE_FILE" -p "$PROJECT" ps 2>/dev/null \
    || docker ps --filter "name=leadsignal_" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo
echo "── Endpoints ──────────────────────────────────────"
probe() { printf '  %-26s %s\n' "$1" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$2" 2>/dev/null || echo ERR)"; }
probe "api (local 6690)"        "http://127.0.0.1:6690/api/health"
probe "worker (local 6691)"     "http://127.0.0.1:6691/health"
probe "frontend (local 6890)"   "http://127.0.0.1:6890/"
probe "frontend→api proxy"      "http://127.0.0.1:6890/api/health"
probe "https app"               "https://leadgen.deventiatech.com/"
probe "https api"               "https://leadgenapi.deventiatech.com/api/health"

echo
echo "── Backups ────────────────────────────────────────"
ls -1t /var/backups/leadsignal/leadsignal-*.sql.gz 2>/dev/null | head -3 || echo "  none yet"

echo
echo "── Disk ───────────────────────────────────────────"
df -h /var/lib/docker | tail -1
