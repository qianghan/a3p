import { prisma, Prisma } from '@naap/database';
import { extractYouTubeVideoId } from './youtube.js';
import type { ContentAssetInput, ContentAssetUpdateInput } from './types.js';

/**
 * Pure content catalog — this module has no concept of tenants, roles, or
 * entitlements beyond the opaque `entitlementKey` string callers define and
 * filter by. Access control is entirely the CALLER's responsibility, done
 * before (or in addition to) calling into this module — that boundary is
 * what makes this package reusable by any future feature that needs "some
 * admin-curated content, visible once some caller-defined condition holds,"
 * without this package ever needing to know what that condition is.
 */

/** Everything currently visible for a given category + entitlement — the read path real users hit. */
export async function listActiveAssets(category: string, entitlementKey: string) {
  return prisma.contentAsset.findMany({
    where: { category, entitlementKey, isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
}

/** Everything, including hidden assets, for an admin management UI. */
export async function listAllAssets(category: string, entitlementKey: string) {
  return prisma.contentAsset.findMany({
    where: { category, entitlementKey },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createAsset(input: ContentAssetInput) {
  const youtubeVideoId = extractYouTubeVideoId(input.youtubeUrl);
  if (!youtubeVideoId) {
    throw new Error('That does not look like a valid YouTube URL.');
  }
  return prisma.contentAsset.create({
    data: {
      category: input.category,
      entitlementKey: input.entitlementKey,
      assetType: 'youtube_video',
      title: input.title,
      description: input.description ?? null,
      youtubeVideoId,
      sortOrder: input.sortOrder ?? 0,
      createdBy: input.createdBy,
    },
  });
}

export async function updateAsset(id: string, updates: ContentAssetUpdateInput) {
  const data: Prisma.ContentAssetUpdateInput = {};
  if (updates.title !== undefined) data.title = updates.title;
  if (updates.youtubeUrl !== undefined) {
    const youtubeVideoId = extractYouTubeVideoId(updates.youtubeUrl);
    if (!youtubeVideoId) throw new Error('That does not look like a valid YouTube URL.');
    data.youtubeVideoId = youtubeVideoId;
  }
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.sortOrder !== undefined) data.sortOrder = updates.sortOrder;
  if (updates.isActive !== undefined) data.isActive = updates.isActive;

  return prisma.contentAsset.update({ where: { id }, data });
}
