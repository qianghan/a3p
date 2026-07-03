/**
 * seed-agentbook-defaults.ts
 *
 * Ensures AgentBook plugins are always enabled and marked as core after every
 * build, regardless of what sync-plugin-registry.ts did or any prior DB state.
 *
 * Runs as step [4b/6] in vercel-build.sh, immediately after sync-plugin-registry.
 * Safe to run locally or manually at any time — fully idempotent.
 *
 * What it does:
 *   1. Enables all agentbook* WorkflowPlugin records.
 *   2. Marks all agentbook* PluginPackage records as isCore = true.
 *   3. Disables non-agentbook WorkflowPlugin records (they shouldn't appear in
 *      the sidebar).
 *   4. Marks non-agentbook PluginPackage records as isCore = false.
 *
 * What it does NOT do:
 *   - Touch UserPluginPreference — the /personalized endpoint auto-installs core
 *     plugins lazily on first load, so no manual seeding needed.
 *   - Create new WorkflowPlugin/PluginPackage records — sync-plugin-registry.ts
 *     handles discovery. This script only fixes the flags on existing records.
 *
 * Usage:
 *   npx tsx bin/seed-agentbook-defaults.ts
 */

import { PrismaClient } from '../packages/database/src/generated/client/index.js';

const AGENTBOOK_ORDER: Record<string, number> = {
  agentbookCore:    0,
  agentbookExpense: 1,
  agentbookInvoice: 2,
  agentbookTax:     3,
  agentbookBilling: 4,
};

async function main(): Promise<void> {
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    '';

  if (!dbUrl) {
    console.warn('[seed-agentbook-defaults] No DATABASE_URL found — skipping.');
    process.exit(0);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    // ── WorkflowPlugin ────────────────────────────────────────────────────────

    // Enable all agentbook* plugins with correct order
    const wpAgentbook = await prisma.workflowPlugin.findMany({
      where: { name: { startsWith: 'agentbook' } },
      select: { id: true, name: true, enabled: true, order: true },
    });

    if (wpAgentbook.length === 0) {
      console.warn(
        '[seed-agentbook-defaults] No agentbook WorkflowPlugin records found. ' +
        'Run sync-plugin-registry.ts first or re-deploy to create them.',
      );
    }

    for (const wp of wpAgentbook) {
      const order = AGENTBOOK_ORDER[wp.name] ?? wp.order;
      await prisma.workflowPlugin.update({
        where: { id: wp.id },
        data: { enabled: true, order },
      });
    }
    console.log(
      `[seed-agentbook-defaults] WorkflowPlugin: enabled ${wpAgentbook.length} agentbook plugin(s)`,
    );

    // Disable any non-agentbook plugins that are enabled (old naap plugins, etc.)
    const wpOther = await prisma.workflowPlugin.findMany({
      where: { enabled: true, NOT: { name: { startsWith: 'agentbook' } } },
      select: { id: true, name: true },
    });
    for (const wp of wpOther) {
      await prisma.workflowPlugin.update({
        where: { id: wp.id },
        data: { enabled: false },
      });
    }
    if (wpOther.length > 0) {
      console.log(
        `[seed-agentbook-defaults] WorkflowPlugin: disabled ${wpOther.length} non-agentbook plugin(s): ` +
        wpOther.map((p) => p.name).join(', '),
      );
    }

    // ── PluginPackage ─────────────────────────────────────────────────────────

    // Mark agentbook* packages as isCore = true
    const pkgResult = await prisma.pluginPackage.updateMany({
      where: { name: { startsWith: 'agentbook' } },
      data: { isCore: true },
    });
    console.log(
      `[seed-agentbook-defaults] PluginPackage: set isCore=true on ${pkgResult.count} agentbook package(s)`,
    );

    // Mark non-agentbook packages as isCore = false
    const pkgOtherResult = await prisma.pluginPackage.updateMany({
      where: { isCore: true, NOT: { name: { startsWith: 'agentbook' } } },
      data: { isCore: false },
    });
    if (pkgOtherResult.count > 0) {
      console.log(
        `[seed-agentbook-defaults] PluginPackage: set isCore=false on ${pkgOtherResult.count} non-agentbook package(s)`,
      );
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    const enabledPlugins = await prisma.workflowPlugin.findMany({
      where: { enabled: true },
      select: { name: true, order: true },
      orderBy: { order: 'asc' },
    });
    const corePackages = await prisma.pluginPackage.findMany({
      where: { isCore: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    console.log(
      '[seed-agentbook-defaults] Done.\n' +
      `  Enabled WorkflowPlugins: ${enabledPlugins.map((p) => `${p.name}(${p.order})`).join(', ')}\n` +
      `  Core PluginPackages:     ${corePackages.map((p) => p.name).join(', ')}`,
    );

    // ── sales_rep Role ────────────────────────────────────────────────────────
    // Product-level role (scope 'agentbook'), not a platform-infra role, so
    // this is seeded here rather than in services/base-svc's initializeDefaultRoles().
    await prisma.role.upsert({
      where: { name: 'sales_rep' },
      create: {
        name: 'sales_rep',
        displayName: 'Sales Rep',
        description: 'Promoted affiliate — comped plan, referral commission tracking, own dashboard.',
        permissions: [{ resource: 'sales-rep-dashboard', action: 'read' }],
        canAssign: [],
        inherits: [],
        scope: 'agentbook',
        isSystem: false,
      },
      update: {
        displayName: 'Sales Rep',
        description: 'Promoted affiliate — comped plan, referral commission tracking, own dashboard.',
      },
    });
    console.log('[seed-agentbook-defaults] Role: ensured sales_rep exists');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-agentbook-defaults] Fatal error:', err);
  // Non-fatal — do not block the build.
  process.exit(0);
});
