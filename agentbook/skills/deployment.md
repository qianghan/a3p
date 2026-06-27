# Deployment — Build Locally, Deploy Prebuilt

Default workflow for shipping a3p to Vercel **without burning Vercel build
minutes**. Local machine does the compute-expensive build; Vercel only stores
and serves the output.

## When to use

- **Default for every deploy** to `a3p-plugin-build` (Production and Preview).
- Especially when iterating on a deploy that already failed once on Vercel — you
  want fast local feedback, not 4-minute round trips.
- Skip and use a normal `vercel --prod` only when:
  - You changed `vercel.json` build hooks and want Vercel to re-evaluate them, or
  - Your local machine can't build (different arch, missing tools, etc.).

## The three commands

```bash
# From repo root: /Users/qianghan/Documents/mycodespace/a3p
vercel pull --yes --environment=production    # fetch env vars into .vercel/
vercel build --prod                            # runs vercel.json buildCommand locally → .vercel/output/
vercel deploy --prebuilt --prod                # uploads only .vercel/output/, no remote build
```

For a preview build, drop `--prod` from steps 2 and 3 and pass
`--environment=preview` to step 1.

## Why this works (and what to watch for)

Vercel's `--prebuilt` flag tells the platform: "skip my build, here is the
finished `.vercel/output/` directory; just register it." This means **zero
build-minute consumption on Vercel**. The artifact is identical to what their
build would have produced — same `functions/`, `static/`, and `config.json`
layout.

Things you still get on Vercel:
- Function execution, bandwidth, image optimization, KV/Blob — all metered as
  normal.
- Cron triggers, env vars, domain routing — all configured the same way.
- Logs and analytics.

Things that change:
- **Your local machine becomes the build env.** Whatever Node version, OS, and
  toolchain you have is what builds. Vercel's CI is consistent across deploys;
  yours might not be. Pin the Node version (`.nvmrc` if you don't have one) so
  team members and CI converge.
- **Secrets used at build time must exist locally**, because `vercel build`
  reads them. `vercel pull` writes them to `.vercel/.env.production.local` —
  treat that file like prod secrets (never commit, never log).
- **The build script (`bin/vercel-build.sh`) runs locally.** If it relies on
  `DATABASE_URL` to push Prisma schema, that push will hit the real DB from
  your laptop. Disable Prisma db-push for local builds if that's not what you
  want:
  ```bash
  SKIP_DB_PUSH=1 vercel build --prod
  ```
  (Add the env guard inside `bin/vercel-build.sh` if not already present.)

## First-time setup (one-time per machine)

```bash
# Confirm CLI is logged into the right account
vercel whoami                                  # → qianghan

# Link this repo to the Vercel project (writes .vercel/project.json)
vercel link --yes                              # pick "a3p-plugin-build"

# Pull production env once (creates .vercel/.env.production.local)
vercel pull --yes --environment=production

# Confirm .vercel/ is git-ignored — it contains secrets
grep -q '^\.vercel' .gitignore || echo '.vercel' >> .gitignore
```

## Common failure modes

**`Error: required env variable X is missing`** during `vercel build`:
You haven't run `vercel pull` since X was added on Vercel. Re-pull.

**`Function size exceeded 262 MB`**:
A function-bundle problem, not a build-environment problem — building locally
won't fix it. Two distinct levers; apply both.

1. **Trace excludes** (`outputFileTracingExcludes` in `next.config.js`) strip
   non-runtime weight: build tools (`@rspack`, `@swc`, `vite`, `esbuild`,
   `typescript`, `@nx`, `@babel`), test runtimes (`happy-dom`, `playwright`,
   `puppeteer`), non-Linux binaries (`@next/swc-darwin-*`, `@img/sharp-darwin-*`,
   Prisma engines for darwin/windows), `.map` / `.d.ts` / `README.md` etc. The
   committed config in this repo strips ~250MB and is the right starting point;
   add to the list when a new heavy dep appears.

2. **Prisma engines need symlink dedup.** `@prisma/nextjs-monorepo-workaround-plugin`
   (PrismaPlugin) copies the 16MB engine binary next to EVERY chunk that imports
   `@prisma/client` — ~30 chunks × 5 engine variants = ~535MB of duplicated
   binaries in `.next/server/chunks/`. The fix is a post-build symlink dedup,
   implemented in `bin/vercel-build.sh` step `[5a/6]`. Reclaims ~450MB. Must run
   against BOTH `apps/web-next/.next/server/chunks/` and the standalone copy at
   `apps/web-next/.next/standalone/apps/web-next/.next/server/chunks/` — Vercel
   packages from the standalone tree.

   `serverExternalPackages: ['@prisma/client']` is **not** an alternative to
   PrismaPlugin in this monorepo. It prevents bundling but Prisma's runtime
   resolver can't find the engine because the search paths are computed from
   `apps/web-next/`, not `packages/database/src/generated/client/` where the
   engines actually land in trace.

**`vercel deploy --prebuilt` says "no .vercel/output"**:
You ran `vercel build` without `--prod` but are deploying with `--prod` (or
vice versa). The output dir is environment-tagged. Match them.

**Local build succeeds but deploy still rebuilds on Vercel**:
You forgot `--prebuilt`. Without it Vercel re-runs the build remotely.

## Cost shape (rough numbers)

- Vercel Pro includes 6000 build minutes/month. The a3p build takes ~3–4 min.
  Each `git push` to main triggers a build via the Vercel-Git integration —
  even if the commit doesn't change app code.
- Disable the Git integration if you're going prebuilt-by-default:
  ```bash
  # In Vercel dashboard: Project → Settings → Git → Disable "Auto-deploy"
  ```
  Or via `vercel.json`:
  ```json
  "git": { "deploymentEnabled": false }
  ```
  Then every deploy is intentional, run from your machine with the three
  commands above.

## Skip the Git auto-deploy without disabling

If you want preview builds on PR branches but not on every main commit, leave
the integration on and add `[skip ci]` (or `[vercel skip]`) to commit messages
that don't need a deploy:

```bash
git commit -m "docs: update README [vercel skip]"
```

## Quick reference card

| Goal | Command |
|---|---|
| Local prod build | `vercel pull --yes --environment=production && vercel build --prod` |
| Deploy prebuilt to prod | `vercel deploy --prebuilt --prod` |
| Local preview build | `vercel pull --yes --environment=preview && vercel build` |
| Deploy prebuilt preview | `vercel deploy --prebuilt` |
| Redeploy last good prod (no rebuild) | `vercel redeploy <prod-url>` |
| Inspect what was uploaded | `ls -la .vercel/output/` |
