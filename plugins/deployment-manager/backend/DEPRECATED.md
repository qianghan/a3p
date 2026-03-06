# DEPRECATED

This Express backend has been superseded by the Next.js route handlers and lib code in:

- **Route handlers**: `apps/web-next/src/app/api/v1/deployment-manager/`
- **Core logic**: `apps/web-next/src/lib/deployment-manager/`

The migration was done to enable fully serverless operation on Vercel, following the same
pattern as the service-gateway plugin. All state is now persisted in Prisma (PostgreSQL)
instead of in-memory Maps, and all timer-based services (health monitor, version checker)
have been converted to on-demand invocations triggered by Vercel Cron.

This directory is kept for reference only. Do not use it for new development.
