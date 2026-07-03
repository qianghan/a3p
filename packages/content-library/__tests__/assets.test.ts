import { describe, expect, it, vi, beforeEach } from 'vitest';

const contentAssetFindMany = vi.fn();
const contentAssetCreate = vi.fn();
const contentAssetUpdate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    contentAsset: {
      findMany: (...a: unknown[]) => contentAssetFindMany(...a),
      create: (...a: unknown[]) => contentAssetCreate(...a),
      update: (...a: unknown[]) => contentAssetUpdate(...a),
    },
  },
}));

import { extractYouTubeVideoId, listActiveAssets, listAllAssets, createAsset, updateAsset } from '../src/index.js';

beforeEach(() => {
  contentAssetFindMany.mockReset();
  contentAssetCreate.mockReset();
  contentAssetUpdate.mockReset();
});

describe('extractYouTubeVideoId', () => {
  it('extracts from a standard watch URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from a watch URL with extra query params', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from a shortened youtu.be link', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from an embed URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from a mobile (m.youtube.com) URL', () => {
    expect(extractYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for a non-YouTube URL', () => {
    expect(extractYouTubeVideoId('https://vimeo.com/12345678')).toBeNull();
  });

  it('returns null for a YouTube channel/homepage URL with no video id', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/@AgentBook')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(extractYouTubeVideoId('not a url at all')).toBeNull();
  });
});

describe('createAsset', () => {
  it('rejects a non-YouTube URL before ever calling prisma', async () => {
    await expect(
      createAsset({
        category: 'partner_marketing_kit', entitlementKey: 'sales_rep_active',
        title: 'Demo', youtubeUrl: 'https://vimeo.com/12345678', createdBy: 'admin-1',
      }),
    ).rejects.toThrow('valid YouTube URL');
    expect(contentAssetCreate).not.toHaveBeenCalled();
  });

  it('stores the extracted video id and the caller-supplied category/entitlement, not the raw URL', async () => {
    contentAssetCreate.mockResolvedValue({ id: 'a1' });
    await createAsset({
      category: 'partner_marketing_kit',
      entitlementKey: 'sales_rep_active',
      title: 'Product walkthrough',
      youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
      createdBy: 'admin-1',
    });
    expect(contentAssetCreate).toHaveBeenCalledWith({
      data: {
        category: 'partner_marketing_kit',
        entitlementKey: 'sales_rep_active',
        assetType: 'youtube_video',
        title: 'Product walkthrough',
        description: null,
        youtubeVideoId: 'dQw4w9WgXcQ',
        sortOrder: 0,
        createdBy: 'admin-1',
      },
    });
  });
});

describe('updateAsset', () => {
  it('rejects an update that swaps in an invalid URL', async () => {
    await expect(updateAsset('a1', { youtubeUrl: 'not-a-url' })).rejects.toThrow('valid YouTube URL');
    expect(contentAssetUpdate).not.toHaveBeenCalled();
  });

  it('can toggle isActive without touching the video id', async () => {
    contentAssetUpdate.mockResolvedValue({});
    await updateAsset('a1', { isActive: false });
    expect(contentAssetUpdate).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { isActive: false } });
  });
});

describe('listing — scoped by category + entitlementKey, both caller-supplied', () => {
  it('active list filters to isActive within the given category/entitlement and orders by sortOrder', async () => {
    contentAssetFindMany.mockResolvedValue([]);
    await listActiveAssets('partner_marketing_kit', 'sales_rep_active');
    expect(contentAssetFindMany).toHaveBeenCalledWith({
      where: { category: 'partner_marketing_kit', entitlementKey: 'sales_rep_active', isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  });

  it('admin list includes hidden assets within the same category/entitlement scope', async () => {
    contentAssetFindMany.mockResolvedValue([]);
    await listAllAssets('partner_marketing_kit', 'sales_rep_active');
    expect(contentAssetFindMany).toHaveBeenCalledWith({
      where: { category: 'partner_marketing_kit', entitlementKey: 'sales_rep_active' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  });
});
