import 'server-only';
import { listActiveAssets, listAllAssets, createAsset, updateAsset } from '@naap/content-library';
import { requireActiveSalesRep } from './sales-rep';

/**
 * Thin adapter over the generic, feature-agnostic @naap/content-library
 * package — this is the ONLY file in the codebase that knows both "sales
 * rep" and "content library" exist. The library itself never imports from
 * or depends on anything sales-rep-related; if a future feature needs the
 * same "admin-curated content, gated behind qualifying for something"
 * pattern, it gets its own equally-thin adapter like this one rather than
 * this file growing new categories or branches.
 */

const CATEGORY = 'partner_marketing_kit';
const ENTITLEMENT_KEY = 'sales_rep_active';

/** Rep-facing: only videos visible to a CURRENTLY qualified (active) rep. Throws if the tenant isn't one. */
export async function listPartnerMarketingVideos(tenantId: string) {
  await requireActiveSalesRep(tenantId);
  return listActiveAssets(CATEGORY, ENTITLEMENT_KEY);
}

/** Admin-facing: everything in the kit, including hidden videos. */
export async function listAllPartnerMarketingVideos() {
  return listAllAssets(CATEGORY, ENTITLEMENT_KEY);
}

export async function addPartnerMarketingVideo(input: {
  title: string;
  url: string;
  description?: string;
  sortOrder?: number;
  createdBy: string;
}) {
  return createAsset({
    category: CATEGORY,
    entitlementKey: ENTITLEMENT_KEY,
    title: input.title,
    youtubeUrl: input.url,
    description: input.description,
    sortOrder: input.sortOrder,
    createdBy: input.createdBy,
  });
}

export async function editPartnerMarketingVideo(
  id: string,
  updates: { title?: string; url?: string; description?: string | null; sortOrder?: number; isActive?: boolean },
) {
  return updateAsset(id, {
    title: updates.title,
    youtubeUrl: updates.url,
    description: updates.description,
    sortOrder: updates.sortOrder,
    isActive: updates.isActive,
  });
}
