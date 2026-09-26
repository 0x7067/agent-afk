import { describe, it, expect } from 'vitest';
import { LineClassifier } from './smoke-reveal.lines.js';
import { splitAtHeadingBoundary } from './markdown-stream.heading-hold.js';

const headingText = (c: LineClassifier, chunks: string[]): string =>
  chunks.flatMap((ch) => c.split(ch)).filter((r) => r.heading).map((r) => r.text).join('');

describe('LineClassifier', () => {
  it('splits heading lines from body text and round-trips the chunk', () => {
    const c = new LineClassifier();
    const chunk = 'intro\n## Title here\nbody\n';
    const runs = c.split(chunk);
    expect(runs.map((r) => r.text).join('')).toBe(chunk);
    expect(runs.filter((r) => r.heading).map((r) => r.text)).toEqual(['## Title here\n']);
  });

  it('carries line state across chunk boundaries', () => {
    expect(headingText(new LineClassifier(), ['## The Light', "house Keeper's", ' Visitor\n', 'body'])).toBe(
      "## The Lighthouse Keeper's Visitor\n",
    );
  });

  it('guesses a truncated heading marker, and never treats fenced lines as headings', () => {
    expect(headingText(new LineClassifier(), ['##', ' Title\n'])).toBe('## Title\n');
    expect(headingText(new LineClassifier(), ['```\n# comment\n```\n# Real\n'])).toBe('# Real\n');
  });

  it('does not treat #hashtags as headings', () => {
    expect(headingText(new LineClassifier(), ['#hashtag here\n'])).toBe('');
  });
});

describe('splitAtHeadingBoundary', () => {
  it('splits exactly before the character that completes a heading block', () => {
    expect(splitAtHeadingBoundary('', '## Title\n\nBody')).toEqual({ now: '## Title\n', held: '\nBody' });
    expect(splitAtHeadingBoundary('## Title\n', '\nBody')).toEqual({ now: '', held: '\nBody' });
  });

  it('ignores paragraph boundaries and chunks that complete nothing', () => {
    expect(splitAtHeadingBoundary('', 'Paragraph.\n\nNext')).toBeNull();
    expect(splitAtHeadingBoundary('', '## Title\nstill going')).toBeNull();
  });
});
