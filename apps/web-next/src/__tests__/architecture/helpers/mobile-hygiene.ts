/**
 * AST detectors behind mobile-app-hygiene.test.ts.
 *
 * Everything here parses the file with the TypeScript compiler API and judges
 * NODES, never raw text. The first version was a handful of regexes over a
 * comment-stripped string; it missed exactly the shapes redesign code is
 * written in (`<p>Saved {n} receipts</p>`, `{ok ? 'Saved' : 'Failed'}`,
 * `aria-label={'Close'}`, `toast.show('Saved')`) and its comment stripper could
 * erase real code (`'//'` inside a string, `/*` inside a glob). Walking the
 * tree fixes both: a comment is never a token, and a string is judged by WHERE
 * it sits (a JSX child, a copy prop, a toast argument), not by what it looks like.
 *
 * Rules, all reported as Finding[]:
 *
 *   english        user-visible copy that did not go through t()
 *     - any JsxText containing a letter (entities like &nbsp; are not letters)
 *     - a string / template used as a JSX child, including either arm of a
 *       ternary and the right side of && / || / ??
 *     - a string-valued prop in the COPY set (title, label, placeholder,
 *       aria-label, ... plus *Label/*Text/*Title/... suffixes), in either
 *       quote style or the ={'…'} form; the same names as object-literal keys
 *     - the argument of toast.show( / toast( / alert( / set*Error( / new Error(
 *     Props NOT in the set (className, href, role, type, id, aria-live ...) are
 *     never copy, so 'polite' / 'button' / '/app/docs' are not flagged. A string
 *     with no letter ('·', '%', '→') is not English.
 *
 *   colour         a raw colour instead of a kit token
 *     - hex: the WHOLE string is a hex colour ('#10b981'), or a hex colour sits
 *       in a CSS-ish position inside a string ('1px solid #ddd',
 *       'var(--primary, #10b981)'). A '#' glued to a path or URL ('/docs#abc',
 *       'https://x/#abc') is an anchor, not a colour. Only string / template
 *       tokens are examined, so comments and identifiers can never trigger it.
 *     - rgb( / rgba( / hsl( / hsla( with a raw number, in any file except
 *       _kit/tokens.ts (the one place the scrim lives). hsl(var(--x) / ${a}) is
 *       fine: the digits come from a variable.
 *
 *   dynamic-key    t(<not a string literal>) — the resolution check cannot see
 *                  it, so it must say why with `// i18n-dynamic: <reason>`.
 *
 *   bad-suppression  a bare `i18n-ignore` / `i18n-dynamic` with no reason.
 *
 * Escape hatches (same or previous line, REASON REQUIRED, capped in the test):
 *   // i18n-ignore: <reason>    exempts an English finding
 *   // i18n-dynamic: <reason>   exempts a dynamic t() call
 */
import ts from 'typescript';

export type FindingKind = 'english' | 'colour' | 'dynamic-key' | 'bad-suppression';

export interface Finding {
  kind: FindingKind;
  /** The offending text, or a short description. */
  text: string;
  line: number;
}

export interface Analysis {
  findings: Finding[];
  /** Every string literal shaped like a mobile.* catalog key. */
  keys: string[];
  /** Markers that carried a reason (counted against the cap). */
  suppressions: number;
}

/** Product names are identical in every locale and are never catalog keys. */
export const BRAND = new Set(['AgentBook']);

const COPY_PROPS = new Set([
  'title', 'body', 'text', 'label', 'description', 'subtitle', 'hint', 'helper',
  'caption', 'heading', 'placeholder', 'alt', 'message', 'tooltip',
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
]);
const COPY_SUFFIX = /(Label|Text|Title|Message|Description|Placeholder|Caption|Heading|Hint|Subtitle|Helper|Tooltip)$/;

export const isCopyProp = (name: string): boolean => COPY_PROPS.has(name) || COPY_SUFFIX.test(name);

/** The one file allowed to spell out an rgb()/hsl() value. */
export const COLOUR_FUNCTION_ALLOWED = '_kit/tokens.ts';

const KEY_SHAPE = /^mobile\.[a-z0-9_.]+$/i;

/** Letters in any script, once HTML entities are removed. */
function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, ''));
}

function isStringish(n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

/** Static text pieces of a template expression (head, middles, tail). */
function templateParts(n: ts.TemplateExpression): ts.Node[] {
  return [n.head, ...n.templateSpans.map((s) => s.literal)];
}

const textOf = (n: ts.Node): string => (n as ts.LiteralLikeNode).text;

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * The literal nodes an expression can evaluate to directly — a string, a
 * template, either arm of a ternary, the value side of && / || / ??. It does
 * not descend into calls (t('…') returns text that is already translated).
 */
export function copyLiterals(e: ts.Expression): ts.Node[] {
  const x = unwrap(e);
  if (isStringish(x)) return [x];
  if (ts.isTemplateExpression(x)) return templateParts(x);
  if (ts.isConditionalExpression(x)) return [...copyLiterals(x.whenTrue), ...copyLiterals(x.whenFalse)];
  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return copyLiterals(x.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [...copyLiterals(x.left), ...copyLiterals(x.right)];
    }
  }
  return [];
}

function calleeIsToastLike(call: ts.CallExpression | ts.NewExpression): boolean {
  const c = unwrap(call.expression);
  if (ts.isNewExpression(call)) return ts.isIdentifier(c) && c.text === 'Error';
  if (ts.isIdentifier(c)) return /^(toast|alert|notify|showToast)$/.test(c.text) || /^set\w*(Error|Message|Notice|Toast)$/.test(c.text);
  if (ts.isPropertyAccessExpression(c)) {
    const obj = unwrap(c.expression);
    if (ts.isIdentifier(obj) && obj.text === 'console') return false; // developer log, not UI
    if (c.name.text === 'show' || c.name.text === 'notify') return true;
    if (ts.isIdentifier(obj) && obj.text === 'toast') return /^(error|success|info|warning|warn)$/.test(c.name.text);
  }
  return false;
}

interface Marker {
  reason: string | null;
}

function scanMarkers(src: string): { ignore: Map<number, Marker>; dynamic: Map<number, Marker> } {
  const ignore = new Map<number, Marker>();
  const dynamic = new Map<number, Marker>();
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:\/\/|\/\*)\s*(i18n-ignore|i18n-dynamic)\b(?:\s*:\s*([^*]*\S))?/g)) {
      (m[1] === 'i18n-ignore' ? ignore : dynamic).set(i + 1, { reason: m[2]?.trim() || null });
    }
  });
  return { ignore, dynamic };
}

export function analyzeSource(relPath: string, src: string): Analysis {
  const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true, relPath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
  const { ignore, dynamic } = scanMarkers(src);
  const findings: Finding[] = [];
  const keys = new Set<string>();
  const seen = new Set<string>();
  let suppressions = 0;

  const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  // A marker without a reason is itself a violation, wherever it is.
  for (const [line, m] of ignore) if (!m.reason) findings.push({ kind: 'bad-suppression', text: 'i18n-ignore needs a reason', line });
  for (const [line, m] of dynamic) if (!m.reason) findings.push({ kind: 'bad-suppression', text: 'i18n-dynamic needs a reason', line });

  const marked = (markers: Map<number, Marker>, lines: number[]): boolean => {
    for (const l of lines) {
      for (const at of [l, l - 1]) {
        const m = markers.get(at);
        if (m?.reason) return true;
      }
    }
    return false;
  };

  const report = (kind: FindingKind, text: string, pos: number, ownerPos: number) => {
    const key = `${kind}:${pos}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (kind === 'english' && marked(ignore, [lineAt(pos), lineAt(ownerPos)])) return;
    findings.push({ kind, text, line: lineAt(pos) });
  };

  const english = (lit: ts.Node, ownerPos: number, label?: string) => {
    const text = textOf(lit);
    if (!hasLetters(text) || BRAND.has(text.trim())) return;
    report('english', label ? `${label}=${JSON.stringify(text)}` : JSON.stringify(text), lit.getStart(sf), ownerPos);
  };

  const visit = (n: ts.Node): void => {
    // (a) JSX text
    if (ts.isJsxText(n)) {
      const text = n.text;
      if (hasLetters(text) && !BRAND.has(text.trim())) {
        const first = n.getStart(sf) + (text.length - text.trimStart().length);
        report('english', JSON.stringify(text.trim().replace(/\s+/g, ' ')), first, first);
      }
    }

    // (b) JSX expression child: {'x'} {cond ? 'a' : 'b'}
    if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      for (const lit of copyLiterals(n.expression)) english(lit, n.getStart(sf));
    }

    // (c) copy props
    if (ts.isJsxAttribute(n) && n.initializer) {
      const name = n.name.getText(sf);
      if (isCopyProp(name)) {
        const init = n.initializer;
        if (isStringish(init)) english(init, n.getStart(sf), name);
        else if (ts.isJsxExpression(init) && init.expression) for (const lit of copyLiterals(init.expression)) english(lit, n.getStart(sf), name);
      }
    }
    // (c') the same names as object-literal keys: { label: 'Home' }, { ariaLabel: ok ? 'a' : 'b' }
    if (ts.isPropertyAssignment(n)) {
      const nm = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : null;
      if (nm && isCopyProp(nm)) for (const lit of copyLiterals(n.initializer)) english(lit, n.getStart(sf), nm);
    }

    // (d) toast / error / alert arguments
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && calleeIsToastLike(n)) {
      for (const arg of n.arguments ?? []) for (const lit of copyLiterals(arg)) english(lit, n.getStart(sf));
    }

    // key literals (anywhere) + dynamic t()
    if (isStringish(n) && KEY_SHAPE.test(n.text)) keys.add(n.text);
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      const isT = (ts.isIdentifier(c) && c.text === 't') || (ts.isPropertyAccessExpression(c) && c.name.text === 't');
      if (isT) {
        const a = n.arguments[0];
        if (!a || !isStringish(unwrap(a))) {
          const line = lineAt(n.getStart(sf));
          if (!marked(dynamic, [line])) findings.push({ kind: 'dynamic-key', text: `t(${a ? a.getText(sf).slice(0, 40) : ''})`, line });
        }
      }
    }

    // colour: string / template tokens only
    const tokenTexts: string[] = isStringish(n) ? [n.text] : ts.isTemplateExpression(n) ? templateParts(n).map(textOf) : [];
    for (const s of tokenTexts) {
      for (const c of findColours(s, relPath)) report('colour', c, n.getStart(sf), n.getStart(sf));
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);

  for (const m of [...ignore.values(), ...dynamic.values()]) if (m.reason) suppressions++;
  findings.sort((a, b) => a.line - b.line);
  return { findings, keys: [...keys].sort(), suppressions };
}

/** Colour values inside one string token. Exported for direct testing. */
export function findColours(s: string, relPath: string): string[] {
  const out: string[] = [];
  const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  if (HEX.test(s.trim())) out.push(s.trim());
  else if (!s.includes('://')) {
    // CSS-ish position: after whitespace, a comma, a colon or an open paren.
    for (const m of s.matchAll(/(?<=^|[\s,:(])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi)) out.push(m[0]);
  }
  if (relPath !== COLOUR_FUNCTION_ALLOWED) {
    for (const m of s.matchAll(/\b(rgba?|hsla?)\(/gi)) {
      const body = s.slice(m.index! + m[0].length).replace(/var\([^)]*\)/g, '');
      if (/\d/.test(body.split(')')[0])) out.push(`${m[1]}(…)`);
    }
  }
  return out;
}

/** Flatten a namespace tree to dotted STRING leaves: { a: { b: 'x' } } -> ['a.b']. */
export function flattenKeys(data: unknown, prefix = ''): string[] {
  if (typeof data === 'string') return prefix ? [prefix] : [];
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) => flattenKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

/**
 * Keys with no entry in a locale's OWN catalog. Reads the catalog directly:
 * createTranslator falls back fr-CA -> fr -> en, so a key missing from fr-CA
 * resolves to English there and the old check could not fail. A plural family
 * (key_one / key_other) satisfies its base key.
 */
export function unresolvedKeys(keys: string[], catalog: Record<string, unknown>, locales: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const locale of locales) {
    const have = new Set(flattenKeys(catalog[locale]));
    out[locale] = keys.filter((k) => !have.has(k) && !have.has(`${k}_other`) && !have.has(`${k}_one`));
  }
  return out;
}
