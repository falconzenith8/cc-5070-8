import type {
  ActorDef,
  Beat,
  PerformanceState,
  PerfActor,
  Scenario,
  TrackKey,
} from './types';
import { clamp, clamp01, lerpNum, v3 } from './math3d';
import { headPoint } from './stage';
import { occluderCuesFor, type ScenicCue } from './scenarios';
import type { Occluder } from './types';

const actionAt = (a: TrackKey, b: TrackKey, t: number): ActorDef['track'][number]['action'] => {
  // Discrete actions switch at the earlier key; movement interpolates separately.
  return t >= b.t - 1e-9 ? b.action : a.action;
};

const sampleActor = (def: ActorDef, t: number): { x: number; z: number; yaw: number; action: TrackKey['action'] } => {
  const tr = def.track;
  if (t <= tr[0].t) return { x: tr[0].x, z: tr[0].z, yaw: tr[0].yaw, action: tr[0].action };
  const last = tr[tr.length - 1];
  if (t >= last.t) return { x: last.x, z: last.z, yaw: last.yaw, action: last.action };
  for (let i = 1; i < tr.length; i++) {
    const b = tr[i];
    if (t <= b.t) {
      const a = tr[i - 1];
      const span = b.t - a.t;
      const raw = span <= 1e-9 ? 1 : (t - a.t) / span;
      // Ease movement so walks are not perfectly linear, without changing endpoints.
      const u = raw * raw * (3 - 2 * raw);
      // Interpolate yaw along the shortest arc.
      let dy = b.yaw - a.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      return {
        x: lerpNum(a.x, b.x, u),
        z: lerpNum(a.z, b.z, u),
        yaw: a.yaw + dy * u,
        action: actionAt(a, b, t),
      };
    }
  }
  return { x: last.x, z: last.z, yaw: last.yaw, action: last.action };
};

const beatIndexAt = (beats: Beat[], t: number): number => {
  let idx = 0;
  for (let i = 0; i < beats.length; i++) if (t >= beats[i].t - 1e-9) idx = i;
  return idx;
};

/** Per-action dramatic emphasis multiplier applied to beat salience. */
const ACTION_EMPHASIS: Record<TrackKey['action'], number> = {
  speak: 1.12,
  gesture: 1.06,
  react: 1.0,
  walk: 0.94,
  idle: 0.7,
  listen: 0.62,
};

/**
 * Resolves the fixed performance at time t. Pure and deterministic: no camera
 * state enters here, so replaying at the same t always yields the same stage.
 */
export const samplePerformance = (scenario: Scenario, t: number): PerformanceState => {
  const time = clamp(t, 0, scenario.duration);
  const bIdx = beatIndexAt(scenario.beats, time);
  const beat = scenario.beats[bIdx];

  const actors: PerfActor[] = scenario.actors.map((def) => {
    const s = sampleActor(def, time);
    const beatW = beat.weights[def.id] ?? 0.5;
    const salience = clamp01(beatW * ACTION_EMPHASIS[s.action]);
    return {
      id: def.id,
      name: def.name,
      color: def.color,
      height: def.height,
      radius: def.radius,
      pos: v3(s.x, 0, s.z),
      yaw: s.yaw,
      action: s.action,
      salience,
    };
  });

  // Primary = highest current salience. Ties break by id for determinism.
  let primary = actors[0];
  for (const a of actors) {
    if (a.salience > primary.salience + 1e-9) primary = a;
    else if (Math.abs(a.salience - primary.salience) <= 1e-9 && a.id < primary.id) primary = a;
  }

  // Focus point is a salience-weighted centroid of chest/head area.
  let wx = 0;
  let wy = 0;
  let wz = 0;
  let wsum = 0;
  for (const a of actors) {
    const w = Math.max(0.05, a.salience);
    const h = headPoint(a.pos, a.height);
    wx += h.x * w;
    wy += (h.y * 0.85 + a.pos.y * 0.15) * w;
    wz += h.z * w;
    wsum += w;
  }
  const focusPoint = v3(wx / wsum, wy / wsum, wz / wsum);

  let spread = 0;
  for (const a of actors) {
    const d = Math.hypot(a.pos.x - focusPoint.x, a.pos.z - focusPoint.z);
    spread = Math.max(spread, d);
  }

  return {
    scenarioId: scenario.id,
    time,
    actors,
    primaryId: primary.id,
    focusPoint,
    focusSpread: spread,
    beatLabel: beat.label,
    beatIndex: bIdx,
  };
};

/** Shutter occluders at time t, driven purely by fixed authored cues. */
export const movingOccludersAt = (scenarioId: string, t: number): Occluder[] => {
  const cues = occluderCuesFor(scenarioId);
  return cues.map((cue) => cueBox(cue, t));
};

const easeInOut = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

const cueProgress = (cue: ScenicCue, t: number): number => {
  // 0 = open, 1 = fully closed.
  if (t <= cue.closesAt) return 0;
  if (t < cue.fullyClosedAt) return easeInOut((t - cue.closesAt) / (cue.fullyClosedAt - cue.closesAt));
  if (t <= cue.opensAt) return 1;
  if (t < cue.fullyOpenAt) return 1 - easeInOut((t - cue.opensAt) / (cue.fullyOpenAt - cue.opensAt));
  return 0;
};

const cueBox = (cue: ScenicCue, t: number): Occluder => {
  const p = cueProgress(cue, t);
  const min = v3(
    lerpNum(cue.openBox.min[0], cue.closedBox.min[0], p),
    lerpNum(cue.openBox.min[1], cue.closedBox.min[1], p),
    lerpNum(cue.openBox.min[2], cue.closedBox.min[2], p),
  );
  const max = v3(
    lerpNum(cue.openBox.max[0], cue.closedBox.max[0], p),
    lerpNum(cue.openBox.max[1], cue.closedBox.max[1], p),
    lerpNum(cue.openBox.max[2], cue.closedBox.max[2], p),
  );
  return { id: cue.id, label: cue.label, min, max, tone: cue.tone };
};

/** True when at least one scenic piece is fully closed. */
export const shuttersClosedAt = (scenarioId: string, t: number): boolean =>
  occluderCuesFor(scenarioId).some((c) => cueProgress(c, t) >= 0.999);
