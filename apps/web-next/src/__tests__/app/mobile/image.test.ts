import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compressImage, MAX_UPLOAD_BYTES } from '@/app/app/_lib/image';

const photo = (name = 'IMG_0001.HEIC') => new File(['raw-bytes'], name, { type: 'image/heic' });
let widths: number[];
let blobSizes: number[];

beforeEach(() => {
  widths = [];
  blobSizes = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
    widths.push(this.width);
    const size = blobSizes.length ? blobSizes.shift()! : 1000;
    cb(new Blob([new Uint8Array(size)], { type: 'image/jpeg' }));
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const bitmap = (width: number, height: number) => vi.fn().mockResolvedValue({ width, height, close: vi.fn() });

describe('compressImage', () => {
  it('returns the original when the browser cannot decode images', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const f = photo();
    expect(await compressImage(f)).toBe(f);
  });
  it('downscales a 4000x3000 photo to 1800px JPEG and renames it .jpg', async () => {
    vi.stubGlobal('createImageBitmap', bitmap(4000, 3000));
    const out = await compressImage(photo());
    expect(widths).toEqual([1800]);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_0001.jpg');
  });
  it('names an extension-less file .jpg', async () => {
    vi.stubGlobal('createImageBitmap', bitmap(100, 100));
    expect((await compressImage(photo('camera'))).name).toBe('camera.jpg');
  });
  it('never upscales a small image', async () => {
    vi.stubGlobal('createImageBitmap', bitmap(800, 600));
    await compressImage(photo());
    expect(widths).toEqual([800]);
  });
  it('steps down until the upload fits under the 413 limit', async () => {
    vi.stubGlobal('createImageBitmap', bitmap(4000, 3000));
    blobSizes = [MAX_UPLOAD_BYTES + 1, MAX_UPLOAD_BYTES - 1];
    const out = await compressImage(photo());
    expect(widths).toEqual([1800, 1400]);
    expect(out.size).toBe(MAX_UPLOAD_BYTES - 1);
  });
  it('returns the smallest attempt when nothing fits (the server 413 is then surfaced, not swallowed)', async () => {
    vi.stubGlobal('createImageBitmap', bitmap(4000, 3000));
    blobSizes = [MAX_UPLOAD_BYTES + 3, MAX_UPLOAD_BYTES + 2, MAX_UPLOAD_BYTES + 1];
    const out = await compressImage(photo());
    expect(widths).toEqual([1800, 1400, 1100]);
    expect(out.size).toBe(MAX_UPLOAD_BYTES + 1);
  });
  it('returns the original when decoding fails (e.g. a PDF picked from Files)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode')));
    const f = photo('scan.pdf');
    expect(await compressImage(f)).toBe(f);
  });
  it('returns the original when there is no 2D context', async () => {
    vi.stubGlobal('createImageBitmap', bitmap(4000, 3000));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const f = photo();
    expect(await compressImage(f)).toBe(f);
  });
});
