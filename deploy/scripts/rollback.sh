#!/usr/bin/env bash
#
# Manual rollback, for when Jenkins itself is the thing that is down.
#
#   deploy/scripts/rollback.sh            # list what you can roll back to
#   deploy/scripts/rollback.sh build-41   # roll back to that image tag
#
# Note this rolls back CODE only. Database migrations are never reverted — the
# schema policy is additive-only precisely so that the previous release can
# still run against the newer schema.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/var/www/leadsignal/current}"
PROJECT="${PROJECT:-leadsignal-prod}"
COMPOSE_FILE="docker-compose.prod.yml"
API_HOST_PORT="${API_HOST_PORT:-6690}"

cd "$DEPLOY_DIR"

if [[ $# -eq 0 ]]; then
    echo "Currently deployed: $(grep '^IMAGE_TAG=' .env | cut -d= -f2)"
    echo
    echo "Available image tags (newest first):"
    docker images leadsignal-api --filter 'reference=leadsignal-api:build-*' \
        --format '  {{.Tag}}\t{{.CreatedSince}}' | sort -r
    echo
    echo "Usage: $0 <tag>"
    exit 0
fi

TARGET="$1"
docker image inspect "leadsignal-api:$TARGET" >/dev/null 2>&1 \
    || { echo "❌ leadsignal-api:$TARGET is not on this machine."; exit 1; }
docker image inspect "leadsignal-frontend:$TARGET" >/dev/null 2>&1 \
    || { echo "❌ leadsignal-frontend:$TARGET is not on this machine."; exit 1; }

echo "⏪ Rolling back to $TARGET ..."
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$TARGET/" .env
docker compose -f "$COMPOSE_FILE" --env-file .env -p "$PROJECT" up -d --wait api worker frontend

if curl -fsS --max-time 10 "http://127.0.0.1:$API_HOST_PORT/api/health" >/dev/null; then
    printf '%s' "$TARGET" > /opt/leadsignal/env/.last-good-tag
    echo "✅ $TARGET is serving."
else
    echo "🚨 API did not come back healthy. Logs:"
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT" logs --tail=100 api
    exit 1
fi
