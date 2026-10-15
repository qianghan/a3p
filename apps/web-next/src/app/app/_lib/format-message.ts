/**
 * Light, SAFE formatting for chat replies.
 *
 * Output is DATA (blocks of inline runs), never HTML. The renderer turns it into
 * React nodes, so every character the server or the LLM sends ends up as a text
 * node, never parsed markup. Agent replies carry Telegram-flavoured HTML (<b>,
 * <br>) and markdown (**bold**, "- " bullets, "1. " plan steps); the result
 * keeps exactly those meanings and drops everything else.
 *
 * Every regex here is linear: no nested or overlapping quantifiers, a bounded
 * class before each terminator, and trimEnd() instead of /\s+$/ (that pattern
 * is quadratic on a long mid-line whitespace run).
 */

export type Inline = { kind: 'text'; text: string } | { kind: 'bold'; text: string };
export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'bullets'; items: Inline[][] }
  | { kind: 'numbered'; start: number; items: Inline[][] };

export const MAX_MESSAGE_CHARS = 8000;

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
  '&amp;': '&',
};

/** Remove `<tag …>…</tag …>` blocks (content included) with indexOf, not a lazy regex. */
function removeBlocks(input: string, tag: string): string {
  const lower = input.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let i = 0;
  while (i < input.length) {
    const start = lower.indexOf(open, i);
    if (start === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, start);
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) break; // unterminated: drop the rest, never show script text
    const gt = lower.indexOf('>', end);
    i = gt === -1 ? input.length : gt + 1;
  }
  return out;
}

export function stripMarkup(raw: string): string {
  let s = String(raw ?? '').slice(0, MAX_MESSAGE_CHARS).replace(/\r\n?/g, '\n');
  s = removeBlocks(s, 'script');
  s = removeBlocks(s, 'style');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li>/gi, '\n- ');
  s = s.replace(/<\/(p|div|li)>/gi, '\n');
  // <b>/<strong> become bold markers; any attributes (onclick=…) are discarded with the tag.
  s = s.replace(/<(b|strong)(?:\s[^<>]*)?>/gi, '**').replace(/<\/(b|strong)>/gi, '**');
  // Repeat until stable: one pass over '<scr<script>ipt>' removes the inner tag and joins the outer halves into a new
  // '<script>'. Each changing pass shortens the string (input is capped), so this terminates.
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, '');
  }
  // Decode LAST: an encoded "&lt;script&gt;" becomes literal text, never a tag.
  s = s.replace(/&(lt|gt|quot|#39|#x27|nbsp|amp);/g, (m) => ENTITIES[m] ?? m);
  return s;
}

// Greedy non-space URL then backtrack to the last ")" — so "javascript:alert(1)" (which
// contains parens) is still recognised as a link target and DROPPED. Bounded: 300 + 2000.
const LINK = /\[([^[\]\n]{1,300})\]\((\S{0,2000})\)/g;

function parseInline(line: string): Inline[] {
  const parts = line.split('**');
  if (parts.length % 2 === 0) {
    // An odd number of markers: the last one is unmatched, keep it literal.
    const tail = parts.pop() as string;
    parts[parts.length - 1] += `**${tail}`;
  }
  const out: Inline[] = [];
  parts.forEach((p, i) => {
    if (!p) return;
    out.push(i % 2 === 1 ? { kind: 'bold', text: p } : { kind: 'text', text: p });
  });
  return out.length ? out : [{ kind: 'text', text: '' }];
}

export function formatMessage(raw: string): Block[] {
  const text = stripMarkup(raw)
    .replace(LINK, (_m: string, label: string) => label)
    .replace(/`/g, '');
  const blocks: Block[] = [];
  let para: Inline[][] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ kind: 'paragraph', lines: para });
      para = [];
    }
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    const bullet = /^\s*[-*•]\s+(\S.*)$/.exec(line);
    if (bullet) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = parseInline(bullet[1]);
      if (last && last.kind === 'bullets') last.items.push(item);
      else blocks.push({ kind: 'bullets', items: [item] });
      continue;
    }
    const numbered = /^\s*(\d{1,3})[.)]\s+(\S.*)$/.exec(line);
    if (numbered) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = parseInline(numbered[2]);
      if (last && last.kind === 'numbered') last.items.push(item);
      else blocks.push({ kind: 'numbered', start: Number(numbered[1]), items: [item] });
      continue;
    }
    const heading = /^\s*#{1,6}\s+(\S.*)$/.exec(line);
    if (heading) {
      para.push([{ kind: 'bold', text: heading[1].split('**').join('') }]);
      continue;
    }
    para.push(parseInline(line));
  }
  flush();
  return blocks;
}
