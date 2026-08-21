#!/usr/bin/env bash
# =============================================================================
# THE TELEGRAM BOT'S USER-FACING STRINGS
# =============================================================================
# The webhook is a route.ts, not a .tsx component, so it sits outside every
# other measure in this file: the JSX-text-node ratchet only looks at .tsx,
# and the plugin/shell split in the unwired-key guard doesn't cover API
# routes at all. It carried 304 hardcoded English strings for that reason —
# invisible to every guard that already existed.
#
# HARD ZERO, not a ratchet: bot.ts reached zero on this measure once
# (2026-08-21) and there is no legacy debt argument for a route file adding a
# NEW hardcoded reply today. A new string here should be a botT() call from
# the moment it's written.
#
# What counts: a string or template literal, inside the webhook, that flows
# into a Telegram-facing call (ctx.reply / sendMessage / answerCallbackQuery /
# a return / an html|message|text|caption field / an array .push). Same
# classifier as the extraction tool (bot_bind.cjs, not checked in — see the
# PR that added this file for how the 304 keys were produced).
#
# What does NOT count, on purpose:
#   - Gemini prompts (ocrReceipt, transcribeVoiceWithGemini, getGeminiKey,
#     callGemini) — translating them degrades OCR/transcription silently.
#   - buildTaxNote — tax GUIDANCE stays English in every locale by product
#     decision. Its amounts already go through fmtAmount.
#   - slash commands and callback_data — machine tokens, not prose.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR" || exit 1

WEBHOOK="apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts"

OUT=$(node - "$WEBHOOK" <<'NODE'
const ts = require('typescript');
const fs = require('fs');
const FILE = process.argv[2];
const src = fs.readFileSync(FILE, 'utf8');
const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);

const PROMPT_FNS = new Set(['ocrReceipt', 'transcribeVoiceWithGemini', 'getGeminiKey', 'callGemini']);
const ENGLISH_FNS = new Set(['buildTaxNote']);

function enclosing(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && n.name && ts.isIdentifier(n.name)) return n.name.text;
  }
  return '(top)';
}
function isPrompt(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && /callGemini|generateContent/i.test(n.expression.getText(sf))) return true;
    if (ts.isPropertyAssignment(n) && n.name && /^(prompt|systemInstruction|instruction|contents)$/.test(n.name.getText(sf))) return true;
  }
  return false;
}
function isReply(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText(sf);
      if (/\breply\b|sendMessage|answerCallbackQuery|editMessageText|\.push$/.test(t)) return true;
    }
    if (ts.isReturnStatement(n)) return true;
    if (ts.isPropertyAssignment(n) && n.name && /^(html|message|text|caption)$/.test(n.name.getText(sf))) return true;
  }
  return false;
}
// Three literals that LOOK like replies to the classifier (they satisfy
// isReply's ".push" / "return" / "message:" shapes) but are not read by a
// bot user:
//   - the e2e mock's getFile fixture path (a test double's own plumbing)
//   - the config-check JSON error, which NextResponse.json sends to whatever
//     called the webhook's HTTP endpoint directly, not to Telegram
//   - the GET health-check body, read by uptime monitoring, not a person
// Hardcoding these is correct, so they are named exclusions rather than a
// weaker classifier that might also excuse a real regression.
const NOT_UI = new Set(['e2e/fixture.jpg', 'Bot not configured', 'AgentBook Telegram webhook active']);

function inBotTCall(node) {
  // A literal that is itself the key/param of a botT(...) call is fine — this
  // guard is about REPLACING replies, not about botT's own arguments.
  for (let n = node; n; n = n.parent) {
    if (ts.isCallExpression(n) && /^botT$/.test(n.expression.getText(sf))) return true;
  }
  return false;
}

let count = 0;
const hits = [];
function visit(node) {
  let text = null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
  else if (ts.isTemplateExpression(node)) {
    text = node.head.text + node.templateSpans.map((s) => '{x}' + s.literal.text).join('');
  }
  if (text !== null) {
    const t = text.trim();
    const words = /[A-Za-z]{2,}/.test(t);
    const sentence = /[\u{1F300}-\u{1FAFF}☀-➿]/u.test(t) || /[A-Za-z]{2,}[ ,.].*[A-Za-z]/.test(t);
    const fn = enclosing(node);
    if (t.length >= 3 && words && sentence && !/^https?:/.test(t)
        && !PROMPT_FNS.has(fn) && !ENGLISH_FNS.has(fn)
        && !isPrompt(node) && isReply(node) && !inBotTCall(node) && !NOT_UI.has(t)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      hits.push(`${FILE}:${line}  ${JSON.stringify(t.slice(0, 70))}`);
      count++;
    }
  }
  ts.forEachChild(node, visit);
}
visit(sf);
console.log(`COUNT=${count}`);
hits.forEach((h) => console.log(h));
NODE
)

COUNT=$(printf '%s\n' "$OUT" | sed -n 's/^COUNT=//p')

echo "[telegram-guard] hardcoded strings reaching a Telegram reply: ${COUNT:-0} (must be 0)"

if [ "${1:-}" = '--list' ]; then
  printf '%s\n' "$OUT" | grep -v '^COUNT=' | sed 's/^/               /'
fi

if [ "${COUNT:-0}" -gt 0 ]; then
  echo "[telegram-guard] FAIL — a new reply in the webhook is hardcoded English."
  echo "                 Add the string to packages/agentbook-i18n/src/locales/*/bot.json"
  echo "                 and call botT('bot.<key>', ...) instead."
  printf '%s\n' "$OUT" | grep -v '^COUNT=' | sed 's/^/               /'
  exit 1
fi
echo '[telegram-guard] PASS'
