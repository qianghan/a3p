import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mobile PR 1 schema guard.
 *
 * The production build runs `prisma db push` WITHOUT --accept-data-loss
 * (bin/vercel-build.sh step 3). Adding a column, or a plain index, is not a
 * data-loss change. Adding a UNIQUE constraint to a populated table IS one
 * (Prisma warns that existing duplicates would fail it), and that warning
 * fails the deploy. The from-receipt dedupe therefore uses a plain index plus
 * the AbIdempotencyKey claim, and this test keeps it that way.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const schema = readFileSync(join(ROOT, 'packages/database/prisma/schema.prisma'), 'utf8');
const model = schema.match(/^model AbExpense \{[\s\S]*?^\}/m)?.[0] ?? '';

describe('AbExpense mobile columns (PR 1)', () => {
  it('finds the AbExpense model', () => {
    expect(model).toContain('model AbExpense {');
  });

  it('has a nullable archivedAt with a tenant-scoped index', () => {
    expect(model).toMatch(/^\s+archivedAt\s+DateTime\?/m);
    expect(model).toContain('@@index([tenantId, archivedAt])');
  });

  it('has a nullable idempotencyKey indexed per tenant', () => {
    expect(model).toMatch(/^\s+idempotencyKey\s+String\?/m);
    expect(model).toContain('@@index([tenantId, idempotencyKey])');
  });

  it('adds NO unique constraint on idempotencyKey (would fail the prod db push)', () => {
    expect(model).not.toMatch(/@@unique\(\[[^\]]*idempotencyKey/);
    expect(model).not.toMatch(/idempotencyKey\s+String\?\s+@unique/);
  });
});
