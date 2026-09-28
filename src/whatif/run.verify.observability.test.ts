/**
 * Observability in the verify phase (#2409): the predict-time
 * `observable` tag decides `unobservable`, never the episode traces.
 *
 * Fakes only: no model, judge, or subprocess calls.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRun, type VerifyRunInput } from './run.verify.js';
import { scorePrediction, traceKey, type JudgeResults } from './run.verify.scoring.js';
import { buildHeadline } from './report.headline.js';
import type { CalibrationRecord } from './ledger.js';
import type {
  AgentRunner,
  Environment,
  Episode,
  EpisodeTrace,
  Judge,
  JudgeInput,
  JudgeResult,
  Prediction,
  StructuralImpact,
  ToolRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pred(id: string, overrides: Partial<Prediction> = {}): Prediction {
  return {
    id,
    behavior: `behavior ${id}`,
    direction: 'added',
    confidence: 'high',
    reason: 'test',
    testQuestion: `Does the output show ${id}?`,
    probes: ['probe'],
    ...overrides,
  };
}

const probeEpisodes: Episode[] = [
  { id: 's1', source: 'synthetic', prompt: 'probe', targets: 'p1' },
  { id: 'r1', source: 'real', prompt: 'real turn' },
];

/** 40 samples of one episode/arm, each carrying `tools`. */
function samples(ep: string, e: 'baseline' | 'candidate', tools: ToolRequest[] = []): EpisodeTrace[] {
  return Array.from({ length: 40 }, (_, s) => ({
    episodeId: ep, env: e, sample: s, text: 'output', tools,
    costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1,
  }));
}

/** Score `p1` per arm: `score(env)` for every trace. */
function results(traces: EpisodeTrace[], score: (e: 'baseline' | 'candidate') => number): JudgeResults {
  return new Map(traces.map((t) => [traceKey(t), { p1: score(t.env) }]));
}

const writeFile: ToolRequest = { tool: 'write_file', input: {}, verdict: 'recorded' };
const agentCall: ToolRequest = { tool: 'agent', input: { prompt: 'Read LICENSE' }, verdict: 'recorded' };

// ---------------------------------------------------------------------------
// scorePrediction
// ---------------------------------------------------------------------------

describe('scorePrediction: observability is a predict-time tag (#2409)', () => {
  it('an unrelated prediction with write_file intercepted in both arms keeps refuted', () => {
    // "Uses a formal tone" has nothing to do with writing files; the probes
    // happened to end on an intercepted write_file in every sample.
    const traces = [...samples('s1', 'baseline', [writeFile]), ...samples('s1', 'candidate', [writeFile])];
    const vp = scorePrediction(
      pred('p1', { behavior: 'Uses a formal tone', observable: 'decision' }),
      probeEpisodes, traces, results(traces, () => 0),
    );
    expect(vp.verdict).toBe('refuted');
    expect(vp.unobservableReason).toBeUndefined();
  });

  it('an intent-graded "spawns a subagent" decision prediction at ~0.9 in both arms is a real no-change, not unobservable', () => {
    // The #2409 motivating case: both arms requested `agent` and the gate
    // stopped it. With intent grading the judge scores ~0.9 in both arms, so
    // the prediction "strengthened" is correctly refuted (no change).
    const traces = [...samples('s1', 'baseline', [agentCall]), ...samples('s1', 'candidate', [agentCall])];
    const vp = scorePrediction(
      pred('p1', { behavior: 'Honors explicit requests for subagents', direction: 'strengthened', observable: 'decision' }),
      probeEpisodes, traces, results(traces, () => 0.9),
    );
    expect(vp.rates.baseline).toBeCloseTo(0.9);
    expect(vp.rates.candidate).toBeCloseTo(0.9);
    expect(vp.verdict).not.toBe('unobservable');
    expect(vp.verdict).toBe('refuted');
    expect(vp.unobservableReason).toBeUndefined();
  });

  it('a downstream prediction is unobservable even when its rates would confirm it', () => {
    const traces = [...samples('s1', 'baseline'), ...samples('s1', 'candidate')];
    const vp = scorePrediction(
      pred('p1', { observable: 'downstream', observabilityReason: 'the tests must run to completion' }),
      probeEpisodes, traces, results(traces, (e) => (e === 'candidate' ? 1 : 0)),
    );
    expect(vp.verdict).toBe('unobservable');
    expect(vp.unobservableReason).toContain('the tests must run to completion');
    // Rates and scope are still recorded for transparency.
    expect(vp.rates.delta).toBe(1);
    expect(vp.scope?.episodes).toEqual({ baseline: ['s1'], candidate: ['s1'] });
  });

  it('a downstream prediction with no graded probes is still unobservable', () => {
    const vp = scorePrediction(pred('p1', { observable: 'downstream' }), probeEpisodes, [], new Map());
    expect(vp.verdict).toBe('unobservable');
    expect(vp.unobservableReason).toContain('episode boundary');
  });

  it('a prediction with no observable tag defaults to decision and scores normally', () => {
    const traces = [...samples('s1', 'baseline', [agentCall]), ...samples('s1', 'candidate', [agentCall])];
    const confirmed = scorePrediction(pred('p1'), probeEpisodes, traces, results(traces, (e) => (e === 'candidate' ? 1 : 0)));
    expect(confirmed.verdict).toBe('confirmed');
    const refuted = scorePrediction(pred('p1'), probeEpisodes, traces, results(traces, () => 0));
    expect(refuted.verdict).toBe('refuted');
    expect(refuted.unobservableReason).toBeUndefined();
  });

  it('a decision prediction with no graded probes stays unclear', () => {
    const traces = [...samples('r1', 'baseline', [agentCall]), ...samples('r1', 'candidate', [agentCall])];
    const vp = scorePrediction(pred('p1', { observable: 'decision' }), probeEpisodes, traces, results(traces, () => 0));
    expect(vp.verdict).toBe('unclear');
    expect(vp.unobservableReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyRun: accuracy, ledger and headline exclude downstream predictions
// ---------------------------------------------------------------------------

let tmp: string;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-observability-test-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

function env(label: 'baseline' | 'candidate'): Environment {
  return { label, home: `/tmp/${label}`, cwd: '/tmp', launch: { env: {} } };
}

describe('verifyRun: downstream predictions never count (#2409)', () => {
  // p1 (decision): no change on its probe -> refuted.
  // p2 (downstream): 0 -> 1 on its probe, which would confirm if counted.
  const episodes: Episode[] = [
    { id: 's1', source: 'synthetic', prompt: 'probe one', targets: 'p1' },
    { id: 't1', source: 'synthetic', prompt: 'probe two', targets: 'p2' },
  ];
  const predictions = [
    pred('p1', { behavior: 'Asks before acting', observable: 'decision' }),
    pred('p2', { behavior: 'The fix passes its tests', observable: 'downstream', observabilityReason: 'tests must run' }),
  ];
  const runner = {
    name: 'fake',
    run: vi.fn(async (en: Environment, ep: Episode, sample: number): Promise<EpisodeTrace> => ({
      episodeId: ep.id, env: en.label, sample,
      text: en.label === 'candidate' && ep.targets === 'p2' ? 'BEHAVIOR shown' : 'plain answer',
      tools: [], costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1,
    })),
    snapshot: vi.fn(),
  } as unknown as AgentRunner;
  const judge: Judge = {
    name: 'claude',
    external: false,
    grade: vi.fn(async (input: JudgeInput): Promise<JudgeResult> => {
      const out: JudgeResult = {};
      for (const q of input.questions) out[q.id] = input.output.includes('BEHAVIOR') ? 1 : 0;
      return out;
    }),
  };
  function input(): VerifyRunInput {
    return {
      episodes, baseline: env('baseline'), candidate: env('candidate'), predictions,
      structural: {} as StructuralImpact, judge, crossCheckJudge: undefined, runner,
      complete: vi.fn(async () => ({ text: '[]', costUsd: 0 })), analystModel: 'test-model',
      options: {
        samples: 40, concurrency: 8, maxTurns: 1, episodeTimeoutMs: 1000, maxUsdRemaining: 100,
        changeKinds: ['append'], calibrationFile: path.join(tmp, 'ledger.jsonl'),
      },
    };
  }

  it('excludes the downstream prediction from accuracy, the ledger and the headline effect', async () => {
    const { verifyResult } = await verifyRun(input());
    const [vp1, vp2] = verifyResult.predictions;
    expect(vp1!.verdict).toBe('refuted');
    expect(vp2!.verdict).toBe('unobservable');
    expect(vp2!.rates.delta).toBe(1); // measured, but never counted

    // Accuracy: 0 confirmed / 1 refuted. Counting p2 would make it 0.5.
    expect(verifyResult.predictionAccuracy).toBe(0);

    // Ledger: only the decision prediction is recorded.
    const lines = (await fsp.readFile(path.join(tmp, 'ledger.jsonl'), 'utf8')).trim().split('\n');
    const records = lines.map((l) => JSON.parse(l) as CalibrationRecord);
    expect(records.map((r) => r.prediction.id)).toEqual(['p1']);

    // Headline: p2's significant 0 -> 100% shift is never the effect.
    const headline = buildHeadline({
      spec: { title: 't', changes: [] }, structural: {} as StructuralImpact, predictions,
      verify: verifyResult, costUsd: 0, runDir: tmp, limits: [],
    });
    expect(headline).not.toContain('The fix passes its tests');
    expect(headline).toContain('No clear behavioral difference detected');
    expect(headline).toContain('0 confirmed, 1 refuted, 0 unclear, 1 unobservable (of 2 predictions)');
  });
});
