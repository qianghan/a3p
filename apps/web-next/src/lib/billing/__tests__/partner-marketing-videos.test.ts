import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const partnerMarketingVideoFindMany = vi.fn();
const partnerMarketingVideoCreate = vi.fn();
const partnerMarketingVideoUpdate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    partnerMarketingVideo: {
      findMany: (...a: unknown[]) => partnerMarketingVideoFindMany(...a),
      create: (...a: unknown[]) => partnerMarketingVideoCreate(...a),
      update: (...a: unknown[]) => partnerMarketingVideoUpdate(...a),
    },
  },
}));

import {
  extractYouTubeVideoId,
  listActiveMarketingVideos,
  listAllMarketingVideos,
  createMarketingVideo,
  updateMarketingVideo,
} from '../partner-marketing-videos';

beforeEach(() => {
  partnerMarketingVideoFindMany.mockReset();
  partnerMarketingVideoCreate.mockReset();
  partnerMarketingVideoUpdate.mockReset();
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

  it('extracts from a shortened youtu.be link with a timestamp param', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=10')).toBe('dQw4w9WgXcQ');
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

describe('createMarketingVideo', () => {
  it('rejects a non-YouTube URL before ever calling prisma', async () => {
    await expect(
      createMarketingVideo({ title: 'Demo', url: 'https://vimeo.com/12345678', createdBy: 'admin-1' }),
    ).rejects.toThrow('valid YouTube URL');
    expect(partnerMarketingVideoCreate).not.toHaveBeenCalled();
  });

  it('stores the extracted video id, not the raw pasted URL', async () => {
    partnerMarketingVideoCreate.mockResolvedValue({ id: 'v1' });
    await createMarketingVideo({
      title: 'Product walkthrough',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
      createdBy: 'admin-1',
    });
    expect(partnerMarketingVideoCreate).toHaveBeenCalledWith({
      data: {
        title: 'Product walkthrough',
        youtubeVideoId: 'dQw4w9WgXcQ',
        description: null,
        sortOrder: 0,
        createdBy: 'admin-1',
      },
    });
  });
});

describe('updateMarketingVideo', () => {
  it('rejects an update that swaps in an invalid URL', async () => {
    await expect(updateMarketingVideo('v1', { url: 'not-a-url' })).rejects.toThrow('valid YouTube URL');
    expect(partnerMarketingVideoUpdate).not.toHaveBeenCalled();
  });

  it('can toggle isActive without touching the video id', async () => {
    partnerMarketingVideoUpdate.mockResolvedValue({});
    await updateMarketingVideo('v1', { isActive: false });
    expect(partnerMarketingVideoUpdate).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { isActive: false } });
  });

  it('re-extracts the video id when the url is changed', async () => {
    partnerMarketingVideoUpdate.mockResolvedValue({});
    await updateMarketingVideo('v1', { url: 'https://youtu.be/abcdefghijk' });
    expect(partnerMarketingVideoUpdate).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { youtubeVideoId: 'abcdefghijk' },
    });
  });
});

describe('listing', () => {
  it('active list filters to isActive and orders by sortOrder', async () => {
    partnerMarketingVideoFindMany.mockResolvedValue([]);
    await listActiveMarketingVideos();
    expect(partnerMarketingVideoFindMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  });

  it('admin list includes everything', async () => {
    partnerMarketingVideoFindMany.mockResolvedValue([]);
    await listAllMarketingVideos();
    expect(partnerMarketingVideoFindMany).toHaveBeenCalledWith({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  });
});
