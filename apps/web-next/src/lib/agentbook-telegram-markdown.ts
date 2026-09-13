/**
 * Markdown (as the LLM writes it) → Telegram HTML.
 *
 * Telegram renders HTML, not markdown. The old converter handled **bold**,
 * *italic* and `code` only, so list bullets ("*   item"), _italic_ and
 * "### Heading" reached users as literal characters — the prod reply of
 * 2026-09-13 showed three `*   ` bullets and an `_Period: …_` line verbatim.
 */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mdToTelegramHtml(md: string): string {
  let html = escHtml(md ?? '');
  // Headings → bold line.
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  // List bullets at line start: "* ", "*   ", "- ", "• " → "• ".
  html = html.replace(/^\s*(?:[*\-•])\s+(?=\S)/gm, '• ');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // *italic* only when not part of a remaining bullet.
  html = html.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  // _italic_ only when the underscores are word-bounded (not snake_case).
  html = html.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s.,;:!?)]|$)/gm, '$1<i>$2</i>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  return html;
}

/**
 * Whether the "📊 Breakdown" block adds information. The query-expenses
 * answer usually already enumerates the top categories; repeating them as a
 * second list is noise on a phone.
 */
export function shouldAppendBreakdown(
  message: string,
  chartData: { data?: Array<{ name?: string }> } | null | undefined,
): boolean {
  const rows = chartData?.data?.filter((d) => d && typeof d.name === 'string') ?? [];
  if (rows.length === 0) return false;
  const lower = (message ?? '').toLowerCase();
  const seen = rows.slice(0, 8).filter((d) => lower.includes(String(d.name).toLowerCase())).length;
  return seen * 2 < Math.min(rows.length, 8);
}
