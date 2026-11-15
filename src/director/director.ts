import type {
  CandidateEvaluation,
  DirectorDecision,
  DirectorFrame,
  DirectorWarning,
  OnAirShot,
  PerformanceState,
  RawCandidate,
  Scenario,
  StageGeometry,
} from './types';
import { v3 } from './math3d';
import { cameraOrientationDeltaDeg, DEFAULT_WEIGHTS, evaluateCandidate, type ScoringWeights, type ScoreContext } from './score';
import { checkCameraGeometry, generateCandidates, safetyCandidate } from './candidates';
import { samplePerformance, movingOccludersAt } from './performance';
import { getScenario } from './scenarios';
import { getStage } from './stage';
import type { Occluder } from './types';

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

export const POLICIES: PolicyConfig[] = [
  {
    id: 'balanced',
    label: '平衡导演',
    description: '可见性、构图与可保持时长均衡；最短保持 2.6s，默认演出策略。',
    minHoldSeconds: 2.6,
    switchMargin: 0.03,
    interruptMargin: 0.18,
    interruptBelowScore: 0.24,
    interruptBelowSeconds: 0.6,
    maxCutDeg: 95,
    allowStopDown: true,
  },
  {
    id: 'patient',
    label: '长镜头导演',
    description: '偏好长镜头，最短保持 5s、切点更保守，适合稳定叙事。',
    minHoldSeconds: 5.0,
    switchMargin: 0.075,
    interruptMargin: 0.26,
    interruptBelowScore: 0.2,
    interruptBelowSeconds: 1.0,
    maxCutDeg: 80,
    allowStopDown: true,
  },
  {
    id: 'reactive',
    label: '快切导演',
    description: '紧跟动作重点，最短保持 1.1s、切换阈值更低，会产生更多剪切。',
    minHoldSeconds: 1.1,
    switchMargin: 0.012,
    interruptMargin: 0.1,
    interruptBelowScore: 0.3,
    interruptBelowSeconds: 0.35,
    maxCutDeg: 130,
    allowStopDown: true,
  },
  {
    id: 'strict',
    label: '严格构图',
    description: '更重视构图质量与画面稳定，违反构图即降级；最短保持 3.4s。',
    minHoldSeconds: 3.4,
    switchMargin: 0.05,
    interruptMargin: 0.2,
    interruptBelowScore: 0.32,
    interruptBelowSeconds: 0.5,
    maxCutDeg: 90,
    allowStopDown: false,
  },
];

export const getPolicy = (id: string): PolicyConfig => {
  const p = POLICIES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown policy: ${id}`);
  return p;
};

export const WEIGHTS_BY_POLICY: Record<string, ScoringWeights> = {
  balanced: DEFAULT_WEIGHTS,
  patient: { visibility: 0.46, composition: 0.3, duration: 0.24 },
  reactive: { visibility: 0.56, composition: 0.29, duration: 0.15 },
  strict: { visibility: 0.44, composition: 0.44, duration: 0.12 },
};

export interface DirectorOptions {
  scenario: Scenario;
  stage: StageGeometry;
  policy: PolicyConfig;
  weights: ScoringWeights;
  aspect: number;
  /** Internal tick used for hold timing (seconds of performance time). */
  tickSeconds: number;
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
    const name = perf.actors.find((a) => a.id === c.frameTarget)?.name ?? c.frameTarget;
    bits.push(`主目标不可用，转向次目标 ${name}`);
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
  const { scenario, stage, policy, weights, aspect } = opts;
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

  const scoreCtx: ScoreContext = {
    scenario,
    stage,
    perf,
    occluders,
    aspect,
    weights,
    occludersFor,
    perfMemo,
  };

  const candidates: CandidateEvaluation[] = rawGen.map((raw) =>
    evaluateCandidate(raw, scoreCtx, checkCameraGeometry(raw.cam, stage, perf, occluders)),
  );
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

  const warnings: DirectorWarning[] = [];
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
  const onAirEval = onAir ? evaluateOnAirShot(onAir, scoreCtx, stage) : null;
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
      decision = keeper(
        'hold',
        `保持镜头 ${age.toFixed(1)}s / 最短 ${policy.minHoldSeconds}s${
          challenger ? `；挑战者领先 ${(gain * 100).toFixed(1)} 分，未达切换余量 ${(switchMarginEffective * 100).toFixed(1)} 分` : '；无更优候选'
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
    const primaryVisibleSomewhere = candidates.some(
      (c) => c.geomValid && c.targets.includes(perf.primaryId) && c.features.primaryVisibility >= 0.2,
    );
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
  // Preserve the original identity/role for display.
  return { ...ev, label: shot.label, id: shot.sourceCandidateId };
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
  return {
    scenario,
    stage,
    policy,
    weights: WEIGHTS_BY_POLICY[policyId] ?? DEFAULT_WEIGHTS,
    aspect,
    tickSeconds,
  };
};
