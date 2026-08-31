// Reducer tests focused on the recently-fixed display issues:
//   - tool-call arg JSON is collapsed to a single-line preview
//   - the preview is capped at 120 chars
//   - escaped \n / \t inside the JSON don't bleed through

import { describe, expect, it } from 'vitest';
import { collapseAssistantProse, formatCompactEvent, initialState, reducer } from './state.js';

const ESC = String.fromCharCode(0x1b);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const seed = () => initialState('');

describe('state.reducer tool-call preview', () => {
  it('collapses escaped \\n in the args preview', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: '{"command":"python3 -c \\"\\nports = [\\n  80,443\\n]\\""}',
      },
    });
    const last = out.transcript[out.transcript.length - 1];
    expect(last?.kind).toBe('tool-call');
    expect(last?.text).not.toContain('\\n');
    expect(last?.text).toContain('Shell · Run script');
    expect(last?.text).toContain('python3');
  });

  it('caps the preview at 120 chars after the tool name', () => {
    const longArgs = JSON.stringify({ command: 'echo '.repeat(500) });
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: longArgs,
      },
    });
    const last = out.transcript[out.transcript.length - 1];
    // "shell " (6) + 120 + "…" (1) = 127 total. Loose check on the cap.
    expect(last?.text.length).toBeLessThanOrEqual(150);
    expect(last?.text).toMatch(/…$/);
  });

  it('shows Grok-style Shell · title + $ command, not the JSON envelope', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: '{"command":"curl -ksS https://example.com"}',
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toBe(['Shell · HTTP request', '$ curl -ksS https://example.com'].join('\n'));
    expect(last?.prefix).toBe('⏺ ');
    expect(last?.text).not.toContain('{"command"');
  });

  it('renders short BashTool calls with title + $ line', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'BashTool',
        args: {},
        argsJSON: '{"command":"mkdir -p recon/gobus.net"}',
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toBe(['Bash · Create directory', '$ mkdir -p recon/gobus.net'].join('\n'));
    expect(last?.prefix).toBe('⏺ ');
  });

  it('renders echo one-liners as Shell · Print text with truncated $ command', () => {
    const command =
      'echo "<?php system(\'id\'); ?>" > /tmp/test.php && curl -sS -X POST "https://ptl-example.libcurl.so/" -F "file=@/tmp/test.php"';
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: JSON.stringify({ command }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text.startsWith('Shell · Print text\n$ ')).toBe(true);
    expect(last?.text).toContain('$ echo');
    // Long command is one-line truncated.
    expect(last?.text.split('\n')).toHaveLength(2);
    expect(last?.text).toMatch(/…$/);
  });

  it('renders commented shell commands as action title plus command', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: JSON.stringify({
          command: [
            '# Check for Laravel debug mode - try to trigger an error',
            'curl -s "https://egyptianclothingbank.org/donor/login" -X POST',
          ].join('\n'),
        }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toBe(
      [
        'Shell · Check for Laravel debug mode',
        '$ curl -s "https://egyptianclothingbank.org/donor/login" -X POST',
      ].join('\n'),
    );
    expect(last?.prefix).toBe('⏺ ');
  });

  it('renders long uncommented Bash commands as a titled command block', () => {
    const command =
      'curl -fsS --max-time 30 -H \'Accept: application/json\' "https://crt.sh/?q=%25.egyptianclothingbank.org&output=json" 2>/dev/null';
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'BashTool',
        args: {},
        argsJSON: JSON.stringify({ command }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toBe(
      [
        'Bash · HTTP request',
        '$ curl -fsS --max-time 30 -H \'Accept: application/json\' "https://crt.sh/?q=%25.egyptianclothingbank.org&output=json" 2>/de…',
      ].join('\n'),
    );
    expect(last?.prefix).toBe('⏺ ');
  });

  it('uses a descriptive comment instead of env assignment for shell titles', () => {
    const command = [
      'TARGET="https://loyaltycoreapi-mazaya.dsquares.com"',
      '# Map the entire /api/v2/loyalty/ tree by trying every plausible single-segment resource',
      'for r in members cards rewards vouchers transactions offers balances tiers campaigns events notifications accounts profiles users customers merchants branches stores locations items products codes tokens sessions redemptions orders; do',
      '  curl -sS -X GET "$TARGET/api/v2/loyalty/$r"',
      'done',
    ].join('\n');
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: JSON.stringify({ command }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toBe(
      [
        'Shell · Map the entire /api/v2/loyalty/ tree by trying every plausible single-se…',
        '$ TARGET="https://loyaltycoreapi-mazaya.dsquares.com" && for r in members cards rewards vouchers transactions offers balan…',
      ].join('\n'),
    );
    expect(last?.text).not.toContain('Shell · Run TARGET');
  });

  it('uses the real command after leading env assignments for long one-liners', () => {
    const command =
      'TARGET="https://loyaltycoreapi-mazaya.dsquares.com" curl -sS -X GET "$TARGET/api/v2/loyalty/reward" -H "Accept: application/json" --max-time 10';
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: JSON.stringify({ command }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toContain('Shell · HTTP request');
    expect(last?.text).not.toContain('Run TARGET');
  });

  it.each([
    ['mkdir -p recon/gobus.net && touch recon/gobus.net/notes.txt', 'Create directory'],
    ['rg -n "Authorization" src README.md package.json '.repeat(4), 'Search files'],
    ['find . -type f -name "*.ts" -maxdepth 4 '.repeat(4), 'Find files'],
    ['jq -r ".items[].name" response.json '.repeat(5), 'Process text'],
    ['python3 - <<PY\nprint("hello")\nPY', 'Run script'],
    ['npm run test -- --runInBand '.repeat(5), 'Run package task'],
    ['git status --short --branch && git diff --stat '.repeat(4), 'Git command'],
  ])('renders long shell command "%s" as %s', (command, title) => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: JSON.stringify({ command }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toContain(`Shell · ${title}`);
    expect(last?.text).toContain('\n$ ');
  });

  it('renders a confirmed finding as a severity-labeled finding card', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'confirm_finding',
        args: {},
        argsJSON: JSON.stringify({
          severity: 'low',
          title: 'Information Disclosure - PHP Version in Response Headers',
          method: 'GET',
          url: 'https://x.test/',
          parameter: 'debug',
          impact: 'Leaks the PHP version.',
        }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.kind).toBe('finding');
    expect(last?.prefix).toBe('★ ');
    expect(last?.color).toBe('cyan'); // low → cyan
    expect(last?.text).toContain('LOW · Information Disclosure - PHP Version in Response Headers');
    expect(last?.text).toContain('GET https://x.test/  (param: debug)');
    expect(last?.text).toContain('impact: Leaks the PHP version.');
  });

  it('colors finding cards by severity', () => {
    const cardColor = (severity: string): string | undefined => {
      const out = reducer(seed(), {
        type: 'agent-event',
        event: {
          type: 'tool-call',
          id: 'c1',
          name: 'confirm_finding',
          args: {},
          argsJSON: JSON.stringify({ severity, title: 'T', url: 'https://x.test/', impact: 'i' }),
        },
      });
      return out.transcript.at(-1)?.color;
    };
    expect(cardColor('critical')).toBe('magenta');
    expect(cardColor('high')).toBe('red');
    expect(cardColor('medium')).toBe('yellow');
    expect(cardColor('low')).toBe('cyan');
    expect(cardColor('info')).toBe('gray');
  });

  it('falls back to a normal tool-call when finding args lack a title', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'confirm_finding',
        args: {},
        argsJSON: '{not valid json',
      },
    });
    expect(out.transcript.at(-1)?.kind).toBe('tool-call');
  });

  it('compacts scope / http / skill / read like Shell (title + detail line)', () => {
    const scope = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: '1',
        name: 'scope',
        args: {},
        argsJSON: JSON.stringify({ action: 'add', pattern: 'testaspnet.vulnweb.com' }),
      },
    });
    expect(scope.transcript.at(-1)?.text).toBe(
      ['Scope · add', '│ testaspnet.vulnweb.com'].join('\n'),
    );
    expect(scope.transcript.at(-1)?.prefix).toBe('⏺ ');

    const http = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: '2',
        name: 'http',
        args: {},
        argsJSON: JSON.stringify({ method: 'GET', url: 'https://example.com/api' }),
      },
    });
    expect(http.transcript.at(-1)?.text).toBe(
      ['HTTP · GET', '│ https://example.com/api'].join('\n'),
    );

    const skill = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: '3',
        name: 'load_skill',
        args: {},
        argsJSON: JSON.stringify({ name: 'webvuln', fork: true }),
      },
    });
    expect(skill.transcript.at(-1)?.text).toBe('Skill · webvuln · forked');

    const read = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: '4',
        name: 'file_read',
        args: {},
        argsJSON: JSON.stringify({ path: 'src/cli/index.ts' }),
      },
    });
    expect(read.transcript.at(-1)?.text).toBe(['Read · file', '│ src/cli/index.ts'].join('\n'));
  });

  it('renders the confirm_finding result as a quiet saved-path note', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'confirm_finding',
        result: 'Finding "XSS" written to ./findings/xss.md',
        err: '',
        durationMs: 4,
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.kind).toBe('tool-result');
    // No generic "[ok] confirm_finding (4ms)" prefix — just the confirmation.
    expect(last?.text).toBe('Finding "XSS" written to ./findings/xss.md');
  });

  it('renders ask_user calls as a compact human prompt summary', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'ask_user',
        args: {},
        argsJSON: JSON.stringify({
          questions: [
            {
              header: 'Scope',
              question:
                'Confirming scope — I want to make sure I test the right surface. Which of these matches the engagement?',
              options: [
                { label: 'Passive only', description: 'No active probing.' },
                { label: 'Full recon', description: 'Include pivots.' },
              ],
            },
          ],
        }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toBe(
      'Ask User · Scope · 1 question · Confirming scope — I want to make sure I test the right surface. Which of these matches the engagem…',
    );
    expect(last?.text).not.toContain('"options"');
  });

  it('strips raw control chars from the shell command preview', () => {
    const args = JSON.stringify({ command: 'printf line1\nline2\tcol' });
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'shell',
        args: {},
        argsJSON: args,
      },
    });
    const last = out.transcript[out.transcript.length - 1];
    // Title line + single $ command line (newlines flattened in the command).
    expect(last?.text.split('\n')).toHaveLength(2);
    expect(last?.text).toContain('Shell ·');
    expect(last?.text).toContain('$ printf line1 line2 col');
    expect(last?.text).not.toContain('\t');
  });

  it('redacts secrets even when ANSI styling is embedded in tool args', () => {
    const secret = `sk-${'a'.repeat(24)}`;
    const styled = `sk-${ESC}[31m${'a'.repeat(12)}${ESC}[0m${'a'.repeat(12)}`;
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'secret-1',
        name: 'shell',
        args: {},
        argsJSON: JSON.stringify({ command: `echo ${styled}` }),
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).not.toContain(secret);
    expect(last?.text).toContain('[REDACTED:');
  });
});

describe('state.reducer streaming / committed-live split', () => {
  const ev = (event: Parameters<typeof reducer>[1] extends { event: infer E } ? E : never) =>
    ({ type: 'agent-event', event }) as const;

  it('records decision planner summaries as quiet decision lines', () => {
    const out = reducer(
      seed(),
      ev({
        type: 'decision',
        summary:
          'decision planner: selected skill: graphql · risk: normal · matched graphql signals: pentest',
      }),
    );
    expect(out.transcript.at(-1)).toMatchObject({
      kind: 'decision',
      text: 'plan · graphql',
    });
  });

  it('keeps short plan · lines as-is', () => {
    const out = reducer(seed(), ev({ type: 'decision', summary: 'plan · recon · high risk' }));
    expect(out.transcript.at(-1)?.text).toBe('plan · recon · high risk');
  });

  it('advances the phase off "planning" as soon as a streamed delta arrives', () => {
    // Reproduces the "stuck on planning" report: while busy, a streaming
    // response must flip the phase to "answering" so the status line stops
    // claiming we're still thinking for the whole generation.
    let s = reducer(seed(), { type: 'set-busy', busy: true });
    expect(s.phase).toBe('planning');
    s = reducer(s, ev({ type: 'assistant-delta', text: 'Here is my plan' }));
    expect(s.phase).toBe('answering');
    expect(s.transcript.at(-1)?.text).toBe('Here is my plan');
  });

  it('does not change phase on a delta when not busy', () => {
    const s = reducer(seed(), ev({ type: 'assistant-delta', text: 'x' }));
    expect(s.phase).toBe('idle');
  });

  it('keeps a streaming assistant entry flagged until done finalizes it', () => {
    let s = reducer(seed(), ev({ type: 'assistant-delta', text: 'hel' }));
    s = reducer(s, ev({ type: 'assistant-delta', text: 'lo' }));
    const live = s.transcript.at(-1);
    expect(live?.kind).toBe('assistant');
    expect(live?.streaming).toBe(true);
    expect(live?.text).toBe('hello');

    // 'done' finalizes the tail streaming entry so it can join the log.
    s = reducer(s, ev({ type: 'done' }));
    expect(s.transcript.at(-1)?.streaming).toBe(false);
    expect(s.busy).toBe(false);
  });

  it('surfaces a backend retry as a visible system notice (human in the loop)', () => {
    const s = reducer(
      seed(),
      ev({ type: 'retry', attempt: 2, delayMs: 1500, message: 'rate limited (429)' }),
    );
    const last = s.transcript.at(-1);
    expect(last?.kind).toBe('system');
    expect(last?.text).toContain('rate limited (429)');
    expect(last?.text).toContain('retrying in 1.5s');
    expect(last?.text).toContain('attempt 2');
  });
});

describe('state.reducer clear', () => {
  it('cycles transcript filters in UI order', () => {
    let s = seed();
    expect(s.transcriptFilter).toBe('all');
    s = reducer(s, { type: 'cycle-transcript-filter' });
    expect(s.transcriptFilter).toBe('compact');
    s = reducer(s, { type: 'cycle-transcript-filter' });
    expect(s.transcriptFilter).toBe('findings');
    s = reducer(s, { type: 'cycle-transcript-filter' });
    expect(s.transcriptFilter).toBe('errors');
    s = reducer(s, { type: 'cycle-transcript-filter' });
    expect(s.transcriptFilter).toBe('current');
    s = reducer(s, { type: 'cycle-transcript-filter' });
    expect(s.transcriptFilter).toBe('all');
  });

  it('empties the transcript and bumps clearGen to remount the log', () => {
    const withEntry = reducer(seed(), {
      type: 'append',
      entry: { kind: 'system', text: 'hi' },
    });
    const cleared = reducer(withEntry, { type: 'clear' });
    expect(cleared.transcript).toHaveLength(0);
    expect(cleared.clearGen).toBe(withEntry.clearGen + 1);
  });
});

describe('state.reducer compact mode', () => {
  it('defaults to off and flips on set-compact-mode', () => {
    const s = seed();
    expect(s.compactMode).toBe(false);
    const on = reducer(s, { type: 'set-compact-mode', on: true });
    expect(on.compactMode).toBe(true);
    const off = reducer(on, { type: 'set-compact-mode', on: false });
    expect(off.compactMode).toBe(false);
  });
});

describe('state.reducer tool-result body', () => {
  it('renders successful empty BashTool output as Done', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'BashTool',
        result: 'exit: 0\nstdout:\n',
        err: '',
        durationMs: 12,
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.kind).toBe('tool-result');
    expect(last?.text).toBe('Done');
    expect(last?.prefix).toBe('  ⎿ ');
  });

  it('keeps successful shell stdout compact', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'shell',
        result: 'exit: 0\nstdout:\n101',
        err: '',
        durationMs: 12,
      },
    });
    const last = out.transcript[out.transcript.length - 1];
    expect(last?.text).toBe('[ok] shell (12ms)\n101');
  });

  it('labels non-zero empty BashTool output by exit code without blank stdout', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'BashTool',
        result: 'exit: 1\nstdout:\n',
        err: '',
        durationMs: 15,
      },
    });
    const last = out.transcript[out.transcript.length - 1];
    expect(stripAnsi(last?.text ?? '')).toBe('[exit 1] shell (15ms)\nexit: 1\n(no output)');
  });

  it('renders grep no-match as no match instead of generic exit 1', () => {
    let out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-call',
        id: 'c1',
        name: 'BashTool',
        args: {},
        argsJSON:
          '{"command":"curl -ksS -I \\"https://www.nogal-furniture.com/dashboard/login\\" | grep -iE \\"x-frame|frame\\""}',
      },
    });
    out = reducer(out, {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'BashTool',
        result: 'exit: 1\nstdout:\n',
        err: '',
        durationMs: 735,
      },
    });
    const last = out.transcript[out.transcript.length - 1];
    expect(stripAnsi(last?.text ?? '')).toBe('[no match] shell (735ms)\n(no matches)');
  });

  it('labels BashTool stderr-only failures by exit code', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'BashTool',
        result: [
          'exit: 2',
          'stdout:',
          'stderr:',
          "/bin/bash: -c: line 0: unexpected EOF while looking for matching `''",
          '/bin/bash: -c: line 1: syntax error: unexpected end of file',
        ].join('\n'),
        err: '',
        durationMs: 2,
      },
    });
    const plain = stripAnsi(out.transcript.at(-1)?.text ?? '');
    expect(plain).toContain('[exit 2] shell (2ms)\nexit: 2\nstderr:\n/bin/bash');
    expect(plain).not.toContain('stdout:');
  });

  it('renders ask_user answers without raw JSON', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'ask_user',
        result: JSON.stringify({
          answers: [
            {
              question:
                'Confirming scope — I want to make sure I test the right surface. Which of these matches the engagement?',
              answer: 'Full recon: dsquares.com + all mazaya* apexes + pivots',
            },
            {
              question: 'How deep should the testing go?',
              answer: 'Active web vuln hunt',
            },
          ],
        }),
        err: '',
        durationMs: 15742,
      },
    });
    const last = out.transcript.at(-1);
    expect(last?.text).toBe(
      [
        '[ok] Ask User (15742ms)',
        'answers:',
        '- Full recon: dsquares.com + all mazaya* apexes + pivots',
        '  Confirming scope — I want to make sure I test the right surface. Which of these matches the engagement?',
        '- Active web vuln hunt',
        '  How deep should the testing go?',
      ].join('\n'),
    );
    expect(last?.text).not.toContain('"answers"');
  });
});

describe('state.reducer child-progress (↳ expandable)', () => {
  it('upserts a live progress line and becomes collapsible when done', () => {
    let s = seed();
    s = reducer(s, {
      type: 'child-progress',
      key: 'skill:recon',
      label: 'recon',
      tools: [],
      done: false,
    });
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]?.prefix).toBe('↳ ');
    expect(s.transcript[0]?.text).toBe('recon…');
    expect(s.transcript[0]?.collapsible).toBeUndefined();

    s = reducer(s, {
      type: 'child-progress',
      key: 'skill:recon',
      label: 'recon',
      tools: ['load_skill', 'todo'],
      done: false,
    });
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]?.text).toBe('recon · 2 tools…');

    s = reducer(s, {
      type: 'child-progress',
      key: 'skill:recon',
      label: 'recon',
      tools: ['load_skill', 'todo', 'scope', 'BashTool'],
      done: true,
    });
    expect(s.transcript).toHaveLength(1);
    const row = s.transcript[0];
    expect(row?.collapsible).toBe(true);
    expect(row?.text).toContain('recon · 4 tools');
    expect(row?.text).toContain('expand');
    expect(row?.fullText).toContain('1. load_skill');
    expect(row?.fullText).toContain('4. shell');
  });

  it('click/toggle expands and collapses the tool list in place', () => {
    let s = reducer(seed(), {
      type: 'child-progress',
      key: 'skill:recon',
      label: 'recon',
      tools: ['todo', 'scope'],
      done: true,
    });
    s = reducer(s, { type: 'toggle-expand', progressKey: 'skill:recon' });
    expect(s.transcript[0]?.expanded).toBe(true);
    s = reducer(s, { type: 'toggle-expand', progressKey: 'skill:recon' });
    expect(s.transcript[0]?.expanded).toBe(false);
  });

  it('Ctrl-O expands progress in place without appending a second entry', () => {
    let s = reducer(seed(), {
      type: 'child-progress',
      key: 'explore',
      label: 'explore',
      tools: ['http', 'grep'],
      done: true,
    });
    s = reducer(s, { type: 'expand-tool-output' });
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]?.expanded).toBe(true);
  });
});

describe('collapseAssistantProse', () => {
  it('leaves short replies alone', () => {
    const c = collapseAssistantProse('PWNED\nShort note.');
    expect(c.collapsible).toBe(false);
    expect(c.preview).toBe(c.full);
  });

  it('collapses long narrative with a click cue', () => {
    const body = [
      'The PHP file was uploaded and executed on the server.',
      'The upload has no validation.',
      'This is unrestricted file upload leading to RCE.',
      'Confirming with coverage tracking next.',
      'Reporting after reproduction is complete.',
      'Impact is full remote code execution as www-data.',
      'Remediation is strict content-type and extension allowlists.',
      'PoC: upload pwn.php then GET /upload/pwn.php.',
    ].join('\n');
    const c = collapseAssistantProse(body);
    expect(c.collapsible).toBe(true);
    expect(c.preview).toContain('click to expand');
    expect(c.preview.length).toBeLessThan(c.full.length);
    expect(c.full).toContain('PoC: upload pwn.php');
  });
});

describe('state.reducer collapsible assistant text', () => {
  it('collapses a long assistant-text event for click expand', () => {
    const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about the finding.`).join(
      '\n',
    );
    const out = reducer(seed(), {
      type: 'agent-event',
      event: { type: 'assistant-text', text: body },
    });
    const last = out.transcript.at(-1);
    expect(last?.kind).toBe('assistant');
    expect(last?.collapsible).toBe(true);
    expect(last?.text).toContain('click to expand');
    expect(last?.fullText).toContain('Paragraph 11');
  });

  it('click toggles the full assistant body in place', () => {
    const body = Array.from({ length: 12 }, (_, i) => `Line ${i} of analysis.`).join('\n');
    let s = reducer(seed(), {
      type: 'agent-event',
      event: { type: 'assistant-text', text: body },
    });
    const full = s.transcript[0]?.fullText;
    s = reducer(s, { type: 'toggle-expand', fullText: full });
    expect(s.transcript[0]?.expanded).toBe(true);
    s = reducer(s, { type: 'toggle-expand', fullText: full });
    expect(s.transcript[0]?.expanded).toBe(false);
  });
});

describe('state.reducer expandable tool-result', () => {
  const ESC = String.fromCharCode(0x1b);
  const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

  // A browser-snapshot-shaped MCP result: long YAML inside a text block.
  const bigSnapshot = JSON.stringify([
    { type: 'text', text: Array.from({ length: 100 }, (_, i) => `  link "item ${i}"`).join('\n') },
  ]);

  const withResult = () =>
    reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c1',
        name: 'mcp_browser_browser_navigate',
        result: bigSnapshot,
        err: '',
        durationMs: 8221,
      },
    });

  it('starts collapsed with an expand hint and no JSON envelope', () => {
    const last = withResult().transcript.at(-1);
    expect(last?.collapsible).toBe(true);
    expect(last?.expanded).toBeUndefined();
    expect(strip(last?.text ?? '')).toContain('click or Ctrl-O to expand');
    expect(strip(last?.text ?? '')).not.toContain('"type"');
    // Collapsed preview is far shorter than the retained full body.
    expect(last?.text.length).toBeLessThan((last?.fullText ?? '').length);
  });

  it('Ctrl-O expands in place (OpenTUI) without appending a second entry', () => {
    const expanded = reducer(withResult(), { type: 'expand-tool-output' });
    expect(expanded.transcript).toHaveLength(1);
    expect(expanded.transcript[0]?.expanded).toBe(true);
    expect(strip(expanded.transcript[0]?.fullText ?? '')).toContain('link "item 99"');

    // A second Ctrl-O is a no-op — nothing left collapsed.
    const again = reducer(expanded, { type: 'expand-tool-output' });
    expect(again.transcript).toHaveLength(1);
    expect(again.transcript[0]?.expanded).toBe(true);
  });

  it('expand is a no-op when nothing is collapsible', () => {
    const out = reducer(seed(), { type: 'expand-tool-output' });
    expect(out.transcript).toHaveLength(0);
  });

  it('short results are not collapsible', () => {
    const out = reducer(seed(), {
      type: 'agent-event',
      event: {
        type: 'tool-result',
        id: 'c2',
        name: 'file_read',
        result: 'small body\nthree lines\nonly',
        err: '',
        durationMs: 5,
      },
    });
    expect(out.transcript.at(-1)?.collapsible).toBeUndefined();
  });
});

describe('formatCompactEvent', () => {
  it('renders a single Claude/Grok-style line with token delta', () => {
    const text = formatCompactEvent({
      type: 'compact',
      summary: 'Context compacted',
      tokensBefore: 9423,
      tokensAfter: 9393,
      memoryItems: 0,
    });
    expect(text).toBe('Context compacted · ~9423 → ~9393 tokens');
    expect(text).not.toContain('memory');
    expect(text).not.toContain('\n');
    expect(text).not.toContain('triggered');
    expect(text).not.toContain('auto-compacted');
  });

  it('does not dump a long LLM summary body into the transcript', () => {
    const text = formatCompactEvent({
      type: 'compact',
      summary: '## Current objective\n- long prose that used to flood the UI\n'.repeat(20),
      memoryItems: 3,
    });
    expect(text).toBe('Context compacted · 3 memory');
    expect(text).not.toContain('Current objective');
  });

  it('handles nothing to compact', () => {
    expect(formatCompactEvent({ type: 'compact', summary: 'nothing to compact' })).toBe(
      'Nothing to compact',
    );
  });
});
