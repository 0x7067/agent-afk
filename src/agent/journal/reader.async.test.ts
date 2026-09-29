/**
 * Tests for the async journal tool-result reader (reader.async.ts).
 *
 * Verifies that:
 * - findToolResultAsync returns a Promise (async — not sync).
 * - It finds results in a top-level journal.
 * - It finds results across subagent journals, choosing the newest ts.
 * - It handles a multi-MB journal correctly via streaming reads.
 * - Unsafe session ids return null without throwing.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { getSessionJournalPath, getSessionLedgerDir, getSubagentJournalsDir } from '../../paths.js';
import { useTmpAfkHome } from './__test-utils__/helpers.js';
import { findToolResultAsync } from './reader.async.js';

useTmpAfkHome();

/** Build a minimal JSONL record with a tool_result block. */
function toolResultRecord(toolUseId: string, text: string, ts: number, index = 0): string {
  return JSON.stringify({
    v: 1,
    ts,
    kind: 'append',
    index,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId, content: [{ type: 'text', text }] }],
    },
  });
}

/** Build a padding record (plain text block, no tool_result). */
function textRecord(text: string, ts = 1, index = 0): string {
  return JSON.stringify({
    v: 1,
    ts,
    kind: 'append',
    index,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

describe('findToolResultAsync', () => {
  it('returns a Promise (is async, not synchronous)', async () => {
    const result = findToolResultAsync('no-such-session', 'tu-1');
    expect(result).toBeInstanceOf(Promise);
    // Awaiting resolves to null for a missing session.
    expect(await result).toBeNull();
  });

  it('finds a result in the top-level journal', async () => {
    const sessionId = 'async-top';
    fs.mkdirSync(getSessionLedgerDir(sessionId), { recursive: true });
    fs.writeFileSync(
      getSessionJournalPath(sessionId),
      toolResultRecord('tu-top', 'top output', 1000) + '\n',
    );

    const found = await findToolResultAsync(sessionId, 'tu-top');
    expect(found).not.toBeNull();
    expect(found?.subagentId).toBeUndefined();
    expect(found?.block.content).toEqual([{ type: 'text', text: 'top output' }]);
  });

  it('finds a result in a subagent journal', async () => {
    const sessionId = 'async-sub';
    fs.mkdirSync(getSubagentJournalsDir(sessionId), { recursive: true });
    fs.writeFileSync(getSessionJournalPath(sessionId), textRecord('go') + '\n');
    fs.writeFileSync(
      `${getSubagentJournalsDir(sessionId)}/child-1.jsonl`,
      toolResultRecord('tu-child', 'child output', 500) + '\n',
    );

    const found = await findToolResultAsync(sessionId, 'tu-child');
    expect(found).not.toBeNull();
    expect(found?.subagentId).toBe('child-1');
    expect(found?.block.content).toEqual([{ type: 'text', text: 'child output' }]);
  });

  it('returns null when the tool_use id is not found', async () => {
    const sessionId = 'async-miss';
    fs.mkdirSync(getSessionLedgerDir(sessionId), { recursive: true });
    fs.writeFileSync(getSessionJournalPath(sessionId), textRecord('hello') + '\n');

    expect(await findToolResultAsync(sessionId, 'tu-missing')).toBeNull();
  });

  it('picks the newest ts across top-level and subagent journals', async () => {
    const sessionId = 'async-newest';
    fs.mkdirSync(getSubagentJournalsDir(sessionId), { recursive: true });
    // Top-level has the same id at ts=1.
    fs.writeFileSync(
      getSessionJournalPath(sessionId),
      toolResultRecord('tu-dup', 'top-old', 1) + '\n',
    );
    // Subagent has newer ts=9.
    fs.writeFileSync(
      `${getSubagentJournalsDir(sessionId)}/kid.jsonl`,
      toolResultRecord('tu-dup', 'child-new', 9) + '\n',
    );

    const found = await findToolResultAsync(sessionId, 'tu-dup');
    expect(found?.subagentId).toBe('kid');
    expect(found?.block.content).toEqual([{ type: 'text', text: 'child-new' }]);
  });

  it('handles a multi-MB journal via streaming reads', async () => {
    const sessionId = 'async-large';
    fs.mkdirSync(getSessionLedgerDir(sessionId), { recursive: true });
    const journalPath = getSessionJournalPath(sessionId);

    // ~2000 lines of ~1030 bytes each = ~2 MB, followed by the target.
    const pad = textRecord('x'.repeat(1000));
    const target = toolResultRecord('tu-big', 'large result', 9999, 0);
    const content = Array.from({ length: 2000 }, () => pad).join('\n') + '\n' + target + '\n';
    fs.writeFileSync(journalPath, content);

    // Confirm the file is genuinely multi-megabyte.
    expect(fs.statSync(journalPath).size).toBeGreaterThan(1_000_000);

    const found = await findToolResultAsync(sessionId, 'tu-big');
    expect(found).not.toBeNull();
    expect(found?.block.content).toEqual([{ type: 'text', text: 'large result' }]);
    expect(found?.subagentId).toBeUndefined();
  });

  it('returns null for unsafe session ids without throwing', async () => {
    expect(await findToolResultAsync('../evil', 'tu-1')).toBeNull();
    expect(await findToolResultAsync('', 'tu-1')).toBeNull();
    expect(await findToolResultAsync('a/b', 'tu-1')).toBeNull();
  });

  it('returns null for an empty or missing tool use id', async () => {
    expect(await findToolResultAsync('any-sess', '')).toBeNull();
  });

  it('returns null for a compacted-away result (not in folded messages) that IS in records', async () => {
    // Async scan reads ALL records (like the sync path), so compacted results ARE found.
    const sessionId = 'async-compact';
    fs.mkdirSync(getSessionLedgerDir(sessionId), { recursive: true });
    // Append a tool_result then truncate it away.
    const records = [
      toolResultRecord('tu-compact', 'compacted output', 100),
      JSON.stringify({ v: 1, ts: 200, kind: 'truncate', length: 0 }),
      textRecord('summary', 300, 0),
    ];
    fs.writeFileSync(getSessionJournalPath(sessionId), records.join('\n') + '\n');

    const found = await findToolResultAsync(sessionId, 'tu-compact');
    expect(found).not.toBeNull();
    expect(found?.block.content).toEqual([{ type: 'text', text: 'compacted output' }]);
  });
});
