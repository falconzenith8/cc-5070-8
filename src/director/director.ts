import type {
  CandidateEvaluation,
  DirectorDecision,
  DirectorFrame,
  DirectorWarning,
  OnAirShot,
  PerformanceState,
  RawCandidate,
  Scenario,
  ScoringWeights,
  StageGeometry,
} from './types';
import { v3 } from './math3d';
import { cameraOrientationDeltaDeg, evaluateCandidate, type ScoreContext } from './score';
import { checkCameraGeometry, generateCandidates, safetyCandidate } from './candidates';
import { samplePerformance, movingOccludersAt } from './performance';
import { getScenario } from './scenarios';
import { getStage } from './stage';
import type { Occluder } from './types';
import { SHIPPED_RULE_ASSET_RESULT } from './rules/asset';
import type { RuleLoadResult } from './rules/schema';
import {
  describeCondition,
  evaluateRules,
  inspectCandidateRefs,
  preferenceBonus,
  type RuleEffect,
  type RuleFrameContext,
} from './rules/engine';
import { actorVisibility } from './occlusion';
import type { PolicyRuleSet, RuleAsset, RuleIssue } from './rules/schema';

/**
 * The runnable policy the director consumes. It is derived 1:1 from a versioned
 * rule asset; no switching constant is authored outside the asset.
 */
export interface PolicyConfig {
  id: string;
  label: string;
  description: string;
  minHoldSeconds: number;
  /** Score margin a challenger must beat the incumbent by (hysteresis). */
  switchMargin: number;
  /** Hard override margin: a challenger this much better always wins. */
  interruptMargin: number;
  /** Incumbent score below this for `interruptBelowSeconds` triggers interrupt. */
  interruptBelowScore: number;
  interruptBelowSeconds: number;
  /** Reject any cut whose orientation delta exceeds this (unless interrupting). */
  maxCutDeg: number;
  allowStopDown: boolean;
}

/**
 * Applies authored rule preferences to one evaluated candidate:
 *  - an allow-list ref (or anchor/lens preference) adds a bounded bonus;
 *  - a deny-list ref removes the candidate from the feasible set, with the
 *    rule id recorded so the diagnostics can explain the rejection.
 * Rules never mutate geometry, camera pose or measured features.
 */
const applyRuleOutcome = (ev: CandidateEvaluation, effect: RuleEffect): CandidateEvaluation => {
  const denied = effect.deny.get(ev.id);
  const bonus = preferenceBonus(ev, effect.preferences);
  if (bonus === 0 && !denied) return ev;

  const ruleIds = effect.preferences
    .filter((p) => p.rule.prefer && preferenceBonus(ev, [p]) > 0)
    .map((p) => p.matched.id);
  const scores = { ...ev.scores, total: Math.max(0, Math.min(1, ev.scores.total + bonus)) };
  const out: CandidateEvaluation = { ...ev, scores };
  if (bonus > 0) out.ruleBonus = { amount: bonus, ruleIds };
  if (denied) {
    const names = denied.map((r) => r.label).join('、');
    out.feasible = false;
    out.rejectReason = `被规则「${names}」排除（作者指定的机位黑名单）`;
    out.ruleDeniedBy = denied.map((r) => r.id);
  }
  return out;
};

const policyFromRules = (p: PolicyRuleSet): PolicyConfig => ({
  id: p.id,
  label: p.label,
  description: p.description,
  minHoldSeconds: p.minHoldSeconds,
  switchMargin: p.switchMargin,
  interruptMargin: p.interruptMargin,
  interruptBelowScore: p.interruptBelowScore,
  interruptBelowSeconds: p.interruptBelowSeconds,
  maxCutDeg: p.maxCutDeg,
  allowStopDown: p.allowStopDown,
});

/** The asset the runtime is built from, plus the migration issues it carries. */
export interface LoadedRuleAsset {
  asset: RuleAsset;
  issues: RuleIssue[];
  migrated: boolean;
  sourceVersion: string;
  /** Per-scenario stale candidate reference report, populated on demand. */
  candidateRefIssues: RuleIssue[];
}

/**
 * Builds a runtime asset from any loaded result. The default is the checked-in
 * v2 asset; passing a legacy document runs the same code path the migration CLI
 * uses, so the old show can be exercised end to end.
 */
export const buildRuntimeAsset = (result: RuleLoadResult = SHIPPED_RULE_ASSET_RESULT): LoadedRuleAsset => ({
  asset: result.asset,
  issues: result.issues,
  migrated: result.migrated,
  sourceVersion: result.sourceVersion,
  candidateRefIssues: [],
});

const RUNTIME = buildRuntimeAsset();

export const RULE_ASSET: RuleAsset = RUNTIME.asset;
export const RULE_ASSET_ISSUES: RuleIssue[] = RUNTIME.issues;
export const RULE_ASSET_SOURCE = RUNTIME.sourceVersion;
export const RULE_ASSET_MIGRATED = RUNTIME.migrated;

/** Policies exposed to the UI, in authored order. */
export const POLICIES: PolicyConfig[] = RULE_ASSET.policies.map(policyFromRules);

export const getPolicy = (id: string): PolicyConfig => {
  const p = POLICIES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown policy: ${id}`);
  return p;
};

export const getPolicyRuleSet = (id: string): PolicyRuleSet => {
  const p = RULE_ASSET.policies.find((x) => x.id === id);
  if (!p) throw new Error(`unknown rule set: ${id}`);
  return p;
};

/** Base weights, before per-frame rule bias. */
export const WEIGHTS_BY_POLICY: Record<string, ScoringWeights> = Object.fromEntries(
  RULE_ASSET.policies.map((p) => [p.id, { ...p.weights }]),
);

export interface DirectorOptions {
  scenario: Scenario;
  stage: StageGeometry;
  policy: PolicyConfig;
  /** Policy rule set the switching constants came from. */
  rules: PolicyRuleSet;
  /** Base weights for this policy; rule bias is applied per frame. */
  weights: ScoringWeights;
  aspect: number;
  /** Internal tick used for hold timing (seconds of performance time). */
  tickSeconds: number;
  /**
   * Stale candidate references detected for this scenario. Reported on the
   * frame, never silently ignored.
   */
  candidateRefIssues?: RuleIssue[];
}

export interface DirectorState {
  onAir: OnAirShot | null;
  shotCounter: number;
  switcheCount: number;
  lowScoreFor: number;
  /** Seconds the live shot has been genuinely unusable (target lost/blocked). */
  failFor: number;
  lastFrame: DirectorFrame | null;
  history: DirectorFrame[];
}

export const createDirectorState = (): DirectorState => ({
  onAir: null,
  shotCounter: 0,
  switcheCount: 0,
  lowScoreFor: 0,
  failFor: 0,
  lastFrame: null,
  history: [],
});

const positionDelta = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const occludersAt = (stage: StageGeometry, scenarioId: string, t: number): Occluder[] => [
  ...stage.occluders,
  ...movingOccludersAt(scenarioId, t),
];

const buildShot = (
  state: DirectorState,
  raw: CandidateEvaluation,
  perf: PerformanceState,
  role: OnAirShot['role'],
  reason: string,
): OnAirShot => {
  state.shotCounter += 1;
  const target = perf.actors.find((a) => a.id === raw.frameTarget) ?? perf.actors.find((a) => a.id === perf.primaryId);
  const names = raw.targets
    .map((id) => perf.actors.find((a) => a.id === id)?.name)
    .filter((n): n is string => Boolean(n));
  const isMulti = raw.anchor === 'group' || raw.anchor === 'two-shot';
  return {
    shotId: state.shotCounter,
    label: raw.label,
    sourceCandidateId: raw.id,
    targetActor: raw.anchor === 'safety' ? 'group' : raw.frameTarget || (raw.anchor === 'group' ? 'group' : perf.primaryId),
    targetName:
      raw.anchor === 'safety'
        ? '全场广角'
        : isMulti
          ? names.join(' + ') || '全体'
          : (target?.name ?? perf.primaryId),
    targetIds: raw.targets.length > 0 ? [...raw.targets] : perf.actors.map((a) => a.id),
    anchorKind: raw.anchor,
    pos: v3(raw.cam.pos.x, raw.cam.pos.y, raw.cam.pos.z),
    aim: v3(raw.cam.aim.x, raw.cam.aim.y, raw.cam.aim.z),
    fov: raw.cam.fov,
    lens: raw.lens,
    startedAt: perf.time,
    role,
    selectionReason: reason,
  };
};

const reasonForCandidate = (c: CandidateEvaluation, perf: PerformanceState): string => {
  const primary = perf.actors.find((a) => a.id === perf.primaryId);
  const bits: string[] = [];
  if (c.anchor === 'safety') bits.push('安全广角兜底');
  else if (c.anchor === 'group') bits.push('多人全景，保持整体空间关系');
  else if (c.anchor === 'two-shot') bits.push('双人同框，保住对话关系');
  else if (c.frameTarget === perf.primaryId) bits.push(`对准主目标 ${primary?.name ?? ''}`);
  else {
    // Name the subject, not a cause: this shot may still win while the primary
    // is perfectly shootable (e.g. a rule prefers the partner), and claiming
    // "primary unavailable" there would be a false account of the decision.
    const name = perf.actors.find((a) => a.id === c.frameTarget)?.name ?? c.frameTarget;
    bits.push(`对准次目标 ${name}`);
  }
  bits.push(
    `可见性 ${(c.scores.visibility * 100).toFixed(0)} / 构图 ${(c.scores.composition * 100).toFixed(
      0,
    )} / 可保持 ${(c.scores.duration * 100).toFixed(0)}`,
  );
  return bits.join('；');
};

export interface DirectorTickInput {
  time: number;
  step: number;
}

/**
 * Advances the director one tick. The incumbent keeps the air unless a
 * challenger clears the policy hysteresis and orientation gate, or the shot
 * has genuinely failed (primary lost / below floor) for the configured grace
 * period. With no feasible candidate the doc says what happens and why.
 */
export const tickDirector = (
  state: DirectorState,
  opts: DirectorOptions,
  input: DirectorTickInput,
): DirectorFrame => {
  const { scenario, stage, policy, aspect } = opts;
  const perf = samplePerformance(scenario, input.time);
  const occluders = occludersAt(stage, scenario.id, input.time);
  const occCache = new Map<number, Occluder[]>();
  occCache.set(input.time, occluders);
  const occludersFor = (t: number) => {
    const hit = occCache.get(t);
    if (hit) return hit;
    const v = occludersAt(stage, scenario.id, t);
    occCache.set(t, v);
    return v;
  };
  const perfCache = new Map<number, PerformanceState>();
  perfCache.set(input.time, perf);
  const perfMemo = (t: number) => {
    const hit = perfCache.get(t);
    if (hit) return hit;
    const v = samplePerformance(scenario, t);
    perfCache.set(t, v);
    return v;
  };

  const rawGen = generateCandidates({ scenario, stage, perf, occluders, aspect });
  const rawSafety = safetyCandidate(stage, perf, occluders);

  // Resolve the versioned rules before scoring: weights, authored preferences
  // and deny-lists are inputs to the evaluation, not post-hoc commentary.
  const rawGeometryChecks = rawGen.map((raw) => checkCameraGeometry(raw.cam, stage, perf, occluders));
  const primaryActor = perf.actors.find((a) => a.id === perf.primaryId);
  const primaryVisible = Boolean(
    primaryActor &&
      rawGen.some((raw, i) => {
        if (!rawGeometryChecks[i].valid || !raw.targets.includes(perf.primaryId)) return false;
        const vis = actorVisibility(raw.cam.pos, primaryActor.pos, primaryActor.height, primaryActor.radius, occluders);
        return vis.frac >= 0.2;
      }),
  );
  const ruleFrame: RuleFrameContext = { scenario, perf, primaryVisible };
  const ruleEffect: RuleEffect = evaluateRules(opts.rules, ruleFrame);

  const scoreCtx: ScoreContext = {
    scenario,
    stage,
    perf,
    occluders,
    aspect,
    weights: ruleEffect.weights,
    occludersFor,
    perfMemo,
  };

  const candidates: CandidateEvaluation[] = rawGen.map((raw, i) => {
    const ev = evaluateCandidate(raw, scoreCtx, rawGeometryChecks[i]);
    return applyRuleOutcome(ev, ruleEffect);
  });
  const safetyEval = evaluateCandidate(
    rawSafety,
    scoreCtx,
    checkCameraGeometry(rawSafety.cam, stage, perf, occluders),
  );
  // Include the safety rig in diagnostics, clearly marked.
  const diagnostics: CandidateEvaluation[] = [...candidates, safetyEval];

  const feasible = candidates.filter((c) => c.feasible);
  const best = feasible.length > 0 ? feasible.reduce((a, b) => (b.scores.total > a.scores.total ? b : a)) : null;

  const primary = perf.actors.find((a) => a.id === perf.primaryId);
  const primaryAvailable = feasible.some(
    (c) => c.targets.includes(perf.primaryId) && c.features.primaryVisibility >= 0.2,
  );

  const ruleWarnings: DirectorWarning[] = (opts.candidateRefIssues ?? []).map((issue) => ({
    code: issue.code,
    severity: issue.severity === 'error' ? 'error' : 'warn',
    message: issue.message,
  }));
  const warnings: DirectorWarning[] = [...ruleWarnings];
  const onAir = state.onAir;
  const age = onAir ? perf.time - onAir.startedAt : 0;
  // Leaving a fallback is a recovery, not a re-frame: when the primary is
  // legitimately visible again, go straight to the best shot *of the primary*
  // rather than stopping at a transitional two-shot that will be superseded.
  const bestPrimary = feasible.reduce<CandidateEvaluation | null>(
    (a, b) => (b.anchor === 'primary' && b.features.targetVisibility >= 0.4 && (!a || b.scores.total > a.scores.total) ? b : a),
    null,
  );
  const recovery = onAir && onAir.role === 'safety' && primaryAvailable ? bestPrimary : null;
  // Re-score the live shot at its frozen pose. It is NOT permitted to silently
  // re-aim: if the actor walks out, the score must fall honestly.
  const onAirEval = onAir ? evaluateOnAirShot(onAir, scoreCtx, stage, ruleEffect) : null;
  const liveScore = onAirEval ? onAirEval.scores.total : 0;

  let decision: DirectorDecision;
  let nextOnAir = onAir;
  // Evaluation of the candidate we just cut to, so the reported frame matches
  // what the decision was actually based on.
  let nextOnAirEval: CandidateEvaluation | null = onAirEval;

  const keeper = (type: DirectorDecision['type'], reason: string, interruption: string | null = null): DirectorDecision => ({
    type,
    reason,
    cut: false,
    interruption,
    onAirLabel: nextOnAir?.label ?? null,
    bestCandidateId: best?.id ?? null,
    bestScore: best?.scores.total ?? 0,
    liveScore,
  });

  if (!onAir) {
    if (best) {
      const shot = buildShot(state, best, perf, best.anchor === 'primary' ? 'primary' : 'substitute', reasonForCandidate(best, perf));
      nextOnAir = shot;
      nextOnAirEval = best;
      decision = {
        type: 'start',
        reason: `首次上台：${reasonForCandidate(best, perf)}`,
        cut: true,
        interruption: null,
        onAirLabel: shot.label,
        bestCandidateId: best.id,
        bestScore: best.scores.total,
        liveScore: 0,
      };
    } else if (safetyEval.feasible) {
      const shot = buildShot(state, safetyEval, perf, 'safety', '无可行候选，切到安全机位广角兜底');
      nextOnAir = shot;
      nextOnAirEval = safetyEval;
      decision = {
        type: 'fallback-safety',
        reason: `所有生成候选均不可行（${candidates.length} 个全部淘汰），启用安全机位。`,
        cut: true,
        interruption: '启用兜底',
        onAirLabel: shot.label,
        bestCandidateId: safetyEval.id,
        bestScore: safetyEval.scores.total,
        liveScore: 0,
      };
      warnings.push({
        code: 'no-feasible',
        severity: 'error',
        message: '无可行生成候选；已启用安全机位，画面为主目标不可用的真实结果。',
      });
    } else {
      decision = {
        type: 'fallback-black',
        reason: '没有任何合法机位（含安全机位），输出黑场并保持导演运行。',
        cut: false,
        interruption: null,
        onAirLabel: null,
        bestCandidateId: null,
        bestScore: 0,
        liveScore: 0,
      };
      warnings.push({
        code: 'no-camera',
        severity: 'error',
        message: '舞台上没有任何合法机位，已输出黑场。',
      });
    }
  } else {
    // Incumbent still legal and still scoring?
    const incumbentLegal = onAirEval ? onAirEval.geomValid : false;
    // A live shot "fails" only when its own intended target is not framed or
    // is invisible. Losing the *primary* is expected when holding a
    // deliberate reaction shot, so it does not by itself force a cut.
    const incumbentFeasible = onAirEval ? onAirEval.feasible : false;
    const primaryLost =
      onAir.role === 'primary' && onAir.targetActor === perf.primaryId && !primaryAvailable;
    const belowFloor = liveScore < policy.interruptBelowScore;

    state.lowScoreFor = belowFloor ? state.lowScoreFor + opts.tickSeconds : 0;
    const hardFailure = !incumbentLegal || !incumbentFeasible || primaryLost;
    state.failFor = hardFailure ? state.failFor + opts.tickSeconds : 0;
    // Debounce hard failures: a momentary loss is usually a panel edge-crossing,
    // not a reason to cut. The policy's grace period decides.
    const failureSustained = state.failFor >= policy.interruptBelowSeconds;

    // The lattice is regenerated each tick, so an id match does NOT mean the
    // same physical camera: the same cell has moved. Only treat a candidate as
    // "the incumbent" when its pose is essentially the frozen on-air pose.
    const samePose =
      onAirEval !== null &&
      best !== null &&
      best.id === onAir.sourceCandidateId &&
      positionDelta(best.cam.pos, onAirEval.cam.pos) < 0.35 &&
      Math.abs(best.cam.fov - onAirEval.cam.fov) < 0.5;
    const challenger = best && !samePose ? best : null;
    const orientation =
      challenger && onAirEval ? cameraOrientationDeltaDeg(onAirEval.cam, challenger.cam) : challenger ? 0 : 0;
    const gain = challenger ? challenger.scores.total - liveScore : 0;
    const canHold = age < policy.minHoldSeconds;
    // A decisive gain may pre-empt the *normal* switching margin, but never the
    // policy's own minimum hold: a "reactive" director reacts sooner, it does
    // not stutter 0.3s cuts. Only genuine sustained failure may cut inside the
    // minimum, and that goes through failureSustained.
    const strongOverride =
      challenger !== null &&
      gain >= policy.interruptMargin &&
      orientation <= policy.maxCutDeg &&
      !canHold;

    // Leaving the safety rig is a recovery, not a routine re-frame. Demand the
    // same decisive margin as a forced cut: otherwise the director flaps off the
    // fallback onto a transitional framing that is superseded a moment later.
    // And while the primary is becoming visible again, do not settle for a
    // substitute: wait the moment it takes for a primary shot to be legal.
    // A fixed margin is meaningless at high scores: 1.2 points on a 100-point
    // scale is inside the lattice's own sampling noise, which turns the
    // "reactive" policy into a metronome cutting at every minimum hold. Scale
    // the required gain with what is actually on air.
    const switchMarginEffective = Math.max(policy.switchMargin, liveScore * 0.045);
    const safetyExitMargin = policy.interruptMargin;
    const safetyHoldsForPrimary = onAir.role === 'safety' && primaryAvailable;
    const canSwitchNormally =
      !canHold &&
      challenger !== null &&
      gain >= switchMarginEffective &&
      orientation <= policy.maxCutDeg &&
      (onAir.role !== 'safety' ||
        (challenger.anchor === 'primary' && challenger.scores.total > safetyEval.scores.total + safetyExitMargin) ||
        (!safetyHoldsForPrimary && challenger.scores.total > safetyEval.scores.total + safetyExitMargin));
    // A recovered primary is a justified cut even inside the normal hold; the
    // rig is a placeholder, not a shot with a minimum life.
    const canRecover =
      recovery !== null && onAir.role === 'safety' && orientation <= policy.maxCutDeg;
    // Strong override must never pull the rig sideways onto a substitute while
    // the primary is available.
    const strongOverrideAllowed = !(onAir.role === 'safety' && primaryAvailable && challenger?.anchor !== 'primary');
    const mustInterrupt =
      failureSustained ||
      state.lowScoreFor >= policy.interruptBelowSeconds ||
      (strongOverride && strongOverrideAllowed);

    if (canRecover) {
      const shot = buildShot(state, recovery, perf, 'primary', reasonForCandidate(recovery, perf));
      nextOnAir = shot;
      nextOnAirEval = recovery;
      decision = {
        type: 'recover',
        reason: `主目标重新可见，从安全机位恢复到「${recovery.label}」。${reasonForCandidate(recovery, perf)}`,
        cut: true,
        interruption: '主目标恢复',
        onAirLabel: shot.label,
        bestCandidateId: recovery.id,
        bestScore: recovery.scores.total,
        liveScore,
      };
      state.switcheCount += 1;
      state.failFor = 0;
    } else if (mustInterrupt && challenger) {
      const interruption = !incumbentLegal
        ? '当前镜头机位已不合法'
        : !incumbentFeasible
          ? '当前镜头目标不可见'
          : primaryLost
            ? '主目标失去可行性'
            : state.lowScoreFor >= policy.interruptBelowSeconds
              ? '当前镜头分数低于下限'
              : '更优镜头显著领先';
      const shot = buildShot(
        state,
        challenger,
        perf,
        challenger.anchor === 'primary' ? 'primary' : 'substitute',
        reasonForCandidate(challenger, perf),
      );
      nextOnAir = shot;
      nextOnAirEval = challenger;
      decision = {
        type: 'interrupt',
        reason: `${interruption}；强制切到「${challenger.label}」。${reasonForCandidate(challenger, perf)}`,
        cut: true,
        interruption,
        onAirLabel: shot.label,
        bestCandidateId: challenger.id,
        bestScore: challenger.scores.total,
        liveScore,
      };
      state.switcheCount += 1;
      state.failFor = 0;
    } else if (canSwitchNormally && challenger) {
      const shot = buildShot(
        state,
        challenger,
        perf,
        challenger.anchor === 'primary' ? 'primary' : 'substitute',
        reasonForCandidate(challenger, perf),
      );
      nextOnAir = shot;
      nextOnAirEval = challenger;
      decision = {
        type: 'cut',
        reason: `保持 ${age.toFixed(1)}s 后按评分切换：+${(gain * 100).toFixed(1)} 分，${reasonForCandidate(
          challenger,
          perf,
        )}`,
        cut: true,
        interruption: null,
        onAirLabel: shot.label,
        bestCandidateId: challenger.id,
        bestScore: challenger.scores.total,
        liveScore,
      };
      state.switcheCount += 1;
      state.failFor = 0;
    } else if (!challenger && (!incumbentFeasible || primaryLost) && feasible.length === 0 && safetyEval.feasible && failureSustained) {
      const shot = buildShot(state, safetyEval, perf, 'safety', '可行候选耗尽，降级到安全机位');
      nextOnAir = shot;
      nextOnAirEval = safetyEval;
      decision = {
        type: 'fallback-safety',
        reason: `可行候选耗尽（${feasible.length} 个），当前镜头仍不可用；切安全机位。`,
        cut: true,
        interruption: '候选耗尽',
        onAirLabel: shot.label,
        bestCandidateId: safetyEval.id,
        bestScore: safetyEval.scores.total,
        liveScore,
      };
      state.switcheCount += 1;
      warnings.push({
        code: 'candidates-exhausted',
        severity: 'error',
        message: '所有生成候选不可行，已降级到安全机位。',
      });
    } else if (!challenger && hardFailure && !failureSustained) {
      // Still inside the failure grace window: hold and say so. Cutting to
      // black for a single frame would be worse than a brief imperfect shot.
      decision = keeper(
        'hold',
        `当前镜头失效 ${state.failFor.toFixed(2)}s，未达中断宽限 ${policy.interruptBelowSeconds.toFixed(
          2,
        )}s，暂不切换以免抖动`,
        '等待失效确认',
      );
    } else if (!challenger && hardFailure && !safetyEval.feasible) {
      // Genuinely nothing legal: this is the honest black output.
      decision = keeper(
        'fallback-black',
        '可行候选与安全机位都不可用，输出黑场并继续跟踪。',
      );
      nextOnAir = null;
      nextOnAirEval = null;
      state.failFor = 0;
      warnings.push({
        code: 'no-camera-onair',
        severity: 'error',
        message: '无任何可用机位，已切断画面。',
      });
    } else if (hardFailure && !failureSustained && challenger) {
      decision = keeper(
        'hold',
        `当前镜头已失效 ${state.failFor.toFixed(2)}s，未达中断宽限 ${policy.interruptBelowSeconds.toFixed(
          2,
        )}s，暂不切换以免抖动`,
      );
    } else if (canHold) {
      // Say which gate actually held the shot. Claiming "未达切换余量" when the
      // gain plainly exceeds it (but the minimum hold has not elapsed) makes
      // the panel contradict its own numbers.
      const gained = Math.max(0, gain);
      decision = keeper(
        'hold',
        `保持镜头 ${age.toFixed(1)}s / 最短 ${policy.minHoldSeconds}s${
          challenger
            ? gained >= switchMarginEffective
              ? `；挑战者领先 ${(gained * 100).toFixed(1)} 分已超过切换余量 ${(switchMarginEffective * 100).toFixed(1)} 分，但最短保持未满`
              : `；挑战者领先 ${(gained * 100).toFixed(1)} 分，未达切换余量 ${(switchMarginEffective * 100).toFixed(1)} 分`
            : '；无更优候选'
        }`,
      );
    } else if (challenger && orientation > policy.maxCutDeg) {
      decision = keeper('keep-no-alternatives', `更优镜头会带来 ${orientation.toFixed(0)}° 的镜头跳变，超过策略上限`);
    } else if (!challenger) {
      decision = keeper('keep-no-alternatives', '当前镜头仍是最优可行解，无可切换候选');
    } else {
      decision = keeper(
        'hold',
        `候选领先 ${(gain * 100).toFixed(1)} 分，未达策略切换余量 ${(switchMarginEffective * 100).toFixed(
          1,
        )} 分`,
      );
    }
  }

  if (!primaryAvailable) {
    // Distinguish "nothing can see the primary" from "the primary is visible but
    // no candidate is a usable shot of it". Claiming invisibility when the
    // program picture plainly shows the actor would be a lie on the panel.
    // `primaryVisible` is the weight-independent measurement taken above, so
    // this sentence cannot be manufactured by a scoring change.
    const primaryVisibleSomewhere = primaryVisible;
    const name = primary?.name ?? perf.primaryId;
    warnings.push({
      code: 'primary-unavailable',
      severity: onAir ? 'warn' : 'error',
      message: primaryVisibleSomewhere
        ? `主目标 ${name} 在部分机位可见，但没有可行镜头能稳定保持它（构图或保持时长不达标）。`
        : onAir
          ? `主目标 ${name} 在当前所有合法机位下都不可见（或被严重遮挡）。`
          : `主目标 ${name} 不可见且无替位。`,
    });
  }

  // Authored rule trace: which rules matched, and the concrete values that made
  // them match. Rendered in the panel so a shot's stated reason is checkable.
  const ruleTrace = ruleEffect.matched.map((m) => {
    const rule = opts.rules.rules.find((r) => r.id === m.id)!;
    return {
      id: m.id,
      label: m.label,
      priority: m.priority,
      conditions: rule.conditions.map(describeCondition),
    };
  });

  state.onAir = nextOnAir;
  const frame: DirectorFrame = {
    time: perf.time,
    step: input.step,
    perf,
    occluders,
    candidates: diagnostics,
    feasibleCount: feasible.length,
    primaryAvailable,
    onAir: nextOnAir,
    // Report the frozen-pose evaluation the switch logic actually used, not a
    // re-aimed lattice cell that happens to share the id.
    onAirEval: nextOnAirEval,
    decision,
    warnings,
    black: nextOnAir === null,
    shotAge: nextOnAir ? perf.time - nextOnAir.startedAt : 0,
    policyId: policy.id,
    policyLabel: policy.label,
    safety: safetyEval,
    switchesThisRun: state.switcheCount,
    ruleAssetId: RULE_ASSET.assetId,
    ruleAssetVersion: RULE_ASSET.schemaVersion,
    rules: ruleTrace,
    scoringWeights: ruleEffect.weights,
  };

  state.lastFrame = frame;
  return frame;
};

/**
 * Re-scores the shot currently on air from its *frozen* pose. The camera does
 * not re-aim at the moving actor: a real camera on a crane/rail stays put until
 * it cuts, so its live score must degrade honestly as the actor walks away.
 */
export const evaluateOnAirShot = (
  shot: OnAirShot,
  ctx: ScoreContext,
  stage: StageGeometry,
  effect?: RuleEffect,
): CandidateEvaluation => {
  const perf = ctx.perf;
  const target = perf.actors.find((a) => a.id === shot.targetActor);
  // Re-score the exact subject set the shot was chosen for. A two-shot that is
  // later re-tested as a single would score higher than it did at selection,
  // which would make the reported "current score" a fiction.
  const targets = shot.targetIds.length > 0 ? [...shot.targetIds] : target ? [target.id] : perf.actors.map((a) => a.id);
  const raw: RawCandidate = {
    id: shot.sourceCandidateId,
    label: shot.label,
    kind: shot.role === 'safety' ? 'safety' : 'generated',
    anchor: shot.anchorKind,
    cam: { pos: shot.pos, aim: shot.aim, fov: shot.fov },
    targets,
    frameTarget: target ? target.id : '',
    lens: shot.lens,
    azimuthDeg: 0,
    elevationLabel: '',
  };
  const geom = checkCameraGeometry(raw.cam, stage, perf, ctx.occluders);
  const ev = evaluateCandidate(raw, ctx, geom);
  // Challengers are scored after rule adjustments; the incumbent must be too,
  // or the reported live score and the switch margin would use different scales.
  const adjusted = effect ? applyRuleOutcome(ev, effect) : ev;
  // Preserve the original identity/role for display.
  return { ...adjusted, label: shot.label, id: shot.sourceCandidateId };
};

/** Offline convenience for tests/timelines: build an options bundle from ids. */
export const optionsFor = (
  scenarioId: string,
  policyId: string,
  aspect: number,
  tickSeconds: number,
): DirectorOptions => {
  const scenario = getScenario(scenarioId);
  const stage = getStage(scenarioId);
  const policy = getPolicy(policyId);
  const rules = getPolicyRuleSet(policyId);
  return {
    scenario,
    stage,
    policy,
    rules,
    weights: { ...rules.weights },
    aspect,
    tickSeconds,
    // Stale authored candidate refs are scenario-dependent, so they are
    // measured here and reported on every frame of the run.
    candidateRefIssues: inspectCandidateRefs(RULE_ASSET, scenario, stage),
  };
};
