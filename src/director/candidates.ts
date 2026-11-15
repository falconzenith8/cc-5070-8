import type {
  CameraSpec,
  Occluder,
  PerformanceState,
  PerfActor,
  RawCandidate,
  Scenario,
  StageGeometry,
} from './types';
import type { Vec3 } from './math3d';
import { add, clamp, deg, distance, length, mul, normalize, sub, v3, rad } from './math3d';
import {
  actorVisibility,
  cameraIntersectsSolid,
  distanceToBox,
  insideAnyVolume,
} from './occlusion';

/**
 * Candidate cameras are generated from the *current* stage geometry and actor
 * blockings, on a fixed deterministic lattice of azimuth/elevation/distance
 * around a shot anchor. The same lattice is regenerated every tick, so when
 * actors move the projected framing changes with them. No hand-authored shot
 * list is replayed on a timer.
 */

export const AZIMUTHS_DEG = [-60, -30, 0, 30, 60];
export const ELEVATIONS_DEG = [-12, 8, 26];
/** Distance is a fraction of the distance from the anchor to the stage front. */
export const DISTANCE_FRACTIONS = [2.8, 4.4];

const LENS_FOV: Record<'wide' | 'standard' | 'tight', number> = {
  wide: 58,
  standard: 42,
  tight: 27,
};

interface Anchor {
  id: string;
  label: string;
  kind: 'primary' | 'secondary' | 'two-shot' | 'group';
  point: Vec3;
  targets: string[];
  frameTarget: string;
  fov: number;
  lens: 'wide' | 'standard' | 'tight';
  /** Preferred azimuths relative to the stage front (+z is house). */
  azBias: number[];
}

const actorById = (perf: PerformanceState, id: string): PerfActor | undefined =>
  perf.actors.find((a) => a.id === id);

const topSalience = (perf: PerformanceState, excludeId?: string): PerfActor | undefined => {
  let best: PerfActor | undefined;
  for (const a of perf.actors) {
    if (a.id === excludeId) continue;
    if (!best || a.salience > best.salience + 1e-9) best = a;
  }
  return best;
};

const actorAnchorPoint = (a: PerfActor): Vec3 => v3(a.pos.x, a.pos.y + a.height * 0.72, a.pos.z);

const buildAnchors = (perf: PerformanceState): Anchor[] => {
  const anchors: Anchor[] = [];
  const primary = actorById(perf, perf.primaryId);
  if (primary) {
    anchors.push({
      id: 'primary',
      label: `${primary.name} 单人`,
      kind: 'primary',
      point: actorAnchorPoint(primary),
      targets: [primary.id],
      frameTarget: primary.id,
      fov: LENS_FOV.tight,
      lens: 'tight',
      azBias: [-50, -25, 0, 25, 50],
    });
    const other = topSalience(perf, primary.id);
    if (other) {
      anchors.push({
        id: 'secondary',
        label: `${other.name} 单人`,
        kind: 'secondary',
        point: actorAnchorPoint(other),
        targets: [other.id],
        frameTarget: other.id,
        fov: LENS_FOV.tight,
        lens: 'tight',
        // Aim to keep the primary in the frame edge when possible.
        azBias: [-50, -25, 0, 25, 50],
      });
      // Two-shot: anchor at the midpoint of the two most salient actors.
      const a = actorAnchorPoint(primary);
      const b = actorAnchorPoint(other);
      const mid = v3((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.15, (a.z + b.z) / 2);
      const sep = distance(a, b);
      const fov = sep > 3.4 ? LENS_FOV.wide : sep > 2.1 ? LENS_FOV.standard : LENS_FOV.tight;
      const lens = fov === LENS_FOV.wide ? 'wide' : fov === LENS_FOV.standard ? 'standard' : 'tight';
      anchors.push({
        id: 'two-shot',
        label: `${primary.name} + ${other.name} 双人`,
        kind: 'two-shot',
        point: mid,
        targets: [primary.id, other.id],
        frameTarget: primary.id,
        fov,
        lens,
        azBias: [-50, -25, 0, 25, 50],
      });
    }
  }
  if (perf.actors.length >= 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const a of perf.actors) {
      cx += a.pos.x;
      cy += a.pos.y + a.height * 0.7;
      cz += a.pos.z;
    }
    anchors.push({
      id: 'group',
      label: '三人全景',
      kind: 'group',
      point: v3(cx / perf.actors.length, cy / perf.actors.length, cz / perf.actors.length),
      targets: perf.actors.map((a) => a.id),
      frameTarget: '',
      fov: LENS_FOV.wide,
      lens: 'wide',
      azBias: [-50, -25, 0, 25, 50],
    });
  }
  return anchors;
};

export interface GenerationContext {
  scenario: Scenario;
  stage: StageGeometry;
  perf: PerformanceState;
  occluders: Occluder[];
  aspect: number;
  /** Previous tick's occupancy, used only for hysteresis in scoring. */
}

const clampCameraToBounds = (
  point: Vec3,
  stage: StageGeometry,
): Vec3 => ({
  x: clamp(point.x, stage.cameraBounds.minX, stage.cameraBounds.maxX),
  y: clamp(point.y, stage.cameraBounds.minY, stage.cameraBounds.maxY),
  z: clamp(point.z, stage.cameraBounds.minZ, stage.cameraBounds.maxZ),
});

/** Front-of-house direction used to orient azimuths. Cameras face -z..+z stage. */
const bearing = (from: Vec3, to: Vec3): number => Math.atan2(to.x - from.x, to.z - from.z);

export interface GeneratedCandidate extends RawCandidate {
  azOffsetDeg: number;
  elevationDeg: number;
  distanceM: number;
}

/**
 * Generates the finite lattice of candidates for this tick. Every lattice
 * point is independent of previous choices, so movement genuinely changes the
 * feasible set and the scores.
 */
export const generateCandidates = (ctx: GenerationContext): GeneratedCandidate[] => {
  const { stage, perf } = ctx;
  const anchors = buildAnchors(perf);
  const out: GeneratedCandidate[] = [];
  const frontZ = stage.cameraBounds.maxZ;
  const seen = new Set<string>();

  for (const anchor of anchors) {
    for (const azOffset of anchor.azBias) {
      for (const el of ELEVATIONS_DEG) {
        for (const distFrac of DISTANCE_FRACTIONS) {
          // Distance grows with how far the anchor is from the house front.
          const baseDist = clamp((frontZ - anchor.point.z) * 0.52 + 2.2, 3.0, 9.5);
          const dist = clamp(baseDist * (distFrac / 3.6), 2.6, 10.5);
          const azRad = rad(azOffset);
          // Camera sits on an arc in front of the anchor; +az swings right.
          const dir = v3(Math.sin(azRad), 0, Math.cos(azRad));
          const desired = add(anchor.point, mul(dir, dist));
          desired.y = anchor.point.y + Math.tan(rad(el)) * dist + 0.55;
          const camPos = clampCameraToBounds(desired, stage);
          const key = `${anchor.id}:${azOffset}:${el}:${distFrac}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const cam: CameraSpec = {
            pos: camPos,
            aim: anchor.point,
            fov: anchor.fov,
          };
          out.push({
            id: `gen:${anchor.id}:${azOffset}:${el}:${distFrac}`,
            label: `${anchor.label} · 方位${azOffset > 0 ? '+' : ''}${azOffset}° · 仰角${el > 0 ? '+' : ''}${el}° · ${anchor.lens}`,
            kind: 'generated',
            anchor: anchor.kind,
            cam,
            targets: anchor.targets,
            frameTarget: anchor.frameTarget,
            lens: anchor.lens,
            azimuthDeg: deg(bearing(camPos, anchor.point)),
            elevationLabel: el > 0 ? '俯视' : el < 0 ? '仰视' : '平视',
            azOffsetDeg: azOffset,
            elevationDeg: el,
            distanceM: distance(camPos, anchor.point),
          });
        }
      }
    }
  }
  return out;
};

/** Safety rig: a fixed physical wide camera, used only by fallback policy. */
export const safetyCandidate = (
  stage: StageGeometry,
  perf: PerformanceState,
  occluders: Occluder[],
): RawCandidate => {
  const rig = stage.safetyRig;
  // Aim at the weighted focus point, not at the occluded primary specifically.
  const aim = v3(perf.focusPoint.x, Math.max(1.0, perf.focusPoint.y * 0.82), perf.focusPoint.z);
  const cam: CameraSpec = { pos: v3(rig.x, rig.y, rig.z), aim, fov: rig.fov };
  void occluders;
  return {
    id: 'safety-rig',
    label: `安全机位 · ${stage.safetyRig.fov}° 广角`,
    kind: 'safety',
    anchor: 'safety',
    cam,
    targets: perf.actors.map((a) => a.id),
    frameTarget: '',
    lens: 'wide',
    azimuthDeg: deg(bearing(cam.pos, aim)),
    elevationLabel: '平视',
  };
};

export interface GeometryCheck {
  valid: boolean;
  reason: string;
}

/**
 * Physical validity of a camera placement: inside declared bounds, outside
 * solids and no-camera volumes, not under the floor, and not inside an actor.
 */
export const checkCameraGeometry = (
  cam: CameraSpec,
  stage: StageGeometry,
  perf: PerformanceState,
  occluders: Occluder[],
): GeometryCheck => {
  const p = cam.pos;
  const b = stage.cameraBounds;
  const tol = 1e-6;
  if (
    p.x < b.minX - tol ||
    p.x > b.maxX + tol ||
    p.y < b.minY - tol ||
    p.y > b.maxY + tol ||
    p.z < b.minZ - tol ||
    p.z > b.maxZ + tol
  ) {
    return { valid: false, reason: '机位越出可部署范围' };
  }
  if (p.y < stage.floorY + 0.35) return { valid: false, reason: '机位低于地面安全净空' };
  const vol = insideAnyVolume(p, stage.noCameraVolumes);
  if (vol) return { valid: false, reason: `机位侵入禁区「${vol.label}」` };
  const solid = cameraIntersectsSolid(p, occluders, 0.24);
  if (solid) return { valid: false, reason: `机位嵌入实体「${solid.label}」` };
  for (const a of perf.actors) {
    const horizontal = Math.hypot(p.x - a.pos.x, p.z - a.pos.z);
    const vertical = Math.abs(p.y - (a.pos.y + a.height * 0.5));
    if (horizontal < a.radius + 0.4 && vertical < a.height * 0.6) {
      return { valid: false, reason: `机位侵入演员 ${a.name} 体积` };
    }
  }
  // Must have an unobstructed-ish aim direction to at least be meaningful.
  if (distance(p, cam.aim) < 0.6) return { valid: false, reason: '机位与目标距离过近' };
  if (cam.fov < 10 || cam.fov > 90) return { valid: false, reason: '镜头视场角非法' };
  return { valid: true, reason: '' };
};

/** Helper used by tests and diagnostics: is any camera legally placeable? */
export const countLegalCells = (stage: StageGeometry, occluders: Occluder[]): number => {
  let n = 0;
  const b = stage.cameraBounds;
  for (let x = b.minX; x <= b.maxX; x += 1.0) {
    for (let y = b.minY + 0.4; y <= b.maxY; y += 1.0) {
      for (let z = b.minZ; z <= b.maxZ; z += 1.0) {
        const p = v3(x, y, z);
        if (insideAnyVolume(p, stage.noCameraVolumes)) continue;
        if (cameraIntersectsSolid(p, occluders, 0.24)) continue;
        n++;
      }
    }
  }
  return n;
};

export { actorVisibility, distanceToBox, normalize, sub, length };
