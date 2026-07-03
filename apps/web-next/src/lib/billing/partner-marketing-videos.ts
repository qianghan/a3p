import 'server-only';
import { prisma, Prisma } from '@naap/database';

// Matches youtube.com/watch?v=, youtube.com/embed/, and youtu.be/ — with or
// without extra query params (&t=30s, &list=..., etc.) since the ID is a
// fixed 11-character token and the regex simply stops there.
const YOUTUBE_ID_PATTERN = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

/** Extracts a valid 11-character YouTube video ID from any common URL format, or null if unrecognized. */
export function extractYouTubeVideoId(url: string): string | null {
  const match = url.match(YOUTUBE_ID_PATTERN);
  return match ? match[1] : null;
}

/** Rep-facing: only active, published videos, admin-ordered. */
export async function listActiveMarketingVideos() {
  return prisma.partnerMarketingVideo.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
}

/** Admin-facing: everything, including hidden videos, for the management UI. */
export async function listAllMarketingVideos() {
  return prisma.partnerMarketingVideo.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createMarketingVideo(input: {
  title: string;
  url: string;
  description?: string;
  sortOrder?: number;
  createdBy: string;
}) {
  const youtubeVideoId = extractYouTubeVideoId(input.url);
  if (!youtubeVideoId) {
    throw new Error('That does not look like a valid YouTube URL.');
  }
  return prisma.partnerMarketingVideo.create({
    data: {
      title: input.title,
      youtubeVideoId,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdBy: input.createdBy,
    },
  });
}

export async function updateMarketingVideo(
  id: string,
  updates: { title?: string; url?: string; description?: string | null; sortOrder?: number; isActive?: boolean },
) {
  const data: Prisma.PartnerMarketingVideoUpdateInput = {};
  if (updates.title !== undefined) data.title = updates.title;
  if (updates.url !== undefined) {
    const youtubeVideoId = extractYouTubeVideoId(updates.url);
    if (!youtubeVideoId) throw new Error('That does not look like a valid YouTube URL.');
    data.youtubeVideoId = youtubeVideoId;
  }
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.sortOrder !== undefined) data.sortOrder = updates.sortOrder;
  if (updates.isActive !== undefined) data.isActive = updates.isActive;

  return prisma.partnerMarketingVideo.update({ where: { id }, data });
}
