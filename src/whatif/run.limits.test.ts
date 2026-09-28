import { describe, expect, it } from 'vitest';
import { verifyShortfallLimits } from './run.limits.js';
import type { VerifyResult, VerifiedPrediction } from './types.js';

const base: VerifyResult = {
  predictions: [], discovered: [], features: [], episodes: 4, samples: 2,
  judge: { name: 'jev', external: true }, truncatedByBudget: false, failedEpisodes: 0,
};

/** Build a minimal VerifiedPrediction with the given per-arm n. */
function makePred(id: string, n: number): VerifiedPrediction {
  return {
    prediction: {
      id,
      behavior: 'test',
      direction: 'added',
      confidence: 'medium',
      reason: 'test',
      testQuestion: 'Does it?',
      probes: [],
    },
    rates: {
      baseline: 0.5,
      candidate: 0.5,
      delta: 0,
      ci: [-0.1, 0.1],
      n: { baseline: n, candidate: n },
    },
    verdict: 'unclear',
  };
}

describe('verifyShortfallLimits', () => {
  it('is empty for a complete run', () => {
    expect(verifyShortfallLimits(base)).toEqual([]);
  });

  it('names failed episodes, ungraded outputs, and a budget stop', () => {
    const out = verifyShortfallLimits({ ...base, failedEpisodes: 2, judgeFailures: 3, truncatedByBudget: true });
    expect(out).toHaveLength(3);
    expect(out[1]).toContain('3 output(s) could not be graded by the jev judge');
  });

  describe('MDE limits', () => {
    it('adds a limit line when n=20 (MDE ~44pp > 10pp)', () => {
      const out = verifyShortfallLimits({ ...base, predictions: [makePred('p1', 20)] });
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('p1');
      expect(out[0]).toContain('~44pp');
      expect(out[0]).toContain('optimistic');
    });

    it('does NOT add a limit line when n is large enough (n=400, MDE ~10pp ≤ 10pp)', () => {
      // nForMde(0.10) = 393, so n=400 gives MDE < 10pp — no warning
      const out = verifyShortfallLimits({ ...base, predictions: [makePred('p1', 400)] });
      expect(out).toHaveLength(0);
    });

    it('uses min(n.baseline, n.candidate)', () => {
      const vp: VerifiedPrediction = {
        ...makePred('p2', 200),
        rates: {
          ...makePred('p2', 200).rates,
          n: { baseline: 20, candidate: 200 },
        },
      };
      const out = verifyShortfallLimits({ ...base, predictions: [vp] });
      // min(20, 200) = 20 → MDE ~28pp > 10pp → should warn
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('n=20');
    });

    it('emits one line per prediction above the threshold', () => {
      // n=400 gives MDE ~10pp which is ≤ 10pp → no warning for p3
      const out = verifyShortfallLimits({
        ...base,
        predictions: [makePred('p1', 20), makePred('p2', 20), makePred('p3', 400)],
      });
      // p1 and p2 warn (n=20 → ~44pp > 10pp); p3 does not (n=400 → ~10pp ≤ threshold)
      expect(out).toHaveLength(2);
      expect(out[0]).toContain('p1');
      expect(out[1]).toContain('p2');
    });
  });
});
