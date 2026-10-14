/**
 * Receipt photo downscaling (moved from capture/page.tsx).
 *
 * Full-resolution phone photos (3-12 MB) exceed Vercel's 4.5 MB request-body
 * limit: the platform answers 413 with a plain-text body before our route runs,
 * and the old capture page swallowed that — every phone capture failed silently
 * (#235). A single 1800px/0.85 pass fixes the common case; the stepped
 * attempts below cover the pathological one. Falls back to the original file
 * whenever the browser cannot decode it (PDFs, unsupported formats).
 */
export const MAX_UPLOAD_BYTES = 4_000_000;

export const COMPRESS_ATTEMPTS: ReadonlyArray<{ maxDim: number; quality: number }> = [
  { maxDim: 1800, quality: 0.85 },
  { maxDim: 1400, quality: 0.75 },
  { maxDim: 1100, quality: 0.65 },
];

function jpegName(name: string): string {
  const base = (name || 'receipt').replace(/\.[^./\\]+$/, '');
  return `${base}.jpg`;
}

async function renderJpeg(bitmap: ImageBitmap, name: string, maxDim: number, quality: number): Promise<File | null> {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return blob ? new File([blob], jpegName(name), { type: 'image/jpeg' }) : null;
}

export async function compressImage(file: File, attempts = COMPRESS_ATTEMPTS): Promise<File> {
  if (typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    let last: File | null = null;
    for (const { maxDim, quality } of attempts) {
      const out = await renderJpeg(bitmap, file.name, maxDim, quality);
      if (!out) return last ?? file;
      last = out;
      if (out.size <= MAX_UPLOAD_BYTES) return out;
    }
    return last ?? file;
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}
