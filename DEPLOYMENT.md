# LeadSignal — Deployment Guide

**Domains:** `leadgen.deventiatech.com` (app) · `leadgenapi.deventiatech.com` (API)
**Server:** the same box that runs TracifyHR and Jenkins
**Pipeline:** [Jenkinsfile](Jenkinsfile) · **Stack:** [docker-compose.prod.yml](docker-compose.prod.yml)

---

## 1. Architecture

```
                          Cloudflare DNS
              leadgen.* ──┬── leadgenapi.*
                          ▼
                    Nginx (host, 80/443)
                          │
        ┌─────────────────┴──────────────────┐
        │                                    │
 127.0.0.1:6890                       127.0.0.1:6690
 frontend container                    api container
 (nginx + built SPA)                   (Express + Prisma)
        │                                    ▲
        └──── /api → api:4100 ───────────────┘
              (compose network)
                                              │
        ┌────────────────┬────────────────────┤
        ▼                ▼                    ▼
   worker container   postgres:16        redis:7
   (BullMQ cron)      127.0.0.1:5436     127.0.0.1:6390
```

| Component | Image | Container port | Host port | Public |
|---|---|---|---|---|
| API | `leadsignal-api:build-N` | 4100 | 127.0.0.1:6690 | `leadgenapi.deventiatech.com` |
| Worker | `leadsignal-api:build-N` | 4101 | 127.0.0.1:6691 | no |
| Frontend | `leadsignal-frontend:build-N` | 80 | 127.0.0.1:6890 | `leadgen.deventiatech.com` |
| Postgres | `postgres:16-alpine` | 5432 | 127.0.0.1:5436 | no |
| Redis | `redis:7-alpine` | 6379 | 127.0.0.1:6390 | no |

Ports were chosen to clear TracifyHR (6660 backend, 6967 website) and Jenkins (8080). **Nothing binds to `0.0.0.0`** — nginx is the only public door, so Postgres and Redis are unreachable from the internet even if the firewall is misconfigured.

### Why the app does not call `leadgenapi.deventiatech.com`

The SPA fetches a **relative `/api`**. Host nginx sends it to the frontend container, whose own nginx proxies `/api` → `api:4100` over the compose network. Same origin, so: no CORS preflight on every request, and no API hostname compiled into the JS bundle (the same image runs in any environment). `leadgenapi.deventiatech.com` exists for integrations, webhooks and debugging.

### Server-Sent Events

Discovery and research progress stream over SSE. Buffering must be off at **all three** proxy layers or a user watching a ten-minute run sees nothing and then everything at once:

1. Host nginx — `proxy_buffering off` ([deploy/nginx/leadgen-app.conf](deploy/nginx/leadgen-app.conf))
2. Frontend container nginx — already set in [frontend/nginx.conf](frontend/nginx.conf)
3. Cloudflare — SSE passes through proxied hosts, but if progress ever stalls, grey-cloud `leadgen` to confirm.

---

## 2. Filesystem layout

```
/var/www/leadsignal/              owned by jenkins — no sudo anywhere in the pipeline
├── current/                      live release
│   ├── docker-compose.prod.yml
│   ├── .env                      compose interpolation (generated per build)
│   ├── backend.env               app secrets (copied in, chmod 600)
│   └── deploy/                   scripts + nginx reference copies
├── staging/                      assembled during a deploy, then promoted
└── prev/                         previous release, kept for rollback

/opt/leadsignal/env/              owned by jenkins, chmod 700 — never deployed
├── deploy.env                    POSTGRES_USER / PASSWORD / DB
├── backend.env                   API keys, crawler tuning
└── .last-good-tag                image tag of the last successful deploy

/var/backups/leadsignal/          nightly pg_dump, 14-day retention
```

Secrets live **outside** the release directory on purpose: promote and rollback move whole directories around, and a secret inside one would be deleted by a `rm -rf` on a bad day.

Docker named volumes (survive everything short of `docker volume rm`):
`leadsignal_pgdata_prod`, `leadsignal_redisdata_prod`, `leadsignal_whatsapp_prod`.

---

## 3. First-time server setup

```bash
# 1 — DNS (Cloudflare). Both A records → server IP, proxied is fine.
#     leadgen.deventiatech.com
#     leadgenapi.deventiatech.com

# 2 — Get the code onto the server once, just to run bootstrap.
git clone -b prod https://github.com/AbdulMajid1m1/lead-gen.git /tmp/lead-gen
sudo bash /tmp/lead-gen/deploy/scripts/bootstrap-server.sh

# 3 — TLS certificates.
sudo certbot --nginx -d leadgen.deventiatech.com
sudo certbot --nginx -d leadgenapi.deventiatech.com
sudo nginx -t && sudo systemctl reload nginx

# 4 — Fill in the application secrets.
sudo -u jenkins nano /opt/leadsignal/env/backend.env

# 5 — Restart Jenkins if bootstrap added it to the docker group.
sudo systemctl restart jenkins
```

`bootstrap-server.sh` is idempotent. It creates the directories with the right ownership, generates a random Postgres password, installs both nginx vhosts plus the `$connection_upgrade` map, and enables the nightly backup timer.

### Jenkins job

New **Pipeline** job → *Pipeline script from SCM*:

| Field | Value |
|---|---|
| SCM | Git |
| Repository | `https://github.com/AbdulMajid1m1/lead-gen.git` |
| Credentials | `abdulmajid-git-credentials` |
| Branch | `*/prod` |
| Script Path | `Jenkinsfile` |
| Trigger | GitHub hook, or poll SCM `H/5 * * * *` |

Build once. The first run creates the database, applies all migrations and brings the stack up.

---

## 4. The pipeline

```
Checkout → Preflight → ┌ Backend tests ─┐ → Stage release → Data services
                       ├ Build API      ┤        ↓
                       └ Build frontend ┘   Migrations → Promote → Deploy → Smoke → Cleanup
```

| Stage | What it does |
|---|---|
| **Checkout** | Shallow clone of `prod` (depth 1, no tags) |
| **Preflight** | Docker reachable, dirs writable, both env files present and non-empty, ≥3GB free. **Fails here = production untouched.** |
| **Verify & Build** | Three branches in parallel, fail-fast: 150 unit tests in a throwaway `node:22` container; API image; frontend image. Both images tagged `build-N`. |
| **Stage release** | Assembles `staging/` — compose file, generated `.env`, `backend.env` — then runs `compose config -q` to catch a broken file while the old stack is still live |
| **Data services** | `up -d --wait postgres redis`. Not recreated unless `RECREATE_DATA_SERVICES=true`. |
| **Migrations** | `prisma migrate status` for the log, then `migrate deploy`. Gates the build. |
| **Promote** | `current` → `prev`, `staging` → `current`, drop `.deploy-incomplete` marker |
| **Deploy** | `up -d --wait api worker frontend` — blocks until healthchecks pass |
| **Smoke** | API health, worker health, frontend index, **and the frontend's internal `/api` proxy** |
| **Cleanup** | Keep the newest 4 tags per image, prune the rest, drop `prev/` |

### Build parameters

| Parameter | Default | Use it when |
|---|---|---|
| `RUN_TESTS` | true | Turn off only for an emergency hotfix |
| `FORCE_REBUILD` | false | After a base-image or `apt` dependency change (`--no-cache`) |
| `RECREATE_DATA_SERVICES` | false | After changing the Postgres/Redis image or their compose config |
| `ROLLBACK_TO` | *(empty)* | Emergency: put an image tag like `build-41` here. Skips checkout, tests and build entirely. |

### How it differs from the TracifyHR pipeline

| TracifyHR | LeadSignal | Why |
|---|---|---|
| `docker compose build --no-cache` every time | Layer cache; `--no-cache` behind a flag | The Dockerfiles copy manifests before source, so a code-only change reuses the install layer. Minutes per build. |
| Compose file written by a heredoc inside the Jenkinsfile | Committed `docker-compose.prod.yml` | Reviewable, diffable, and `compose config` can validate it before deploy |
| Serial stages | Tests + both image builds in parallel | Tests cost ~zero wall-clock |
| Rollback = restore a directory and rebuild | Rollback = point `IMAGE_TAG` at the previous build | Seconds, and it works even when the old commit is gone |
| `sudo` in nearly every stage | No `sudo` at all | Directories are jenkins-owned. Removes a whole class of mid-deploy permission failures. |
| `--wait` was the only verification | Four explicit smoke tests | `--wait` cannot catch a broken frontend→API proxy, which silently breaks every page |
| `prisma db push --accept-data-loss` | `prisma migrate deploy` | Applies reviewed SQL files instead of an inferred diff. No data-loss escape hatch. |
| Failure could leave a half-state | Preflight gate + in-flight marker + guarded, `timeout`-bounded failure handler | A failure before promote cannot touch production at all |

---

## 5. Rollback

**Code rolls back. Migrations do not.** That is why the schema policy is additive-only: a release must be able to run against the next release's schema. Never drop or rename a column in a migration.

**Via Jenkins (preferred):** rebuild the job with `ROLLBACK_TO = build-41`.

**Automatic:** any failure after Promote rolls the pipeline back to the last known-good tag and re-verifies the API before declaring success.

**By hand, when Jenkins is the thing that is down:**

```bash
/var/www/leadsignal/current/deploy/scripts/rollback.sh            # list available tags
/var/www/leadsignal/current/deploy/scripts/rollback.sh build-41   # roll back
```

---

## 6. Operations

```bash
# Whole-stack snapshot: release, containers, every endpoint, backups, disk
/var/www/leadsignal/current/deploy/scripts/status.sh

cd /var/www/leadsignal/current
C="docker compose -f docker-compose.prod.yml --env-file .env -p leadsignal-prod"

$C ps                        # what is running
$C logs -f api               # follow API logs
$C logs --tail=200 worker    # maintenance job history
$C restart api               # restart one service
```

### Database

```bash
# psql
docker exec -it leadsignal_postgres_prod psql -U leadsignal -d leadsignal

# Prisma Studio from a laptop, over an SSH tunnel (Postgres is loopback-only)
ssh -L 5436:127.0.0.1:5436 ubuntu@<server>
# then locally: DATABASE_URL="postgresql://leadsignal:<pw>@localhost:5436/leadsignal" npx prisma studio

# Manual backup / restore
sudo -u jenkins /usr/local/bin/leadsignal-backup-db
gunzip -c /var/backups/leadsignal/leadsignal-YYYYMMDD-HHMMSS.sql.gz \
  | docker exec -i leadsignal_postgres_prod psql -U leadsignal -d leadsignal
```

Backups run nightly at ~02:40 UTC with 14-day retention (`systemctl status leadsignal-backup.timer`). The dump runs *inside* the Postgres container so client and server major versions can never drift apart.

> **Never** run `prisma migrate reset`, `db push --force-reset`, `DROP`, or `TRUNCATE` against this database.

### WhatsApp pairing

Credentials live in the `leadsignal_whatsapp_prod` volume, so the QR scan is a one-time thing that survives every deploy. To re-pair: `docker volume rm leadsignal_whatsapp_prod` with the stack down, then restart and scan again from Settings.

### Health endpoints

| Check | Command |
|---|---|
| API (local) | `curl 127.0.0.1:6690/api/health` |
| Worker | `curl 127.0.0.1:6691/health` |
| Frontend → API proxy | `curl 127.0.0.1:6890/api/health` |
| Public app | `curl https://leadgen.deventiatech.com/` |
| Public API | `curl https://leadgenapi.deventiatech.com/api/health` |

---

## 7. Configuration

Three places, deliberately separated:

| Where | Holds | Changed by |
|---|---|---|
| `Jenkinsfile` `environment {}` | Ports, domains, `ALLOWED_ORIGINS`, crawler identity | A reviewed commit |
| `/opt/leadsignal/env/backend.env` | Console credentials, API keys, SMTP, crawler tuning, AI budgets | Editing on the server, then redeploy |
| `/opt/leadsignal/env/deploy.env` | Postgres credentials | Generated at bootstrap; effectively never |

### Signing in

The app is behind a login — there is no public sign-up. `ADMIN_EMAIL` and
`ADMIN_PASSWORD` in `backend.env` provision the first account at boot and are
**required**: the API refuses to start in production without them, and Preflight
fails the build rather than letting the container crash-loop. `bootstrap-server.sh`
generates a password and prints it once; set `ADMIN_EMAIL` yourself.

Changing `ADMIN_PASSWORD` later does *not* overwrite a password changed in the
UI. To force it back after a lockout, set `ADMIN_PASSWORD_RESET=true`, redeploy,
then set it back to `false`.

The session cookie is httpOnly, `sameSite=lax` and `Secure` in production, so
the app only works over HTTPS — which is also why the smoke tests hit the
loopback ports directly rather than going through nginx.

The compose file's explicit `environment:` block **overrides** anything in `backend.env`. That is intentional: `DATABASE_URL`, `REDIS_URL`, `ALLOWED_ORIGINS` and the two crawler safety flags (`CRAWLER_ALLOW_PRIVATE_HOSTS=false`, `CRAWLER_RESPECT_ROBOTS=true`) are pinned in git and cannot be loosened by an edit on the box.

Changing a port or an allowed origin means editing the `Jenkinsfile`, updating the matching nginx vhost, and redeploying — by design, so infrastructure changes leave a trail.

---

## 8. Git workflow

| Branch | Purpose |
|---|---|
| `main` | Development base |
| `prod` | Production — a push here triggers Jenkins |

```bash
git checkout prod && git merge main && git push origin prod
```

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Preflight: "cannot talk to the docker daemon" | `sudo usermod -aG docker jenkins && sudo systemctl restart jenkins` |
| Preflight: "required env file missing" | Run `bootstrap-server.sh`, then fill in `/opt/leadsignal/env/backend.env` |
| Preflight: "ADMIN_EMAIL is missing" | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `backend.env`. The API will not boot without a console account. |
| API unhealthy, logs show `ADMIN_PASSWORD is too weak` | The strength check is fatal in production. Use a longer password with mixed case, a digit and a symbol. |
| Signed out on every page load | The session cookie is `Secure` — the browser must be on HTTPS. Check the certificate and that nginx is not serving the app over plain HTTP. |
| Preflight: low disk | `docker system prune -af --volumes` — **check `docker volume ls` first**, `--volumes` will delete the database |
| Migrations fail | `$C run --rm --no-deps api npx prisma migrate status --schema=prisma/schema`. A failed migration blocks the deploy and leaves the old release running. |
| API unhealthy, logs show `CRAWLER_USER_AGENT must be set` | The Jenkinsfile's `CRAWLER_USER_AGENT` lost its `+http` contact URL — the API refuses to start without one in production |
| API unhealthy, `password authentication failed` | `POSTGRES_PASSWORD` in `deploy.env` was edited after the volume was initialised. Either restore the old value or `ALTER ROLE leadsignal PASSWORD '…'` inside the container. |
| App loads, every request 502 | Frontend container cannot reach `api:4100`. `$C ps` — is `api` healthy? |
| Discovery progress arrives all at once | Buffering is on somewhere. Check `proxy_buffering off` in the host vhost; then grey-cloud the host in Cloudflare to isolate. |
| Worker unhealthy | Almost always Redis. `docker exec leadsignal_redis_prod redis-cli ping` |
| 502 on both domains after reboot | `docker ps`; containers are `restart: always`, so this means the daemon did not start. `sudo systemctl start docker` |
| SSL expired | `sudo certbot renew && sudo systemctl reload nginx` |

---

*LeadSignal — AI Lead Intelligence & Prospect Discovery Platform*
