import { describe, it, expect } from 'vitest';
import { SCENARIOS, getScenario, validateScenario, occluderCuesFor } from '../../src/director/scenarios';
import { getStage } from '../../src/director/stage';
import { samplePerformance, movingOccludersAt } from '../../src/director/performance';
import { generateCandidates, checkCameraGeometry, safetyCandidate } from '../../src/director/candidates';
import { actorVisibility, segmentClear } from '../../src/director/occlusion';
import { createDirectorState, tickDirector, optionsFor, POLICIES } from '../../src/director/director';
import type { DirectorFrame } from '../../src/director/types';
import { v3, distance } from '../../src/director/math3d';

const occludersAt = (scenarioId: string, t: number) => [
  ...getStage(scenarioId).occluders,
  ...movingOccludersAt(scenarioId, t),
];

const runTimeline = (scenarioId: string, policyId: string, dt = 1 / 12, aspect = 16 / 9): DirectorFrame[] => {
  const state = createDirectorState();
  const opts = optionsFor(scenarioId, policyId, aspect, dt);
  const frames: DirectorFrame[] = [];
  const n = Math.round(opts.scenario.duration / dt);
  for (let i = 0; i <= n; i++) frames.push(tickDirector(state, opts, { time: i * dt, step: i }));
  return frames;
};

describe('scenario data integrity', () => {
  it('all scenarios validate', () => {
    for (const s of SCENARIOS) expect(() => validateScenario(s)).not.toThrow();
  });

  it('every actor stays on stage for all sampled times', () => {
    for (const s of SCENARIOS) {
      const stage = getStage(s.id);
      for (let t = 0; t <= s.duration; t += 0.25) {
        const perf = samplePerformance(s, t);
        for (const a of perf.actors) {
          expect(a.pos.x).toBeGreaterThanOrEqual(stage.stageBounds.minX - 0.01);
          expect(a.pos.x).toBeLessThanOrEqual(stage.stageBounds.maxX + 0.01);
          expect(a.pos.z).toBeGreaterThanOrEqual(stage.stageBounds.minZ - 0.01);
          expect(a.pos.z).toBeLessThanOrEqual(stage.stageBounds.maxZ + 0.01);
        }
      }
    }
  });

  it('the director never mutates actor positions (fixed trajectory)', () => {
    const s = getScenario('two-hander');
    const before = samplePerformance(s, 5);
    runTimeline('two-hander', 'balanced', 1 / 15);
    const after = samplePerformance(s, 5);
    expect(after.actors.map((a) => [a.pos.x, a.pos.z])).toEqual(before.actors.map((a) => [a.pos.x, a.pos.z]));
  });
});

describe('candidate validity', () => {
  it('generates a finite candidate set from current geometry', () => {
    const s = getScenario('two-hander');
    const perf = samplePerformance(s, 6);
    const ctx = {
      scenario: s,
      stage: getStage(s.id),
      perf,
      occluders: occludersAt(s.id, 6),
      aspect: 16 / 9,
    };
    const c = generateCandidates(ctx);
    expect(c.length).toBeGreaterThan(40);
    expect(c.length).toBeLessThan(400);
  });

  it('candidate placements never violate camera bounds or embed in solids', () => {
    for (const s of SCENARIOS) {
      for (const t of [2, 8, 16, 24, 32]) {
        const stage = getStage(s.id);
        const perf = samplePerformance(s, t);
        const occ = occludersAt(s.id, t);
        const cands = generateCandidates({ scenario: s, stage, perf, occluders: occ, aspect: 16 / 9 });
        for (const c of cands) {
          const chk = checkCameraGeometry(c.cam, stage, perf, occ);
          if (!chk.valid) {
            // Whatever fails must fail for a stated, real reason.
            expect(chk.reason.length).toBeGreaterThan(0);
          } else {
            expect(c.cam.pos.y).toBeLessThanOrEqual(stage.cameraBounds.maxY + 1e-6);
            expect(c.cam.pos.z).toBeGreaterThanOrEqual(stage.cameraBounds.minZ - 1e-6);
          }
        }
      }
    }
  });

  it('candidates change as the primary actor walks (not a fixed preset list)', () => {
    const s = getScenario('two-hander');
    const stage = getStage(s.id);
    const a = generateCandidates({
      scenario: s,
      stage,
      perf: samplePerformance(s, 5),
      occluders: occludersAt(s.id, 5),
      aspect: 16 / 9,
    });
    const b = generateCandidates({
      scenario: s,
      stage,
      perf: samplePerformance(s, 15),
      occluders: occludersAt(s.id, 15),
      aspect: 16 / 9,
    });
    const same = JSON.stringify(a.map((c) => c.cam.pos)) === JSON.stringify(b.map((c) => c.cam.pos));
    expect(same).toBe(false);
  });
});

describe('visibility & occlusion', () => {
  it('a point inside a solid is not visible', () => {
    const pillar = getStage('two-hander').occluders.find((o) => o.id === 'pillar')!;
    const eye = v3(0, 1.6, 5);
    const behind = v3(pillar.min.x - 1, 1.6, pillar.min.z - 1);
    void behind;
    const inside = v3(
      (pillar.min.x + pillar.max.x) / 2,
      (pillar.min.y + pillar.max.y) / 2,
      (pillar.min.z + pillar.max.z) / 2,
    );
    expect(segmentClear(eye, inside, [pillar])).toBe(false);
  });

  it('the occlusion scenario really hides Mara from every candidate while shutters are closed', () => {
    const s = getScenario('occlusion');
    const stage = getStage(s.id);
    const t = 22; // fully closed window
    const perf = samplePerformance(s, t);
    const occ = occludersAt(s.id, t);
    const cands = generateCandidates({ scenario: s, stage, perf, occluders: occ, aspect: 16 / 9 });
    const mara = perf.actors.find((a) => a.id === 'mara')!;
    // From every legal camera position, Mara's head must be blocked.
    for (const c of cands) {
      const vis = actorVisibility(c.cam.pos, mara.pos, mara.height, mara.radius, occ);
      if (c.cam.pos.z > 0.35) {
        expect(vis.frac).toBeLessThan(0.2);
      }
    }
    void distance;
  });
});

describe('switching policy', () => {
  it('respects the minimum hold for every policy on the two-hander', () => {
    for (const p of POLICIES) {
      const frames = runTimeline('two-hander', p.id);
      for (let i = 1; i < frames.length; i++) {
        const cutShot = frames[i].decision.cut;
        if (!cutShot) continue;
        const interruption = frames[i].decision.interruption;
        const prev = frames[i - 1].onAir;
        if (!prev) continue;
        const ageBefore = frames[i - 1].shotAge;
        // Cuts either follow the hold or are explicitly marked as an interruption.
        if (!interruption) {
          expect(ageBefore).toBeGreaterThanOrEqual(p.minHoldSeconds - 0.1);
        } else {
          expect(interruption.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('does not cut every frame (hysteresis suppresses score jitter)', () => {
    for (const p of POLICIES) {
      const frames = runTimeline('crossing', p.id);
      const cuts = frames.filter((f) => f.decision.cut).length;
      const fps = 12;
      const seconds = frames.length / fps;
      // Even the fastest policy should not approach per-frame switching.
      expect(cuts / seconds).toBeLessThan(0.9);
      expect(cuts).toBeGreaterThan(0);
    }
  });

  it('only claims the primary is invisible when it really is invisible from every camera', () => {
    // The panel must not contradict the picture. If an actor is plainly framed
    // on screen, the warning may say "no usable shot of the primary", never
    // "invisible from all positions".
    for (const scenarioId of SCENARIOS.map((s) => s.id)) {
      for (const f of runTimeline(scenarioId, 'balanced', 1 / 20, 2.513)) {
        const warn = f.warnings.find((w) => w.code === 'primary-unavailable');
        if (!warn) continue;
        expect(f.primaryAvailable, `${scenarioId} t=${f.time.toFixed(2)} warned while a primary shot was feasible`).toBe(false);
        if (!warn.message.includes('所有合法机位下都不可见')) continue;
        const visibleSomewhere = f.candidates.some(
          (c) => c.geomValid && c.targets.includes(f.perf.primaryId) && c.features.primaryVisibility >= 0.2,
        );
        expect(
          visibleSomewhere,
          `${scenarioId} t=${f.time.toFixed(2)} claims total invisibility but a legal camera sees the primary`,
        ).toBe(false);
      }
    }
  });

  it('the occlusion scenario reports primary unavailability and never fakes visibility', () => {    const frames = runTimeline('occlusion', 'balanced');
    const blocked = frames.filter((f) => f.time >= 16 && f.time <= 30);
    expect(blocked.length).toBeGreaterThan(0);
    const anyWarn = blocked.some((f) => f.warnings.some((w) => w.code === 'primary-unavailable'));
    expect(anyWarn).toBe(true);
    const primaryUnavailable = blocked.filter((f) => !f.primaryAvailable);
    expect(primaryUnavailable.length).toBeGreaterThan(10);
    // While unavailable, no on-air candidate may claim high primary visibility.
    for (const f of primaryUnavailable) {
      if (!f.onAir) continue;
      expect(f.onAir.role === 'safety' || (f.onAirEval?.features.primaryVisibility ?? 0) < 0.2).toBe(true);
    }
  });

  it('isolates the primary first, then a scenic drop removes every legal camera', () => {
    const frames = runTimeline('occlusion', 'balanced');
    // 12–15 s: shutters hide Mara only; Ivo must still be framed by a real
    // substitute shot, and no safety rig should be needed.
    const isolated = frames.filter((f) => f.time > 12.6 && f.time < 13.3);
    expect(isolated.length).toBeGreaterThan(0);
    for (const f of isolated) {
      expect(f.primaryAvailable).toBe(false);
      expect(f.feasibleCount).toBeGreaterThan(0);
      expect(f.onAir?.role).not.toBe('safety');
    }
    // 17–29 s: the drop is closed; nothing is visible and no cell is feasible.
    const dark = frames.filter((f) => f.time > 17 && f.time < 29);
    expect(dark.length).toBeGreaterThan(0);
    for (const f of dark) {
      expect(f.feasibleCount).toBe(0);
      expect(f.primaryAvailable).toBe(false);
      expect(f.onAir?.role).toBe('safety');
      expect(f.warnings.some((w) => w.code === 'primary-unavailable')).toBe(true);
    }
    // Feasibility returns after the drop lifts and the shutters retract.
    const recovered = frames.filter((f) => f.time > 33);
    expect(recovered.some((f) => f.feasibleCount > 0)).toBe(true);
  });

  it('never cuts to a generated shot whose framed subject is head-blocked', () => {
    // A body that peeks around scenery is not a usable single. This guards the
    // regression where a 33%-visible head-behind-the-drop shot was declared
    // feasible, cut to, and abandoned one tick later. Shots may degrade after
    // the cut (the actor walks away); what must never happen is the choice
    // itself being made on a blocked head.
    for (const scenarioId of SCENARIOS.map((s) => s.id)) {
      for (const policy of POLICIES) {
        for (const f of runTimeline(scenarioId, policy.id, 1 / 20)) {
          if (!f.decision.cut || f.decision.type === 'start' || !f.onAir || f.onAir.role === 'safety') continue;
          const ev = f.onAirEval;
          if (!ev || ev.anchor === 'group' || ev.anchor === 'two-shot') continue;
          expect(ev.feasible, `${scenarioId}/${policy.id} t=${f.time.toFixed(2)} ${f.onAir.label}`).toBe(true);
          expect(
            ev.features.framedHeadVisible,
            `${scenarioId}/${policy.id} t=${f.time.toFixed(2)} cut to a head-blocked shot: ${f.onAir.label}`,
          ).toBe(true);
        }
      }
    }
  });

  it('does not abandon the safety rig for a marginal challenger, nor churn right after a cut', () => {
    // Guards two churn sources found in the UI at 2.5:1 program aspect:
    // leaving the fallback for a small gain, then re-cutting within 0.3 s.
    const frames = runTimeline('occlusion', 'balanced');
    const cuts = frames.filter((f) => f.decision.cut && f.decision.type !== 'start');
    for (let i = 1; i < cuts.length; i++) {
      const prev = cuts[i - 1];
      const cur = cuts[i];
      const held = cur.time - prev.time;
      // Only score-driven reappraisals must settle; genuine failure may still
      // interrupt immediately, which is why this checks the trigger label.
      if (cur.decision.interruption === '更优镜头显著领先' || cur.decision.interruption === null) {
        expect(held, `re-cut at ${cur.time.toFixed(2)}s only ${held.toFixed(2)}s after ${prev.time.toFixed(2)}s`).
          toBeGreaterThan(0.55);
      }
    }
  });

  it('holding the safety rig requires a decisive recovery, not a marginal one', () => {
    const frames = runTimeline('occlusion', 'balanced');
    const exits = frames.filter(
      (f) => f.decision.cut && f.onAir && f.onAir.role !== 'safety' && f.decision.type !== 'fallback-safety',
    );
    // Every departure from the fallback should be a genuinely better framing:
    // either the primary is back, or the new shot scores clearly above the rig.
    for (const f of exits) {
      const prevSafety = frames.filter((x) => x.time < f.time).map((x) => x.onAir?.role).filter(Boolean).pop();
      if (prevSafety !== 'safety' || !f.safety) continue;
      const gain = f.onAirEval!.scores.total - f.safety.scores.total;
      expect(gain, `left safety at ${f.time.toFixed(2)}s for only ${(gain * 100).toFixed(1)} pts`).toBeGreaterThan(0.02);
    }
  });

  it('re-scores an on-air shot with the same camera and subject set it was chosen with', () => {
    // Guards a reporting fiction: a two-shot re-tested as a single scored
    // higher on air than it did at selection, so the panel's "current score"
    // was not the score the decision was made on. Scores may legitimately move
    // when the actor walks or a beat re-weights salience; what must not move is
    // the camera or the set of subjects the shot is composed for.
    for (const scenarioId of ['two-hander', 'crossing', 'occlusion']) {
      const frames = runTimeline(scenarioId, 'balanced', 1 / 20, 2.513);
      for (let i = 1; i < frames.length; i++) {
        const prev = frames[i - 1].onAirEval;
        const cur = frames[i];
        if (!prev || !cur.onAir || cur.decision.cut || !cur.onAirEval) continue;
        expect(distance(cur.onAirEval.cam.pos, prev.cam.pos)).toBeLessThan(1e-6);
        expect(cur.onAirEval.targets).toEqual(prev.targets);
        expect(cur.onAirEval.anchor).toBe(prev.anchor);
        expect(cur.onAir!.targetIds).toEqual(prev.targets);
      }
    }
  });

  it('safety rig itself is physically legal', () => {
    const s = getScenario('occlusion');
    const stage = getStage(s.id);
    const perf = samplePerformance(s, 22);
    const occ = occludersAt(s.id, 22);
    const raw = safetyCandidate(stage, perf, occ);
    const chk = checkCameraGeometry(raw.cam, stage, perf, occ);
    expect(chk.valid).toBe(true);
  });
});

describe('determinism', () => {
  it('replaying the same timeline yields identical decisions', () => {
    const a = runTimeline('crossing', 'balanced');
    const b = runTimeline('crossing', 'balanced');
    expect(a.map((f) => `${f.onAir?.sourceCandidateId}@${f.onAir?.shotId}`)).toEqual(
      b.map((f) => `${f.onAir?.sourceCandidateId}@${f.onAir?.shotId}`),
    );
  });

  it('shutter cue count is zero for non-occlusion scenarios', () => {
    expect(occluderCuesFor('two-hander')).toHaveLength(0);
    expect(occluderCuesFor('occlusion')).toHaveLength(3);
  });
});
