import type { BoxVolume, Occluder } from './types';
import type { Vec3 } from './math3d';
import { add, clamp01, dot, length, mul, sub, v3 } from './math3d';

export interface SegmentHit {
  t: number;
  occluderId: string;
}

/**
 * Slab-method ray/AABB intersection over the segment [origin, origin+dir].
 * Returns the nearest entry t in (eps, maxT) or null. Expanding by `pad`
 * prevents grazing contacts from counting as fully blocked.
 */
export const rayAabbEntry = (
  origin: Vec3,
  dir: Vec3,
  min: Vec3,
  max: Vec3,
  maxT: number,
  pad = 0,
): number | null => {
  let tMin = 0;
  let tMax = maxT;
  const lo = [min.x - pad, min.y - pad, min.z - pad];
  const hi = [max.x + pad, max.y + pad, max.z + pad];
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (lo[i] - o[i]) * inv;
    let t2 = (hi[i] - o[i]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax < 1e-6) return null;
  return tMin <= 1e-6 ? 1e-6 : tMin;
};

export const nearestBlocker = (
  origin: Vec3,
  target: Vec3,
  occluders: Occluder[],
  ignoreIds: ReadonlySet<string>,
): SegmentHit | null => {
  const delta = sub(target, origin);
  const dist = length(delta);
  if (dist < 1e-6) return null;
  const dir = mul(delta, 1 / dist);
  let best: SegmentHit | null = null;
  for (const o of occluders) {
    if (ignoreIds.has(o.id)) continue;
    const t = rayAabbEntry(origin, dir, o.min, o.max, dist - 1e-3, 0);
    if (t !== null && (best === null || t < best.t)) best = { t, occluderId: o.id };
  }
  return best;
};

/** True when the straight segment between two points is unobstructed. */
export const segmentClear = (
  origin: Vec3,
  target: Vec3,
  occluders: Occluder[],
  ignoreIds: ReadonlySet<string> = new Set(),
): boolean => nearestBlocker(origin, target, occluders, ignoreIds) === null;

/**
 * Visibility of an actor's body from a camera, sampled on a small 3x3 lattice
 * inside the actor's vertical volume. Fraction of samples with a clear line.
 * Head sample is separated because "head visible" is the headline metric.
 */
export interface ActorVisibility {
  frac: number;
  headVisible: boolean;
  headPoint: Vec3;
  blockedSamples: number;
  totalSamples: number;
  nearestBlockerId: string | null;
}

export const actorVisibility = (
  eye: Vec3,
  pos: Vec3,
  height: number,
  radius: number,
  occluders: Occluder[],
): ActorVisibility => {
  const head = v3(pos.x, pos.y + height * 0.94, pos.z);
  const headBlocker = nearestBlocker(eye, head, occluders, new Set());
  let clear = 0;
  let total = 0;
  let nearestId: string | null = null;
  for (const fy of [0.2, 0.5, 0.8]) {
    for (const fx of [-0.7, 0, 0.7]) {
      const p = v3(
        pos.x + radius * fx * 0.75,
        pos.y + height * fy,
        pos.z,
      );
      total++;
      const hit = nearestBlocker(eye, p, occluders, new Set());
      if (hit === null) clear++;
      else if (nearestId === null) nearestId = hit.occluderId;
    }
  }
  return {
    frac: total === 0 ? 0 : clear / total,
    headVisible: headBlocker === null,
    headPoint: head,
    blockedSamples: total - clear,
    totalSamples: total,
    nearestBlockerId: headBlocker ? headBlocker.occluderId : nearestId,
  };
};

export const insideBox = (p: Vec3, b: { min: Vec3; max: Vec3 }): boolean =>
  p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;

export const insideAnyVolume = (p: Vec3, vols: BoxVolume[]): BoxVolume | null => {
  for (const v of vols) if (insideBox(p, v)) return v;
  return null;
};

/** Closest distance from a point to an AABB (0 when inside). */
export const distanceToBox = (p: Vec3, b: { min: Vec3; max: Vec3 }): number => {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/** Camera must stay outside all occluders, with a small standoff. */
export const cameraIntersectsSolid = (p: Vec3, occluders: Occluder[], clearance = 0.22): Occluder | null => {
  for (const o of occluders) if (distanceToBox(p, o) < clearance) return o;
  return null;
};

/** Ring of points on a sphere of `radius` around `center`, facing `origin`. */
export const fanPoints = (origin: Vec3, center: Vec3, radius: number, count: number): Vec3[] => {
  const axis = sub(center, origin);
  const dist = length(axis);
  if (dist < 1e-6) return [];
  const fwd = mul(axis, 1 / dist);
  const upRef = Math.abs(fwd.y) > 0.95 ? v3(0, 0, 1) : v3(0, 1, 0);
  const right = normalizeSafe(upRef, fwd);
  const up = v3(
    fwd.y * right.z - fwd.z * right.y,
    fwd.z * right.x - fwd.x * right.z,
    fwd.x * right.y - fwd.y * right.x,
  );
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push(add(center, add(mul(right, Math.cos(a) * radius), mul(up, Math.sin(a) * radius))));
  }
  return out;
};

const normalizeSafe = (upRef: Vec3, fwd: Vec3): Vec3 => {
  const p = sub(upRef, mul(fwd, dot(upRef, fwd)));
  const l = length(p);
  return l < 1e-6 ? v3(1, 0, 0) : mul(p, 1 / l);
};

export const visibilityCount = (vs: ActorVisibility[]): { visible: number; total: number; avg: number } => {
  const avg = vs.length === 0 ? 0 : vs.reduce((s, x) => s + x.frac, 0) / vs.length;
  return { visible: vs.filter((x) => x.frac >= 0.55).length, total: vs.length, avg: clamp01(avg) };
};
