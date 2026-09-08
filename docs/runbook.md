# NaaP Platform Operations Runbook

## Quick Start

### Prerequisites
- Node.js 20+
- npm 9+
- Docker (for local databases)

### First-Time Setup

```bash
./bin/start.sh          # Setup runs automatically on first start
```

### Starting the Platform

```bash
./bin/start.sh --all                     # Everything
./bin/start.sh                           # Shell + core only
./bin/start.sh dev daydream-video        # Dev mode for one plugin
./bin/start.sh community                 # Start specific plugin
```

### Stopping the Platform

```bash
./bin/stop.sh                    # Graceful stop all
./bin/stop.sh --infra            # Stop all + Docker containers
./bin/stop.sh my-dashboard       # Stop one plugin
```

### Health Checks

```bash
./bin/start.sh validate          # Health-check all services
./bin/start.sh status            # Status dashboard
./bin/start.sh watch 5           # Live dashboard (5s refresh)
```

## Incident Response

### Service Not Responding

1. Check status: `./bin/start.sh status`
2. Check logs: `./bin/start.sh logs <service-name>`
3. Restart the service: `./bin/start.sh restart <plugin-name>`
4. If port is stuck: `lsof -i :<port>` then `kill <pid>`

### Database Issues

1. Check Docker: `docker ps | grep naap`
2. Check DB readiness: `docker exec naap-db pg_isready -U postgres`
3. View DB logs: `docker logs naap-db`
4. Reset database: `cd packages/database && npx prisma db push --force-reset`

### Plugin Not Loading

1. Check plugin is built: `ls plugins/<name>/frontend/dist/production/<name>.js`
2. Rebuild: `cd plugins/<name>/frontend && npm run build`
3. Check plugin-server: `curl http://localhost:3100/plugins/<name>/production/<name>.js`
4. Check browser console for CORS or loading errors

### Full Reset

```bash
./bin/stop.sh --infra            # Stop everything including Docker
docker volume rm naap-db-data    # Delete database data
./bin/start.sh                   # Re-run full setup (automatic)
```

## Port Reference

| Component | Port | Health URL |
|-----------|------|-----------|
| Shell (Next.js) | 3000 | http://localhost:3000 |
| Base Service | 4000 | http://localhost:4000/healthz |
| Plugin Server | 3100 | http://localhost:3100/healthz |
| Capacity Planner | 4003 | http://localhost:4003/healthz |
| Marketplace | 4005 | http://localhost:4005/healthz |
| Community | 4006 | http://localhost:4006/healthz |
| Developer API | 4007 | http://localhost:4007/healthz |
| Wallet | 4008 | http://localhost:4008/healthz |
| Dashboard | 4009 | http://localhost:4009/healthz |
| Plugin Publisher | 4010 | http://localhost:4010/healthz |
| Daydream Video | 4111 | http://localhost:4111/healthz |

## Production Architecture

Production is Vercel plus a managed Postgres — there is nothing to deploy
off-Vercel. The Next.js route handlers in `apps/web-next/src/app/api` ARE the
backend; the Express servers under `plugins/*/backend` are dev-only, and their
exported functions are imported by the route handlers as libraries.

```
┌────────────────────────────────────────────┐
│                  Vercel                    │
│  Next.js shell + route handlers (the API)  │
│  Plugin UMD bundles from /cdn              │
└──────────────────┬─────────────────────────┘
                   │
┌──────────────────▼─────────────────────────┐
│   Supabase Postgres (Vercel Marketplace)   │
└────────────────────────────────────────────┘
```

This section previously described an off-Vercel Docker Compose stack running
`base-svc` and `plugin-server`. Those services were livepeer/naap inheritance,
were never part of this product's deployment, and were deleted in #517 along
with `docker-compose.production.yml` — following the instructions that used to
be here would have failed on a missing file.

### Production Deployment

See `agentbook/skills/deployment.md`. The short version is a local build plus a
prebuilt upload, so Vercel is never asked to build:

```bash
vercel build --prod
vercel deploy --prebuilt --prod
```

### Production Checklist

- [ ] `.env.production` configured with real secrets
- [ ] `DB_PASSWORD` set (not default)
- [ ] `REDIS_PASSWORD` set
- [ ] `NEXTAUTH_SECRET` is random 32+ chars
- [ ] `ENCRYPTION_KEY` is random 32 bytes base64
- [ ] OAuth credentials configured for production domain
- [ ] CORS origins set to production URLs
- [ ] Rate limiting configured (`RATE_LIMIT_AUTH`, `RATE_LIMIT_API`)
- [ ] Sentry DSN configured for error tracking
- [ ] DNS configured for API subdomain
- [ ] SSL certificates configured
- [ ] Database backups configured
- [ ] Monitoring alerts configured

## API Conventions

All APIs follow: `/api/v1/{plugin}/{resource}`

Examples:
- `GET /api/v1/capacity-planner/requests`
- `GET /api/v1/community/posts`
- `POST /api/v1/marketplace/packages`
