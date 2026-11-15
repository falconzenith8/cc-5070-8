import type {
  CandidateEvaluation,
  CameraSpec,
  CandidateFeatures,
  Occluder,
  PerformanceState,
  PerfActor,
  RawCandidate,
  Scenario,
  StageGeometry,
} from './types';
import type { Vec3 } from './math3d';
import {
  clamp,
  clamp01,
  distance,
  lookAt,
  multiply,
  perspective,
  smoothstep,
  sub,
  v3,
  worldToNdc,
  dot,
  normalize,
} from './math3d';
import { actorVisibility, segmentClear } from './occlusion';

/** Minimum predicted usable hold for a candidate to count as a real alternative. */
export const MIN_FEASIBLE_HOLD = 1.0;

export interface ScoringWeights {
  visibility: number;
  composition: number;
  duration: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  visibility: 0.5,
  composition: 0.32,
  duration: 0.18,
};

const viewProjFor = (cam: CameraSpec, aspect: number) =>
  multiply(perspective(cam.fov, aspect, 0.1, 80), lookAt(cam.pos, cam.aim, v3(0, 1, 0)));

interface ProjectedActor {
  head: { x: number; y: number; behind: boolean };
  feet: { x: number; y: number; behind: boolean };
  heightNdc: number;
  inFrame: boolean;
  headInFrame: boolean;
  visibility: ReturnType<typeof actorVisibility>;
}

const projectActor = (
  vp: ReturnType<typeof viewProjFor>,
  a: PerfActor,
  occluders: Occluder[],
  eye: Vec3,
): ProjectedActor => {
  const headW = v3(a.pos.x, a.pos.y + a.height, a.pos.z);
  const feetW = v3(a.pos.x, a.pos.y, a.pos.z);
  const headN = worldToNdc(vp, headW);
  const feetN = worldToNdc(vp, feetW);
  const heightNdc = headN.behind || feetN.behind ? 0 : Math.abs(headN.y - feetN.y);
  const cx = (headN.x + feetN.x) / 2;
  const cy = (headN.y + feetN.y) / 2;
  const inFrame =
    !headN.behind &&
    !feetN.behind &&
    Math.abs(cx) <= 1.15 &&
    Math.abs(cy) <= 1.15 &&
    heightNdc > 0.02;
  const headInFrame =
    !headN.behind && Math.abs(headN.x) <= 1 && headN.y <= 1 && headN.y >= -1;
  return {
    head: headN,
    feet: feetN,
    heightNdc,
    inFrame,
    headInFrame,
    visibility: actorVisibility(eye, a.pos, a.height, a.radius, occluders),
  };
};

/** Front-facing amount from the actor's yaw: 1 = camera squarely in front. */
const frontality = (a: PerfActor, camPos: Vec3): number => {
  const forward = v3(Math.sin(a.yaw), 0, Math.cos(a.yaw));
  const toCam = normalize(sub(camPos, a.pos));
  const c = dot(forward, toCam);
  // c near 1 = frontal, near -1 = back of head.
  return clamp01((c + 0.1) / 1.1);
};

const gaussian = (x: number, mu: number, sigma: number): number =>
  Math.exp(-((x - mu) * (x - mu)) / (2 * sigma * sigma));

const compositionScoreFor = (
  target: ProjectedActor,
  group: ProjectedActor[],
  isGroup: boolean,
): { score: number; headroom: number; thirdsOffset: number; groupBalance: number } => {
  if (!target.inFrame) {
    return { score: 0, headroom: 0, thirdsOffset: 1, groupBalance: 0 };
  }
  // Shot-size preference: head-to-toe occupies 34%–82% of frame height.
  const h = target.heightNdc / 2; // NDC span is 2; fraction of frame height
  const sizeScore =
    h < 0.16 ? smoothstep(0.05, 0.16, h) * 0.6 :
    h > 0.92 ? clamp01(1 - (h - 0.92) / 0.5) * 0.7 :
    1 - Math.abs(h - 0.55) * 0.55;

  // Headroom: space above the head, ideal 4%–18% of frame height.
  const headNdcY = target.head.y;
  const headroom = clamp01((1 - headNdcY) / 2);
  const headroomScore =
    headroom < 0.02 ? 0.35 :
    headroom < 0.05 ? smoothstep(0.02, 0.05, headroom) :
    headroom <= 0.2 ? 1 :
    headroom <= 0.34 ? 1 - (headroom - 0.2) * 2.2 : 0.45;

  // Horizontal placement near a third or centred; strongly off-axis penalised.
  const x = target.head.x;
  const thirds = Math.max(gaussian(x, -0.34, 0.12), gaussian(x, 0.34, 0.12));
  const centred = gaussian(x, 0, 0.16);
  const placement = Math.max(thirds, centred * 0.92);
  const thirdsOffset = Math.min(Math.abs(x - -0.34), Math.abs(x - 0.34), Math.abs(x));

  // Group balance: all targets framed, decent pairwise separation, no stacking.
  let balance = 1;
  if (isGroup && group.length > 1) {
    const inFrameCount = group.filter((g) => g.inFrame).length;
    balance = inFrameCount / group.length;
    let minSep = Infinity;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!group[i].inFrame || !group[j].inFrame) continue;
        minSep = Math.min(minSep, Math.hypot(group[i].head.x - group[j].head.x, 0));
      }
    }
    if (Number.isFinite(minSep)) balance *= clamp01(minSep / 0.22);
    // Penalise any target outside the safe action area even if others are in.
    const outCount = group.filter((g) => !g.inFrame).length;
    balance *= outCount === 0 ? 1 : 0.35;
  }

  const score = clamp01(sizeScore * 0.34 + headroomScore * 0.24 + placement * 0.22 + balance * 0.2);
  return { score, headroom, thirdsOffset, groupBalance: balance };
};

/**
 * Expected usable hold: how long this exact camera keeps the target visible
 * and comparably framed as the fixed performance advances. Sampled from the
 * scenario timeline, not from camera history — it is a property of the shot.
 */
const expectedHoldSeconds = (
  scenario: Scenario,
  cam: CameraSpec,
  aspect: number,
  targetIds: string[],
  baseHeightFrac: number,
  occludersFor: (t: number) => Occluder[],
  now: number,
  perfMemo: (t: number) => PerformanceState,
): number => {
  if (targetIds.length === 0) return 1.0;
  const probes = [0.8, 2.4];
  const vp = viewProjFor(cam, aspect);
  // Past the end of the show the performance is static, so the shot can be
  // held indefinitely; this is not a failure, it is the curtain.
  if (now >= scenario.duration - 1e-6) return probes[probes.length - 1];
  let hold = 0;
  for (const dt of probes) {
    const t = Math.min(now + dt, scenario.duration);
    const p = perfMemo(t);
    const occ = occludersFor(t);
    let ok = true;
    for (const id of targetIds) {
      const a = p.actors.find((x) => x.id === id);
      if (!a) {
        ok = false;
        break;
      }
      if (!segmentClear(cam.pos, v3(a.pos.x, a.pos.y + a.height * 0.5, a.pos.z), occ)) {
        ok = false;
        break;
      }
      // The hold prediction must use the same visibility rule as feasibility:
      // a head sliding behind a moving drop invalidates the shot even though
      // the body's centre line is still clear.
      const vis = actorVisibility(cam.pos, a.pos, a.height, a.radius, occ);
      if (!vis.headVisible || vis.frac < 0.28) {
        ok = false;
        break;
      }
      const headN = worldToNdc(vp, v3(a.pos.x, a.pos.y + a.height, a.pos.z));
      const feetN = worldToNdc(vp, v3(a.pos.x, a.pos.y, a.pos.z));
      if (headN.behind || feetN.behind) {
        ok = false;
        break;
      }
      const hf = Math.abs(headN.y - feetN.y) / 2;
      const cx = Math.abs((headN.x + feetN.x) / 2);
      const cy = Math.abs((headN.y + feetN.y) / 2);
      if (cx > 1.05 || cy > 1.05 || hf < 0.12 || hf > 1.05) {
        ok = false;
        break;
      }
      if (baseHeightFrac > 0.02 && Math.abs(hf - baseHeightFrac) / baseHeightFrac > 0.75) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    hold = dt;
  }
  return hold;
};

export interface ScoreContext {
  scenario: Scenario;
  stage: StageGeometry;
  perf: PerformanceState;
  occluders: Occluder[];
  aspect: number;
  weights: ScoringWeights;
  occludersFor: (t: number) => Occluder[];
  /** Memoized performance sampler shared across all candidates in a tick. */
  perfMemo: (t: number) => PerformanceState;
}

export const evaluateCandidate = (
  raw: RawCandidate,
  ctx: ScoreContext,
  geom: { valid: boolean; reason: string },
): CandidateEvaluation => {
  const { perf, occluders, aspect } = ctx;
  const vp = viewProjFor(raw.cam, aspect);
  const targets = raw.targets
    .map((id) => perf.actors.find((a) => a.id === id))
    .filter((a): a is PerfActor => Boolean(a));
  const primary = perf.actors.find((a) => a.id === perf.primaryId);

  const projected = new Map<string, ProjectedActor>();
  for (const a of targets) projected.set(a.id, projectActor(vp, a, occluders, raw.cam.pos));
  const primaryProj = primary ? projectActor(vp, primary, occluders, raw.cam.pos) : undefined;
  const primaryVis = primaryProj?.visibility ?? null;

  // Only the actors this shot is *about* count toward its visibility. A shot
  // of an occluded actor must not borrow the global lead's visibility.
  const targetVisAvg =
    targets.length === 0
      ? 0
      : targets.reduce((s, a) => s + (projected.get(a.id)?.visibility.frac ?? 0), 0) / targets.length;

  // Group visibility uses the shot's own targets as well.
  const groupVis = targetVisAvg;

  const primaryVisibility = primaryVis ? primaryVis.frac : 0;
  // Does this shot purport to show the primary? Then the primary must be seen.
  const showsPrimary = Boolean(primary && raw.targets.includes(primary.id));
  const framingPrimaryFactor = showsPrimary ? primaryVisibility : targetVisAvg;

  const frameTarget = raw.frameTarget
    ? projected.get(raw.frameTarget)
    : targets[0]
      ? projected.get(targets[0].id)
      : undefined;
  const group = targets.map((a) => projected.get(a.id)!).filter(Boolean);
  const isGroup = raw.anchor === 'group' || raw.anchor === 'two-shot';

  const comp = frameTarget
    ? compositionScoreFor(frameTarget, group, isGroup)
    : { score: 0, headroom: 0, thirdsOffset: 1, groupBalance: 0 };

  const heightFrac = frameTarget ? frameTarget.heightNdc / 2 : 0;
  const framedHeadVisible = frameTarget?.headInFrame ?? false;

  const faceScores = targets.map((a) => frontality(a, raw.cam.pos));
  const faceScore = faceScores.length === 0 ? 0 : faceScores.reduce((s, x) => s + x, 0) / faceScores.length;

  // A camera behind the subject is geometrically "visible" but dramatically wrong.
  const faceFactor = 0.55 + 0.45 * faceScore;

  // Whose story is this? A clean shot of the chorus must not outrank the lead.
  // The framed subject's current dramatic weight scales its visibility term.
  const maxSalience = perf.actors.reduce((m, a) => Math.max(m, a.salience), 0.001);
  const framed = raw.frameTarget ? perf.actors.find((a) => a.id === raw.frameTarget) : undefined;
  const magnitude =
    raw.anchor === 'group' || raw.anchor === 'two-shot'
      ? targets.reduce((m, a) => Math.max(m, a.salience), 0.001) / maxSalience
      : (framed?.salience ?? maxSalience) / maxSalience;
  const subjectFactor = 0.35 + 0.65 * clamp01(magnitude);
  const salienceFactor = raw.anchor === 'group' || raw.anchor === 'two-shot' ? 0.55 + 0.45 * subjectFactor : subjectFactor;

  // Visibility score is the shot's own subjects' coverage. A camera with no
  // target at all (e.g. a safety wide) falls back to group coverage.
  const visibilityScore =
    raw.targets.length === 0
      ? clamp01(0.45 + groupVis * 0.55)
      : clamp01(targetVisAvg * 0.8 + framingPrimaryFactor * 0.2) * salienceFactor;

  // Duration: usable hold normalised against the maximum probe window (3 s).
  const targetIds = raw.targets.length > 0 ? raw.targets : perf.actors.map((a) => a.id);
  const holdSeconds = expectedHoldSeconds(
    ctx.scenario,
    raw.cam,
    aspect,
    targetIds,
    heightFrac,
    ctx.occludersFor,
    perf.time,
    ctx.perfMemo,
  );
  const durationScore = clamp01(holdSeconds / 3);
  // Prefer shots that can hold: a 0.4 s shot is nearly a cut-away.
  const durationCurve = holdSeconds <= 0.4 ? durationScore * 0.35 : smoothstep(0.3, 2.6, holdSeconds);

  const w = ctx.weights;
  const visibilityTerm = visibilityScore * faceFactor;
  const compositionTerm = comp.score;
  const durationTerm = durationCurve;
  const total = clamp01(
    visibilityTerm * w.visibility + compositionTerm * w.composition + durationTerm * w.duration,
  );

  const primaryHeadVisible = primaryVis ? primaryVis.headVisible : false;
  const targetsHeadInFrame = group.length > 0 && group.every((g) => g.headInFrame);

  const features: CandidateFeatures = {
    primaryVisibility,
    targetVisibility: targetVisAvg,
    groupVisibility: groupVis,
    primaryHeadVisible,
    primaryHeadInFrame: primaryProj ? primaryProj.headInFrame : false,
    framedHeadVisible,
    targetsHeadInFrame,
    screenHeightFrac: heightFrac,
    headroom: comp.headroom,
    thirdsOffset: comp.thirdsOffset,
    groupBalance: comp.groupBalance,
    faceScore,
    holdSeconds,
    panFromOnAirDeg: 0,
  };

  const framedActor = frameTarget ? targets.find((a) => projected.get(a.id) === frameTarget) : undefined;
  let feasible = geom.valid;
  let rejectReason = geom.valid ? '' : geom.reason;

  if (!geom.valid) {
    feasible = false;
  } else if (raw.kind === 'generated') {
    if (showsPrimary && primary && !primaryVis?.headVisible && primaryVisibility < 0.15) {
      feasible = false;
      rejectReason = `主目标 ${primary.name} 头部被「${
        primaryVis?.nearestBlockerId ?? '几何体'
      }」挡住`;
    } else if (!isGroup && frameTarget && !frameTarget.visibility.headVisible) {
      // A single-subject shot whose subject's head is behind scenery is not a
      // usable shot, even if the body samples happen to peek around it.
      feasible = false;
      rejectReason = `出镜目标头部被「${frameTarget.visibility.nearestBlockerId ?? '几何体'}」挡住`;
    } else if (!isGroup && frameTarget && !frameTarget.headInFrame) {
      // Visible but projected outside the frame is not a shot of that subject.
      // Rules may reorder candidates; they must never make an unframed face
      // selectable.
      feasible = false;
      rejectReason = '出镜目标头部落在画面外';
    } else if (targetVisAvg < 0.28) {
      feasible = false;
      rejectReason = '目标可见面积不足';
    } else if (!frameTarget || !frameTarget.inFrame) {
      feasible = false;
      rejectReason = framedActor
        ? `目标 ${framedActor.name} 投影落在画面外`
        : '目标投影落在画面外';
    } else if (heightFrac < 0.055) {
      feasible = false;
      rejectReason = '目标在画面中过小';
    } else if (holdSeconds < MIN_FEASIBLE_HOLD) {
      // Cutting to a shot that dies within a second is churn, not direction.
      feasible = false;
      rejectReason = `可保持时长不足 ${MIN_FEASIBLE_HOLD.toFixed(1)}s（画面即将失效）`;
    } else if (!primary && raw.targets.length > 0) {
      feasible = false;
      rejectReason = '目标不在当前演出中';
    }
  } else {
    // Safety rig is legal whenever its placement is legal; it is a fallback,
    // so it is never held to the same "primary visible" bar.
    if (primary ? primaryVisibility < 0.05 : false) {
      // Legal but visually limited: keep feasible, surface the limitation.
      rejectReason = '安全位可见性有限';
    }
  }

  const summaryBits: string[] = [];
  if (primary) {
    summaryBits.push(`主目标可见 ${(primaryVisibility * 100).toFixed(0)}%`);
  }
  if (raw.anchor === 'group' || raw.anchor === 'two-shot') {
    summaryBits.push(`群体覆盖 ${(comp.groupBalance * 100).toFixed(0)}%`);
  } else {
    summaryBits.push(`身位 ${(heightFrac * 100).toFixed(0)}% 画高`);
  }
  summaryBits.push(`可保持 ${holdSeconds.toFixed(1)}s`);

  return {
    ...raw,
    geomValid: geom.valid,
    geomReason: geom.reason,
    feasible,
    rejectReason,
    scores: {
      visibility: visibilityTerm,
      composition: compositionTerm,
      duration: durationTerm,
      total,
    },
    features,
    summary: summaryBits.join(' · '),
  };
};

export const angularSeparationDeg = (a: Vec3, b: Vec3): number => {
  const da = normalize(a);
  const db = normalize(b);
  const c = clamp(dot(da, db), -1, 1);
  return (Math.acos(c) * 180) / Math.PI;
};

/** Pan/tilt difference between two camera orientations, in degrees. */
export const cameraOrientationDeltaDeg = (a: CameraSpec, b: CameraSpec): number => {
  const va = normalize(sub(a.aim, a.pos));
  const vb = normalize(sub(b.aim, b.pos));
  const angle = angularSeparationDeg(va, vb);
  const fovWeight = Math.abs(a.fov - b.fov) * 0.35;
  return clamp(angle + fovWeight, 0, 180);
};

export const cameraDistanceToTarget = (a: PerfActor, cam: CameraSpec): number =>
  distance(v3(a.pos.x, a.pos.y + a.height * 0.7, a.pos.z), cam.pos);
