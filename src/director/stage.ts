import type { StageGeometry, Occluder } from './types';
import type { Vec3 } from './math3d';

const box = (
  id: string,
  label: string,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  tone: Occluder['tone'],
): Occluder => ({
  id,
  label,
  tone,
  min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 },
  max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 },
});

/**
 * Stage geometry shared by all scenarios. Coordinates are metres; the stage
 * occupies negative z and the auditorium positive z. Camera bounds describe
 * where a physical camera can actually stand or be rigged — they are never
 * widened at runtime to rescue a shot.
 */
export const STAGES: Record<string, StageGeometry> = {
  'two-hander': {
    id: 'two-hander',
    label: '双人舞台',
    floorY: 0,
    cameraBounds: { minX: -7.6, maxX: 7.6, minY: 0.9, maxY: 4.2, minZ: -1.2, maxZ: 6.8 },
    stageBounds: { minX: -5, maxX: 5, minZ: -3.5, maxZ: 4 },
    occluders: [
      box('pillar', '中央立柱', 1.2, 1.6, -0.65, 0.62, 3.2, 0.62, 'column'),
      box('flat-l', '左侧翼板', -4.3, 1.9, -1.8, 0.3, 3.8, 3.2, 'panel'),
      box('flat-r', '右侧翼板', 4.4, 1.9, 1.9, 0.3, 3.8, 3.0, 'panel'),
      box('back-wall', '后墙', 0, 2.0, -3.6, 10.0, 4.0, 0.3, 'wall'),
    ],
    noCameraVolumes: [
      {
        id: 'truss-r',
        label: '右后灯架',
        min: { x: 3.4, y: 3.2, z: -2.6 },
        max: { x: 5.4, y: 4.2, z: -1.2 },
      },
      {
        id: 'front-rail',
        label: '前区栏杆',
        min: { x: -7.6, y: 0.0, z: 5.4 },
        max: { x: 7.6, y: 1.5, z: 7.0 },
      },
    ],
    safetyRig: { x: 0, z: 5.9, y: 3.1, fov: 46 },
  },
  crossing: {
    id: 'crossing',
    label: '交叉舞台',
    floorY: 0,
    cameraBounds: { minX: -8.0, maxX: 8.0, minY: 0.9, maxY: 4.6, minZ: -1.4, maxZ: 7.2 },
    stageBounds: { minX: -5.5, maxX: 5.5, minZ: -4, maxZ: 4 },
    occluders: [
      box('tower-a', '左塔', -3.9, 1.5, -2.2, 0.8, 3.0, 0.8, 'column'),
      box('tower-b', '右塔', 4.0, 1.5, 0.4, 0.8, 3.0, 0.8, 'column'),
      box('low-prop', '道具台', 0.3, 0.45, 2.2, 2.2, 0.9, 1.0, 'prop'),
      box('back-wall', '后墙', 0, 2.0, -4.1, 11.0, 4.0, 0.3, 'wall'),
    ],
    noCameraVolumes: [
      {
        id: 'speaker-rig',
        label: '悬吊音箱',
        min: { x: -6.2, y: 3.6, z: -3.0 },
        max: { x: -4.4, y: 4.6, z: -1.8 },
      },
      {
        id: 'front-rail',
        label: '前区栏杆',
        min: { x: -8.0, y: 0.0, z: 5.8 },
        max: { x: 8.0, y: 1.5, z: 7.2 },
      },
    ],
    safetyRig: { x: 0, z: 6.4, y: 3.4, fov: 48 },
  },
  occlusion: {
    id: 'occlusion',
    label: '遮挡舞台',
    floorY: 0,
    // Full apron in front of a scenic line. Actors stand behind the drop plane
    // (z <= 1.0); every legal camera stands behind it (z >= 2.6), so a lowered
    // drop really does remove every performer from every legal camera.
    cameraBounds: { minX: -7.4, maxX: 7.4, minY: 1.3, maxY: 4.0, minZ: 2.6, maxZ: 5.8 },
    stageBounds: { minX: -5, maxX: 5, minZ: -3.5, maxZ: 1.6 },
    occluders: [
      box('back-wall', '后墙', 0, 2.0, -3.6, 10.0, 4.0, 0.3, 'wall'),
      box('flat-l', '左侧翼板', -4.6, 1.9, -0.6, 0.3, 3.8, 2.6, 'panel'),
      // shutter-a / shutter-b / scenic-drop are injected from occluderCuesFor().
    ],
    noCameraVolumes: [
      {
        id: 'prompter',
        label: '提词屏',
        min: { x: -3.9, y: 0.9, z: 5.0 },
        max: { x: -2.6, y: 2.1, z: 5.9 },
      },
      {
        id: 'front-rail',
        label: '前区栏杆',
        min: { x: -7.4, y: 0.0, z: 5.8 },
        max: { x: 7.4, y: 1.3, z: 6.6 },
      },
    ],
    safetyRig: { x: 0, z: 5.2, y: 2.8, fov: 46 },
  },
};

export const getStage = (scenarioId: string): StageGeometry => {
  const s = STAGES[scenarioId];
  if (!s) throw new Error(`no stage for scenario ${scenarioId}`);
  return s;
};

export const headPoint = (pos: Vec3, height: number): Vec3 => ({
  x: pos.x,
  y: pos.y + height * 0.94,
  z: pos.z,
});

export const chestPoint = (pos: Vec3, height: number): Vec3 => ({
  x: pos.x,
  y: pos.y + height * 0.66,
  z: pos.z,
});
