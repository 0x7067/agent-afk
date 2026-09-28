import { describe, expect, it } from 'vitest';
import { mdeForN, nForMde, formatPreflightMde, formatPredictionMdeLimit } from './mde.js';

describe('mdeForN', () => {
  it('returns ~0.44 for n=20', () => {
    // (1.96 + 0.8416) * sqrt(0.5 / 20) ≈ 2.8016 * 0.1581 ≈ 0.443
    expect(mdeForN(20)).toBeCloseTo(0.443, 2);
  });

  it('returns ~0.14 for n=200', () => {
    // (1.96 + 0.8416) * sqrt(0.5 / 200) ≈ 2.8016 * 0.0500 ≈ 0.140
    expect(mdeForN(200)).toBeCloseTo(0.140, 2);
  });

  it('returns 1 for n=0', () => {
    expect(mdeForN(0)).toBe(1);
  });

  it('returns 1 for negative n', () => {
    expect(mdeForN(-5)).toBe(1);
  });

  it('decreases as n increases', () => {
    expect(mdeForN(50)).toBeLessThan(mdeForN(20));
    expect(mdeForN(500)).toBeLessThan(mdeForN(200));
  });
});

describe('nForMde', () => {
  it('returns ~393 for 10pp (d=0.10)', () => {
    // ceil(0.5 * 2.8016^2 / 0.01) = ceil(0.5 * 7.849 / 0.01) ≈ ceil(392.5) = 393
    expect(nForMde(0.10)).toBe(393);
  });

  it('returns ~99 for 20pp (d=0.20)', () => {
    // ceil(0.5 * 7.849 / 0.04) = ceil(98.1) = 99
    expect(nForMde(0.20)).toBe(99);
  });

  it('returns Infinity for d=0', () => {
    expect(nForMde(0)).toBe(Infinity);
  });

  it('returns Infinity for negative d', () => {
    expect(nForMde(-0.1)).toBe(Infinity);
  });

  it('is the inverse of mdeForN (round-trip within rounding)', () => {
    const n = nForMde(0.15);
    expect(mdeForN(n)).toBeLessThanOrEqual(0.15);
    // n-1 should not be sufficient (MDE would exceed 0.15)
    expect(mdeForN(n - 1)).toBeGreaterThan(mdeForN(n));
  });
});

describe('formatPreflightMde', () => {
  it('mentions the episode count and ~44pp for n=20', () => {
    const line = formatPreflightMde(20);
    expect(line).toContain('20 episodes/arm');
    // mdeForN(20) ≈ 0.443 → rounds to 44pp
    expect(line).toContain('~44pp');
  });

  it('mentions the episode count and ~14pp for n=200', () => {
    const line = formatPreflightMde(200);
    expect(line).toContain('200 episodes/arm');
    // mdeForN(200) ≈ 0.140 → rounds to 14pp
    expect(line).toContain('~14pp');
  });

  it('includes a "to detect 10pp" clause naming ~393 episodes', () => {
    const line = formatPreflightMde(20);
    expect(line).toContain('to detect 10pp');
    expect(line).toContain('393');
  });
});

describe('formatPredictionMdeLimit', () => {
  it('names the prediction id and the MDE', () => {
    const line = formatPredictionMdeLimit('p1', 20, false);
    expect(line).toContain('p1');
    // mdeForN(20) ≈ 44pp
    expect(line).toContain('~44pp');
    expect(line).toContain('n=20');
  });

  it('includes optimistic note when optimistic=true', () => {
    const line = formatPredictionMdeLimit('p2', 20, true);
    expect(line).toContain('optimistic');
  });

  it('does not include optimistic note when optimistic=false', () => {
    const line = formatPredictionMdeLimit('p2', 20, false);
    expect(line).not.toContain('optimistic');
  });
});
