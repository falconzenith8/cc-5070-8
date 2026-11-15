export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l < 1e-9 ? v3(0, 0, 0) : mul(a, 1 / l);
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const lerpNum = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x: number): number => clamp(x, 0, 1);
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
export const deg = (r: number): number => (r * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

export interface Mat4 {
  // column-major, like THREE.Matrix4.elements
  e: Float32Array;
}

export const mat4Identity = (): Mat4 => {
  const e = new Float32Array(16);
  e[0] = e[5] = e[10] = e[15] = 1;
  return { e };
};

/** Right-handed view matrix from eye looking at target with given up. */
export const lookAt = (eye: Vec3, target: Vec3, up: Vec3 = v3(0, 1, 0)): Mat4 => {
  let z = normalize(sub(eye, target));
  if (length(z) < 1e-9) z = v3(0, 0, 1);
  let x = normalize(cross(up, z));
  if (length(x) < 1e-9) {
    // Degenerate: looking straight up/down. Pick a stable fallback axis.
    x = normalize(cross(v3(0, 0, 1), z));
    if (length(x) < 1e-9) x = v3(1, 0, 0);
  }
  const y = cross(z, x);
  const e = new Float32Array(16);
  e[0] = x.x; e[4] = y.x; e[8] = z.x; e[12] = -dot(x, eye);
  e[1] = x.y; e[5] = y.y; e[9] = z.y; e[13] = -dot(y, eye);
  e[2] = x.z; e[6] = y.z; e[10] = z.z; e[14] = -dot(z, eye);
  e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
  return { e };
};

export const perspective = (fovYDeg: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan(rad(fovYDeg) / 2);
  const e = new Float32Array(16);
  e[0] = f / aspect;
  e[5] = f;
  e[10] = (far + near) / (near - far);
  e[11] = -1;
  e[14] = (2 * far * near) / (near - far);
  e[15] = 0;
  return { e };
};

export const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const e = new Float32Array(16);
  const A = a.e;
  const B = b.e;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      e[c * 4 + r] =
        A[0 * 4 + r] * B[c * 4 + 0] +
        A[1 * 4 + r] * B[c * 4 + 1] +
        A[2 * 4 + r] * B[c * 4 + 2] +
        A[3 * 4 + r] * B[c * 4 + 3];
    }
  }
  return { e };
};

/** Transform a point (w=1); returns homogeneous clip coords. */
export const projectPointToClip = (m: Mat4, p: Vec3): { x: number; y: number; z: number; w: number } => {
  const e = m.e;
  return {
    x: e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12],
    y: e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13],
    z: e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14],
    w: e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15],
  };
};

export interface NdcPoint {
  x: number;
  y: number;
  z: number;
  behind: boolean;
}

export const clipToNdc = (c: { x: number; y: number; z: number; w: number }): NdcPoint => {
  if (c.w <= 1e-6) return { x: NaN, y: NaN, z: NaN, behind: true };
  return { x: c.x / c.w, y: c.y / c.w, z: c.z / c.w, behind: false };
};

export const worldToNdc = (viewProj: Mat4, p: Vec3): NdcPoint =>
  clipToNdc(projectPointToClip(viewProj, p));
