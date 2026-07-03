// Matches youtube.com/watch?v=, youtube.com/embed/, and youtu.be/ — with or
// without extra query params (&t=30s, &list=..., etc.) since the ID is a
// fixed 11-character token and the regex simply stops there.
const YOUTUBE_ID_PATTERN = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

/** Extracts a valid 11-character YouTube video ID from any common URL format, or null if unrecognized. */
export function extractYouTubeVideoId(url: string): string | null {
  const match = url.match(YOUTUBE_ID_PATTERN);
  return match ? match[1] : null;
}
