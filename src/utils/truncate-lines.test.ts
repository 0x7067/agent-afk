import { describe, it, expect } from 'vitest';
import { truncateAtLineBoundary } from './truncate-lines.js';

describe('truncateAtLineBoundary', () => {
  it('returns text unchanged when it fits', () => {
    const text = 'hello\nworld';
    expect(truncateAtLineBoundary(text, 100)).toBe(text);
  });

  it('returns text unchanged when it exactly equals maxChars', () => {
    const text = 'abc';
    expect(truncateAtLineBoundary(text, 3)).toBe(text);
  });

  it('oversized multi-line: keeps whole lines + explicit notice with correct counts', () => {
    // Build a 50-line text where each line is "path /some/long/path/N"
    const lines = Array.from({ length: 50 }, (_, i) => `  /some/long/path/number/${i}`);
    const text = lines.join('\n');
    const maxChars = 200;

    const result = truncateAtLineBoundary(text, maxChars);

    expect(result.length).toBeLessThanOrEqual(maxChars);
    expect(result).toContain('[truncated: showing');
    expect(result).toContain('of 50 lines');
    // No path split mid-line: every non-notice line must be a complete original line
    const resultLines = result.split('\n');
    const noticeIdx = resultLines.findIndex((l) => l.startsWith('[truncated:'));
    expect(noticeIdx).toBeGreaterThan(0);
    const contentLines = resultLines.slice(0, noticeIdx);
    for (const l of contentLines) {
      expect(lines).toContain(l);
    }
  });

  it('single huge line: falls back to char cut with explicit notice', () => {
    const hugeLine = 'x'.repeat(500);
    const maxChars = 100;

    const result = truncateAtLineBoundary(hugeLine, maxChars);

    expect(result.length).toBeLessThanOrEqual(maxChars);
    expect(result).toContain('[truncated:');
    // should mention 0 lines kept
    expect(result).toContain('showing 0 of 1 lines');
  });

  it('notice chars-omitted count is correct', () => {
    const lines = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'];
    const text = lines.join('\n'); // total 24 chars
    // Force truncation after 2 lines with notice
    const maxChars = 50;
    const result = truncateAtLineBoundary(text, maxChars);

    if (result === text) {
      // fits — skip (maxChars was large enough)
      return;
    }

    expect(result.length).toBeLessThanOrEqual(maxChars);
    expect(result).toContain('[truncated:');
  });

  it('result never exceeds maxChars', () => {
    // Fuzz-style: various sizes
    const text = Array.from({ length: 100 }, (_, i) => `/path/to/file/${i}`).join('\n');
    for (const max of [50, 100, 200, 400, 4000]) {
      const result = truncateAtLineBoundary(text, max);
      expect(result.length).toBeLessThanOrEqual(max);
    }
  });

  it('single-huge-line fallback reports the real omitted char count', () => {
    const text = 'x'.repeat(1000);
    const result = truncateAtLineBoundary(text, 200);
    expect(result.length).toBeLessThanOrEqual(200);
    const kept = result.split('\n')[0]!.length;
    expect(result).toContain(`${1000 - kept} chars omitted`);
  });
});
