import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { formatMessage, stripMarkup, MAX_MESSAGE_CHARS } from '../../../app/app/_lib/format-message';
import { MessageBody } from '../../../app/app/chat/_components/MessageBody';

const ALLOWED = new Set(['DIV', 'P', 'BR', 'STRONG', 'UL', 'OL', 'LI']);

function renderBody(text: string) {
  const { container } = render(<MessageBody text={text} />);
  const tags = [...container.querySelectorAll('*')].map((el) => el.tagName);
  const attrs = [...container.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].map((a) => a.name),
  );
  return { container, tags, attrs };
}

describe('formatMessage — structure', () => {
  it('turns **x** into bold and keeps surrounding text', () => {
    expect(formatMessage('You spent **$42.10** on coffee')).toEqual([
      {
        kind: 'paragraph',
        lines: [[
          { kind: 'text', text: 'You spent ' },
          { kind: 'bold', text: '$42.10' },
          { kind: 'text', text: ' on coffee' },
        ]],
      },
    ]);
  });

  it('keeps an unmatched ** as literal text', () => {
    expect(formatMessage('a **b')).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: 'a **b' }]] },
    ]);
  });

  it('single newlines are line breaks, blank lines split paragraphs', () => {
    const blocks = formatMessage('one\ntwo\n\nthree');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      lines: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }]],
    });
  });

  it('groups -, * and • lines into one bullet list', () => {
    const blocks = formatMessage('Top:\n- Meals\n* Travel\n• Software');
    expect(blocks[1]).toEqual({
      kind: 'bullets',
      items: [
        [{ kind: 'text', text: 'Meals' }],
        [{ kind: 'text', text: 'Travel' }],
        [{ kind: 'text', text: 'Software' }],
      ],
    });
  });

  it('keeps numbered plan steps as an ordered list with the right start', () => {
    const blocks = formatMessage("Here's my plan:\n\n1. Edit expense last (irreversible)\n\nProceed? (yes/no)");
    expect(blocks[1]).toEqual({
      kind: 'numbered',
      start: 1,
      items: [[{ kind: 'text', text: 'Edit expense last (irreversible)' }]],
    });
  });

  it('turns Telegram <b>/<br> HTML into bold and line breaks', () => {
    expect(formatMessage('<b>Total</b><br>$12')).toEqual([
      {
        kind: 'paragraph',
        lines: [[{ kind: 'bold', text: 'Total' }], [{ kind: 'text', text: '$12' }]],
      },
    ]);
  });

  it('drops markdown link targets and keeps the label', () => {
    expect(stripMarkup('x')).toBe('x');
    expect(formatMessage('see [your expenses](/agentbook/expenses)')).toEqual([
      { kind: 'paragraph', lines: [[{ kind: 'text', text: 'see your expenses' }]] },
    ]);
  });

  it('decodes entities AFTER stripping tags so encoded markup stays text', () => {
    expect(stripMarkup('&lt;b&gt;hi&lt;/b&gt; &amp; more')).toBe('<b>hi</b> & more');
  });

  it('truncates absurdly long input', () => {
    expect(stripMarkup('a'.repeat(MAX_MESSAGE_CHARS + 50)).length).toBe(MAX_MESSAGE_CHARS);
  });
});

describe('MessageBody — hostile input never becomes markup', () => {
  const HOSTILE: Array<[string, string]> = [
    ['script tag', '<script>alert(1)</script>hi'],
    ['img onerror', '<img src=x onerror=alert(1)>hi'],
    ['svg onload', '<svg onload=alert(1)><circle/></svg>hi'],
    ['iframe', '<iframe src="https://evil.example"></iframe>hi'],
    ['anchor javascript:', '<a href="javascript:alert(1)">hi</a>'],
    ['markdown javascript:', '[hi](javascript:alert(1))'],
    ['bold with handler', '<b onclick="alert(1)">hi</b>'],
    ['style block', '<style>body{display:none}</style>hi'],
    ['unterminated script', 'hi<script>alert(1)'],
    ['encoded script', '&lt;script&gt;alert(1)&lt;/script&gt;hi'],
  ];

  it.each(HOSTILE)('%s renders only allowed elements with no attributes', (_name, input) => {
    const { container, tags, attrs } = renderBody(input);
    expect(tags.filter((t) => !ALLOWED.has(t))).toEqual([]);
    // Only the wrapper's data-testid/style; never href/src/on*.
    expect(attrs.filter((a) => a !== 'data-testid' && a !== 'style' && a !== 'start')).toEqual([]);
    expect(container.innerHTML).not.toMatch(/onerror|onload|onclick|javascript:/i);
    expect(container.textContent).toContain('hi');
  });

  it('script bodies are removed, not shown', () => {
    const { container } = renderBody('<script>alert(1)</script>hi');
    expect(container.textContent).not.toContain('alert(1)');
  });

  it('encoded markup is shown literally as text, not parsed', () => {
    const { container } = renderBody('&lt;script&gt;x&lt;/script&gt;');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>x</script>');
  });

  it('renders bold as <strong> and bullets as <li>', () => {
    const { container } = renderBody('**Due**\n- one\n- two');
    expect(container.querySelector('strong')?.textContent).toBe('Due');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});

describe('formatMessage — no catastrophic backtracking (test the FAILING match)', () => {
  const CASES: Array<[string, string]> = [
    ['many <', '<'.repeat(20000) + 'a'],
    ['many [', '['.repeat(20000) + '('],
    ['whitespace run mid-line', 'a' + ' '.repeat(20000) + 'b'],
    ['bullet then spaces', '-' + ' '.repeat(20000) + 'x'],
    ['many <b', '<b'.repeat(10000)],
    ['many &', '&'.repeat(20000) + 'amp'],
    ['many <script', '<script'.repeat(3000)],
    ['many unclosed link targets', '[a]('.repeat(2000)],
  ];
  it.each(CASES)('%s completes fast', (_n, input) => {
    const t0 = performance.now();
    formatMessage(input);
    // Real cost is ~2 ms per input. The bound only has to separate that from catastrophic backtracking (seconds on
    // 20k chars) while surviving a CPU-starved full-suite run, where 150 ms flaked.
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
