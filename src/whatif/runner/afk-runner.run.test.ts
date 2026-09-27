/**
 * Unit tests for accumulateStreamJson — the NDJSON accumulator that turns
 * `afk chat --format stream-json` output into a single text string with
 * tool-call markers, plus cost/token metadata.
 */

import { describe, it, expect } from 'vitest';
import { accumulateStreamJson } from './afk-runner.run.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ndjson(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function contentChunk(content: string) {
  return { type: 'chunk', chunk: { type: 'content', content } };
}

function toolDetailChunk(toolName: string) {
  return { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'tu1', toolName, toolInput: '{}' } };
}

function toolUseChunk(content: string) {
  return { type: 'chunk', chunk: { type: 'tool_use', content } };
}

function doneEvent(opts: { costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number }) {
  return {
    type: 'done',
    metadata: {
      totalCostUsd: opts.costUsd ?? 0,
      durationMs: opts.durationMs,
      usage: { input_tokens: opts.inputTokens ?? 0, output_tokens: opts.outputTokens ?? 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: text accumulation
// ---------------------------------------------------------------------------

describe('accumulateStreamJson — text', () => {
  it('concatenates plain content chunks with no tools', () => {
    const stdout = ndjson([
      contentChunk('Hello '),
      contentChunk('world'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Hello world');
  });

  it('inserts a [tool: name] marker between text segments at a tool boundary', () => {
    const stdout = ndjson([
      contentChunk('Before. '),
      toolDetailChunk('bash'),
      contentChunk(' After.'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Before. [tool: bash] After.');
  });

  it('inserts the marker even when no text follows the tool call', () => {
    const stdout = ndjson([
      contentChunk('Intro.'),
      toolDetailChunk('read_file'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Intro.[tool: read_file]');
  });

  it('handles multiple tool calls with interleaved narration', () => {
    const stdout = ndjson([
      contentChunk('Step 1. '),
      toolDetailChunk('read_file'),
      contentChunk(' Step 2. '),
      toolDetailChunk('bash'),
      contentChunk(' Done.'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Step 1. [tool: read_file] Step 2. [tool: bash] Done.');
  });

  it('uses tool_use summary chunk as fallback when tool_use_detail is absent', () => {
    const stdout = ndjson([
      contentChunk('Before. '),
      toolUseChunk('memory_search'),
      contentChunk(' After.'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Before. [tool: memory_search] After.');
  });

  it('skips malformed lines without throwing', () => {
    const raw = 'not-json\n' + JSON.stringify(contentChunk('ok')) + '\n' + JSON.stringify(doneEvent({})) + '\n';
    const { text } = accumulateStreamJson(raw);
    expect(text).toBe('ok');
  });

  it('returns empty text for empty stdout', () => {
    const { text } = accumulateStreamJson('');
    expect(text).toBe('');
  });

  it('returns empty text when only a done event is present', () => {
    const stdout = ndjson([doneEvent({ costUsd: 0.01 })]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('');
  });

  it('does not duplicate a tool marker if two tool_use_detail chunks arrive back-to-back', () => {
    // Two tool_use_detail chunks for the same call (e.g. pending then final)
    const stdout = ndjson([
      contentChunk('A '),
      toolDetailChunk('bash'),
      toolDetailChunk('bash'),
      contentChunk(' B'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    // Only one marker should appear (second overwrites pending)
    expect(text).toBe('A [tool: bash] B');
  });
});

// ---------------------------------------------------------------------------
// Tests: metadata extraction
// ---------------------------------------------------------------------------

describe('accumulateStreamJson — metadata', () => {
  it('extracts costUsd, inputTokens, outputTokens from done event', () => {
    const stdout = ndjson([
      contentChunk('hi'),
      doneEvent({ costUsd: 0.05, inputTokens: 200, outputTokens: 80, durationMs: 1200 }),
    ]);
    const { meta } = accumulateStreamJson(stdout);
    expect(meta.costUsd).toBe(0.05);
    expect(meta.inputTokens).toBe(200);
    expect(meta.outputTokens).toBe(80);
    expect(meta.durationMs).toBe(1200);
  });

  it('returns zero meta when done event is absent', () => {
    const stdout = ndjson([contentChunk('text')]);
    const { meta } = accumulateStreamJson(stdout);
    expect(meta.costUsd).toBe(0);
    expect(meta.inputTokens).toBe(0);
    expect(meta.outputTokens).toBe(0);
    expect(meta.durationMs).toBeUndefined();
  });

  it('returns zero cost when totalCostUsd is missing from metadata', () => {
    const stdout = ndjson([
      contentChunk('hi'),
      { type: 'done', metadata: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const { meta } = accumulateStreamJson(stdout);
    expect(meta.costUsd).toBe(0);
    expect(meta.inputTokens).toBe(10);
    expect(meta.outputTokens).toBe(5);
  });
});
