/**
 * Regression tests for escape-sequence sanitisation in renderTaskViewHeader.
 *
 * Issue #2445: the subagent `id` and `agentType` strings were interpolated into
 * the terminal header using only width clamping (`.slice(0, 20)`), with no call
 * to `stripEscapeSequences`. A model- or tool-controlled string containing a
 * CSI, OSC-52, or DEC-private-mode sequence reached the alternate screen
 * verbatim.
 *
 * Each test feeds one of three representative sequence families and asserts
 * that no raw ESC byte (0x1B) survives in the rendered header. The palette's
 * own SGR styling is stripped before asserting so only dangerous non-SGR bytes
 * are tested.
 *
 * @module cli/commands/interactive/task-view-escape.test
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Temp AFK_HOME so disk lookups don't touch real ~/.afk
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tv-esc-test-'));
process.env['AFK_HOME'] = tmpDir;

import { describe, it, expect } from 'vitest';
import { renderTaskViewHeader } from './task-view-mode.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SGR pattern: ESC [ <digits/semicolons> m — strip these before asserting. */
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1B\[[0-9;]*m/g;

/**
 * Strip palette SGR codes so the assertion only fails on non-SGR sequences
 * (the dangerous ones sourced from model/subagent-controlled strings).
 */
function stripSgr(s: string): string {
  return s.replace(SGR_RE, '');
}

/** The three representative escape families from the issue. */
const ESCAPE_PAYLOADS: Array<[label: string, payload: string]> = [
  ['CSI DEC private mode (ESC[?1049l)',  '\x1B[?1049l'],
  ['OSC 52 clipboard write',             '\x1B]52;c;dGVzdA==\x07'],
  ['ESC + truncated CSI suffix',         '\x1B[?1049l suffix'],
];

// ---------------------------------------------------------------------------
// Site 1: subagent id
// ---------------------------------------------------------------------------

describe('renderTaskViewHeader – id sanitisation', () => {
  for (const [label, payload] of ESCAPE_PAYLOADS) {
    it(`strips escape sequences from id: ${label}`, () => {
      const header = renderTaskViewHeader(`abc${payload}def`, 'running');
      const bare = stripSgr(header);
      expect(bare).not.toMatch(/\x1B/);
    });
  }

  it('preserves the clean id when no escape sequences are present', () => {
    const header = renderTaskViewHeader('agent-123', 'running');
    const bare = stripSgr(header);
    // The id or its slice should appear in the header text.
    expect(bare).toContain('agent-123');
    expect(bare).not.toMatch(/\x1B/);
  });
});

// ---------------------------------------------------------------------------
// Site 2: agentType
// ---------------------------------------------------------------------------

describe('renderTaskViewHeader – agentType sanitisation', () => {
  for (const [label, payload] of ESCAPE_PAYLOADS) {
    it(`strips escape sequences from agentType: ${label}`, () => {
      const header = renderTaskViewHeader('clean-id', 'running', `evil${payload}type`);
      const bare = stripSgr(header);
      expect(bare).not.toMatch(/\x1B/);
    });
  }

  it('preserves the clean agentType when no escape sequences are present', () => {
    const header = renderTaskViewHeader('clean-id', 'running', 'general-purpose');
    const bare = stripSgr(header);
    expect(bare).toContain('general-purpose');
    expect(bare).not.toMatch(/\x1B/);
  });

  it('omits agentType section entirely when agentType is undefined', () => {
    const header = renderTaskViewHeader('clean-id', 'running', undefined);
    const bare = stripSgr(header);
    expect(bare).not.toContain('type:');
    expect(bare).not.toMatch(/\x1B/);
  });
});
