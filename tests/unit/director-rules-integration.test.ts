import { describe, it, expect } from 'vitest';
import {
  buildRuntimeAsset,
  createDirectorState,
  tickDirector,
  optionsFor,
  RULE_ASSET,
  POLICIES,
  type DirectorOptions,
} from '../../src/director/director';
import { migrateLegacyAsset } from '../../src/director/rules/migrate';
import { SCENARIOS } from '../../src/director/scenarios';
import { frameToReplay, type ReplayFrame } from '../../src/director/replay';
import type { DirectorFrame } from '../../src/director/types';

/**
 * Runs a scenario end-to-end and returns every tick plus the serialised replay
 * view. The replay view is what the operator exports, so assertions made on it
 * are assertions about delivered evidence, not internal state.
 */
const runWith = (
  opts: DirectorOptions,
  dt = 1 / 12,
): { frames: DirectorFrame[]; replay: ReplayFrame[] } => {
  const state = createDirectorState();
  const frames: DirectorFrame[] = [];
  const replay: ReplayFrame[] = [];
  const n = Math.round(opts.scenario.duration / dt);
  for (let i = 0; i <= n; i++) {
    const f = tickDirector(state, opts, { time: i * dt, step: i });
    frames.push(f);
    if (i % 2 === 0) replay.push(frameToReplay(f));
  }
  return { frames, replay };
};

const run = (
  scenarioId: string,
  policyId: string,
  dt = 1 / 12,
): { frames: DirectorFrame[]; replay: ReplayFrame[] } =>
  runWith(optionsFor(scenarioId, policyId, 16 / 9, dt), dt);

/**
 * Rebuilds the options from a *legacy* document. Nothing is special-cased for
 * the old show: the same `tickDirector` consumes the migrated rules, which is
 * what proves the old sample actually runs on the new path.
 */
const legacyOptionsFor = (scenarioId: string, policyId: string, dt = 1 / 12): DirectorOptions => {
  const migrated = buildRuntimeAsset(migrateLegacyAsset());
  const base = optionsFor(scenarioId, policyId, 16 / 9, dt);
  const policySet = migrated.asset.policies.find((p) => p.id === policyId)!;
  return {
    ...base,
    policy: {
      ...base.policy,
      minHoldSeconds: policySet.minHoldSeconds,
      switchMargin: policySet.switchMargin,
      interruptMargin: policySet.interruptMargin,
      interruptBelowScore: policySet.interruptBelowScore,
      interruptBelowSeconds: policySet.interruptBelowSeconds,
      maxCutDeg: policySet.maxCutDeg,
      allowStopDown: policySet.allowStopDown,
    },
    rules: policySet,
    weights: { ...policySet.weights },
    candidateRefIssues: [],
  };
};

describe('execution evidence: shots and scores are checkable', () => {
  it('every run reaches the end of the scenario without stalling or throwing', () => {
    for (const scenario of SCENARIOS) {
      for (const policy of POLICIES) {
        const { frames } = run(scenario.id, policy.id, 1 / 10);
        const last = frames[frames.length - 1];
        expect(last.time, `${scenario.id}/${policy.id} did not reach the end`).toBeCloseTo(scenario.duration, 6);
        // The director never stops producing frames, even in the black window.
        expect(frames.length).toBeGreaterThan(scenario.duration * 9);
      }
    }
  });

  it('every cut names the candidate that was scored, and that candidate was feasible when chosen', () => {
    for (const scenario of SCENARIOS) {
      for (const policy of POLICIES) {
        for (const f of run(scenario.id, policy.id, 1 / 12).frames) {
          if (!f.decision.cut || !f.onAirEval) continue;
          // The program shot is exactly the evaluated candidate.
          expect(f.onAir!.pos).toEqual(f.onAirEval.cam.pos);
          expect(f.onAir!.fov).toBe(f.onAirEval.cam.fov);
          // Selection happened on a genuinely feasible shot (safety rig is the
          // only legal exception: it is a fallback and not held to the bar).
          if (f.onAir!.role !== 'safety') {
            expect(
              f.onAirEval.feasible,
              `${scenario.id}/${policy.id} t=${f.time.toFixed(2)} cut to infeasible ${f.onAir!.label}: ${f.onAirEval.rejectReason}`,
            ).toBe(true);
          }
          // The reported best score is at least the selected shot's score.
          expect(f.decision.bestScore + 1e-9).toBeGreaterThanOrEqual(f.onAirEval.scores.total - 1e-9);
        }
      }
    }
  });

  it('reports the score the decision used, not a re-aimed rescore', () => {
    const { frames } = run('two-hander', 'balanced', 1 / 20);
    for (const f of frames) {
      if (!f.onAir || !f.onAirEval) continue;
      expect(f.onAirEval.id).toBe(f.onAir.sourceCandidateId);
      expect(f.onAirEval.label).toBe(f.onAir.label);
      expect(f.onAir.targetIds).toEqual(f.onAirEval.targets);
    }
  });

  it('rule provenance is present and consistent on every frame', () => {
    for (const scenario of SCENARIOS) {
      for (const f of run(scenario.id, 'balanced', 1 / 12).frames) {
        expect(f.ruleAssetId).toBe(RULE_ASSET.assetId);
        expect(f.ruleAssetVersion).toBe(2);
        const w = f.scoringWeights;
        expect(w.visibility + w.composition + w.duration).toBeCloseTo(1, 9);
        // Only rules that are in the shipped asset may appear in the trace.
        const known = new Set(RULE_ASSET.policies.flatMap((p) => p.rules.map((r) => r.id)));
        for (const r of f.rules) expect(known.has(r.id)).toBe(true);
      }
    }
  });

  it('a recorded replay records the shot sequence, scores and matched rules together', () => {
    const { replay } = run('occlusion', 'balanced', 1 / 12);
    for (const frame of replay) {
      expect(frame.weights.visibility + frame.weights.composition + frame.weights.duration).toBeCloseTo(1, 6);
      for (const shot of frame.shots) {
        expect(shot.total).toBeGreaterThanOrEqual(0);
        expect(shot.total).toBeLessThanOrEqual(1);
        // A candidate cannot be both preferred by and denied by a rule.
        if (shot.ruleDeniedBy.length > 0) expect(shot.ruleBonusBy).toHaveLength(0);
      }
      if (frame.onAir) {
        const sel = frame.shots.find((s) => s.id === frame.onAir!.candidateId);
        // Feasibility is a property of the *choice*. It may legitimately decay
        // afterwards as the actor walks away from the frozen camera, so the
        // strict check is only made on the frame the cut happened.
        if (sel && frame.decision.cut && frame.onAir.role !== 'safety') {
          expect(sel.feasible, `cut to infeasible ${sel.id} at ${frame.t}s: ${sel.reject}`).toBe(true);
          expect(sel.total).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never says the primary is unavailable while a primary shot is feasible', () => {
    // The reason text is delivered evidence. A rule may legitimately prefer a
    // partner shot while the lead is perfectly shootable, but then the frame
    // must not blame "primary unavailable".
    for (const scenario of SCENARIOS) {
      for (const policy of POLICIES) {
        for (const f of run(scenario.id, policy.id, 1 / 12).frames) {
          const onAirIsSecondary =
            f.onAir !== null && f.onAir.targetActor !== f.perf.primaryId && f.onAir.role === 'substitute';
          if (!onAirIsSecondary || f.primaryAvailable !== true) continue;
          expect(
            f.decision.reason,
            `${scenario.id}/${policy.id} t=${f.time.toFixed(2)} claims the lead is unavailable`,
          ).not.toContain('主目标不可用');
          expect(f.onAir!.selectionReason).not.toContain('主目标不可用');
        }
      }
    }
  });

  it('every stated reason is backed by the frame it is attached to', () => {
    for (const scenario of SCENARIOS) {
      for (const policy of POLICIES) {
        for (const f of run(scenario.id, policy.id, 1 / 12).frames) {
          const r = f.decision.reason;
          if (!f.decision.cut) {
            // A held shot reports the score its own frozen pose earned.
            if (f.onAir && f.onAirEval) expect(f.decision.liveScore).toBe(f.onAirEval.scores.total);
            continue;
          }
          expect(f.onAir, `${scenario.id}/${policy.id} t=${f.time}: cut with no shot`).not.toBeNull();
          // Either a scored decision, a stated exhaustion count, or a recovery.
          const measurable =
            r.includes('可见性') || r.includes('可行候选耗尽') || r.includes('主目标重新可见');
          expect(measurable, `${scenario.id}/${policy.id} t=${f.time}: unverifiable reason "${r}"`).toBe(true);
          if (r.includes('可行候选耗尽')) {
            expect(f.feasibleCount, `${scenario.id}/${policy.id} t=${f.time}: false exhaustion`).toBe(0);
          }
          // The reported cut pose is exactly the pose that was scored.
          expect(f.onAir!.pos).toEqual(f.onAirEval!.cam.pos);
          expect(f.onAir!.aim).toEqual(f.onAirEval!.cam.aim);
        }
      }
    }
  });

  it('the same trajectory always yields the same shot sequence and reasons', () => {
    const a = run('crossing', 'reactive', 1 / 15);
    const b = run('crossing', 'reactive', 1 / 15);
    expect(a.replay.map((f) => [f.onAir?.candidateId, f.decision.type, f.decision.reason])).toEqual(
      b.replay.map((f) => [f.onAir?.candidateId, f.decision.type, f.decision.reason]),
    );
  });

  it('the legacy show runs to the curtain on the migrated rules, with its gaps reported', () => {
    const migrated = migrateLegacyAsset();
    // The conversion is not a mock: the old document's policies and weights are
    // what the run below uses, and the unsupported tags are still on record.
    expect(migrated.asset.migration?.rulesDropped).toBeGreaterThan(0);
    for (const scenario of SCENARIOS) {
      for (const policy of migrated.asset.policies) {
        const { frames } = runWith(legacyOptionsFor(scenario.id, policy.id, 1 / 10), 1 / 10);
        const last = frames[frames.length - 1];
        expect(
          last.time,
          `legacy ${scenario.id}/${policy.id} did not reach the end`,
        ).toBeCloseTo(scenario.duration, 6);
        // Every frame is still explainable: provenance is the migrated asset and
        // the matched rules are drawn from it, not from the code defaults.
        const known = new Set(policy.rules.map((r) => r.id));
        for (const f of frames) {
          expect(f.ruleAssetVersion).toBe(2);
          for (const r of f.rules) expect(known.has(r.id)).toBe(true);
        }
      }
    }
  });

  it('the occlusion show still walks isolate → fallback → recover with evidence', () => {
    const { frames } = run('occlusion', 'balanced', 1 / 12);
    const roles = frames.map((f) => f.onAir?.role);
    expect(roles).toContain('primary');
    expect(roles).toContain('substitute');
    expect(roles).toContain('safety');
    // While the drop is closed there is no feasible candidate, and the frame
    // says so rather than inventing a shot.
    const dark = frames.filter((f) => f.time > 18 && f.time < 28);
    for (const f of dark) {
      expect(f.feasibleCount).toBe(0);
      expect(f.onAir?.role).toBe('safety');
      expect(f.warnings.some((w) => w.code === 'primary-unavailable')).toBe(true);
    }
    const recovered = frames.filter((f) => f.time > 34);
    expect(recovered.some((f) => f.feasibleCount > 0 && f.onAir?.role === 'primary')).toBe(true);
  });
});
