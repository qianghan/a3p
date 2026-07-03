/**
 * Database client for agentbook-startup plugin
 *
 * Uses the unified @naap/database package (single DB, multi-schema).
 * StartupBenefit* models live in the "plugin_agentbook_startup" PostgreSQL schema.
 */

import { prisma } from '@naap/database';

export const db = prisma;

export default db;
