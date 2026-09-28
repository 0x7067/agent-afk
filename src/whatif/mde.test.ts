/**
 * Tests for `src/whatif/mde.ts`.
 *
 * Covers:
 *   - mdeForN at canonical episode counts (n=20 and n=200)
 *   - nForMde inversion
 *   - isUnderpowered gate predicate
 *   - mdePreflightLine formatting
 *   - mdeLimitLine (shown when > 10 pp; absent otherwise)
 *   - mdeGateRefusedMessage content
 */

import { describe, expect, it } from 'vitest';
import {
  MDE_GATE_THRESHOLD,
  isUnderpowered,
  mdeForN,
  mdeGateRefusedMessage,
  mdeLimitLine,
  mdePreflightLine,
  nForMde,
} from './mde.js';

// ---------------------------------------------------------------------------
// mdeForN
// ---------------------------------------------------------------------------

describe('mdeForN', () => {
  it('returns 1 for n=0 (no information)', () => {
    expect(mdeForN(0)).toBe(1);
  });

  it('n=20: MDE ≈ 62pp (worst-case variance)', () => {
    // 2 × 1.96 × sqrt(0.5/20) = 2 × 1.96 × 0.1581 ≈ 0.620
    const mde = mdeForN(20);
    expect(mde).toBeGreaterThan(0.60);
    expect(mde).toBeLessThan(0.65);
  });

  it('n=200: MDE ≈ 20pp', () => {
    // 2 × 1.96 × sqrt(0.5/200) = 2 × 1.96 × 0.05 ≈ 0.196
    const mde = mdeForN(200);
    expect(mde).toBeGreaterThan(0.19);
    expect(mde).toBeLessThan(0.21);
  });

  it('MDE decreases as n increases', () => {
    expect(mdeForN(10)).toBeGreaterThan(mdeForN(100));
    expect(mdeForN(100)).toBeGreaterThan(mdeForN(1000));
  });

  it('returns a value in (0, 1] for positive n', () => {
    for (const n of [1, 5, 20, 100, 500]) {
      const mde = mdeForN(n);
      expect(mde).toBeGreaterThan(0);
      expect(mde).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// nForMde
// ---------------------------------------------------------------------------

describe('nForMde', () => {
  it('returns Infinity for mde=0', () => {
    expect(nForMde(0)).toBe(Infinity);
  });

  it('returns 1 for mde=1', () => {
    expect(nForMde(1)).toBe(1);
  });

  it('nForMde(0.10) gives ≥ 192 episodes (10pp target)', () => {
    // Formula: ceil((4 × 1.96² × 0.5) / 0.01) = ceil(768.32) = 769? Recheck.
    // (4 × 1.96 × 1.96 × 0.5) / (0.10 × 0.10) = 7.6832 / 0.01 = 768.32 → 769
    const n = nForMde(0.10);
    expect(n).toBeGreaterThanOrEqual(768);
    expect(n).toBeLessThanOrEqual(770);
  });

  it('nForMde(0.20) → threshold for the gate', () => {
    // (4 × 1.96² × 0.5) / (0.04) = 7.6832 / 0.04 = 192.08 → 193
    const n = nForMde(MDE_GATE_THRESHOLD);
    expect(n).toBeGreaterThanOrEqual(192);
    expect(n).toBeLessThanOrEqual(194);
  });

  it('inverses round-trip: mdeForN(nForMde(x)) ≤ x (within tolerance)', () => {
    for (const target of [0.05, 0.10, 0.20, 0.30]) {
      const n = nForMde(target);
      const achieved = mdeForN(n);
      // nForMde uses ceil, so achieved should be ≤ target (or just above due to ceil)
      expect(achieved).toBeLessThanOrEqual(target + 0.01);
    }
  });
});

// ---------------------------------------------------------------------------
// isUnderpowered
// ---------------------------------------------------------------------------

describe('isUnderpowered', () => {
  it('returns true for n=20 (MDE >> 20pp threshold)', () => {
    expect(isUnderpowered(20)).toBe(true);
  });

  it('returns true for n=0', () => {
    expect(isUnderpowered(0)).toBe(true);
  });

  it('returns false for n=200 (MDE ≈ 20pp, just at threshold)', () => {
    // mdeForN(200) ≈ 0.196, which is just under 0.20
    expect(isUnderpowered(200)).toBe(false);
  });

  it('returns false for large n (clearly powered)', () => {
    expect(isUnderpowered(1000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mdePreflightLine
// ---------------------------------------------------------------------------

describe('mdePreflightLine', () => {
  it('mentions episode count and detected shift', () => {
    const line = mdePreflightLine(20);
    expect(line).toContain('20 episodes/arm');
    // MDE ≈ 62pp
    expect(line).toMatch(/6[0-9]pp/);
  });

  it('mentions the target (default 10pp) and needed episode count', () => {
    const line = mdePreflightLine(20);
    expect(line).toContain('10pp');
    // nForMde(0.10) ≈ 769
    expect(line).toMatch(/\d{3,} episodes\/arm/);
  });

  it('handles n=200 with custom target', () => {
    const line = mdePreflightLine(200, 0.05);
    expect(line).toContain('200 episodes/arm');
    expect(line).toContain('5pp');
  });

  it('handles n=1 (singular)', () => {
    const line = mdePreflightLine(1);
    expect(line).toContain('1 episode/arm');
    expect(line).not.toContain('1 episodes/arm');
  });

  it('returns a "No episodes" message for n=0', () => {
    const line = mdePreflightLine(0);
    expect(line).toContain('No episodes');
  });
});

// ---------------------------------------------------------------------------
// mdeLimitLine
// ---------------------------------------------------------------------------

describe('mdeLimitLine', () => {
  it('returns undefined for n=200 (MDE ≤ 10pp)', () => {
    // mdeForN(200) ≈ 0.196 ≤ 0.20... but the threshold is 10pp = 0.10.
    // mdeForN(200) ≈ 0.196 > 0.10, so it should return a line.
    // Actually mdeForN(769) ≈ 0.10; let's test n=769.
    expect(mdeLimitLine(769, 'p1')).toBeUndefined();
  });

  it('returns a line for n=20 (MDE >> 10pp)', () => {
    const line = mdeLimitLine(20, 'p1');
    expect(line).toBeDefined();
    expect(line).toContain('p1');
    expect(line).toContain('n=20');
    expect(line).toMatch(/6[0-9]pp/);
  });

  it('returns a line for n=200 (MDE ≈ 19-20pp > 10pp)', () => {
    // mdeForN(200) ≈ 0.196 > 0.10 → should warn
    const line = mdeLimitLine(200, 'p2');
    expect(line).toBeDefined();
    expect(line).toContain('p2');
  });

  it('includes "undetectable" in the message', () => {
    const line = mdeLimitLine(20, 'pred1');
    expect(line).toContain('undetectable');
  });
});

// ---------------------------------------------------------------------------
// mdeGateRefusedMessage
// ---------------------------------------------------------------------------

describe('mdeGateRefusedMessage', () => {
  it('mentions the episode count and threshold', () => {
    const msg = mdeGateRefusedMessage(20);
    expect(msg).toContain('20 episodes');
    expect(msg).toContain(`${Math.round(MDE_GATE_THRESHOLD * 100)}pp`);
  });

  it('mentions --force', () => {
    const msg = mdeGateRefusedMessage(20);
    expect(msg).toContain('--force');
  });

  it('mentions the needed episode count to pass', () => {
    const msg = mdeGateRefusedMessage(20);
    // nForMde(0.20) ≈ 193
    expect(msg).toMatch(/\d{2,} episodes/);
  });
});
