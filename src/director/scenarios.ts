import type { Scenario } from './types';

/**
 * All performance tracks are authored, fixed choreography. The director
 * observes these tracks; it never edits positions, yaw or timing to flatter a
 * shot. Every camera decision is derived from the same fixed input.
 */

const twoHander: Scenario = {
  id: 'two-hander',
  name: '双角色对峙',
  tagline: '两人分站舞台两侧互相注视，中央立柱在中段遮住 Mara',
  intent: '在固定轨迹下维持对话关系；主目标被部分遮挡时明确降级或换机。',
  duration: 36,
  actors: [
    {
      id: 'mara',
      name: 'Mara',
      color: '#e0603c',
      height: 1.62,
      radius: 0.28,
      track: [
        { t: 0, x: 2.6, z: 1.2, yaw: -2.0, action: 'idle' },
        { t: 2, x: 2.55, z: 1.1, yaw: -2.0, action: 'speak' },
        { t: 7, x: 2.5, z: 0.9, yaw: -2.1, action: 'gesture' },
        { t: 10, x: 2.2, z: 0.4, yaw: -2.3, action: 'walk' },
        { t: 13, x: 1.55, z: -0.1, yaw: -2.05, action: 'speak' },
        { t: 17, x: 1.35, z: -0.2, yaw: -1.95, action: 'gesture' },
        { t: 21, x: 1.4, z: 0.0, yaw: -2.0, action: 'listen' },
        { t: 25, x: 1.8, z: 0.5, yaw: -2.2, action: 'walk' },
        { t: 29, x: 2.3, z: 0.9, yaw: -2.0, action: 'react' },
        { t: 33, x: 2.5, z: 1.1, yaw: -2.0, action: 'speak' },
        { t: 36, x: 2.5, z: 1.1, yaw: -2.0, action: 'idle' },
      ],
    },
    {
      id: 'ivo',
      name: 'Ivo',
      color: '#3c8ce0',
      height: 1.78,
      radius: 0.3,
      track: [
        { t: 0, x: -2.7, z: -1.4, yaw: 1.1, action: 'listen' },
        { t: 3, x: -2.65, z: -1.3, yaw: 1.15, action: 'react' },
        { t: 6, x: -2.6, z: -1.2, yaw: 1.1, action: 'speak' },
        { t: 9, x: -2.5, z: -1.05, yaw: 1.2, action: 'gesture' },
        { t: 12, x: -2.45, z: -1.0, yaw: 1.15, action: 'walk' },
        { t: 16, x: -2.5, z: -1.1, yaw: 1.1, action: 'speak' },
        { t: 20, x: -2.35, z: -1.25, yaw: 1.15, action: 'listen' },
        { t: 24, x: -2.2, z: -1.5, yaw: 1.2, action: 'walk' },
        { t: 28, x: -2.6, z: -1.6, yaw: 1.1, action: 'react' },
        { t: 32, x: -2.75, z: -1.5, yaw: 1.1, action: 'speak' },
        { t: 36, x: -2.75, z: -1.5, yaw: 1.1, action: 'idle' },
      ],
    },
  ],
  beats: [
    { t: 0, label: '开场·各自站位', weights: { mara: 0.55, ivo: 0.45 } },
    { t: 6, label: 'Ivo 先发话', weights: { mara: 0.45, ivo: 0.85 } },
    { t: 10, label: 'Mara 走向舞台中心', weights: { mara: 0.9, ivo: 0.4 } },
    { t: 13, label: 'Mara 中心发言', weights: { mara: 1.0, ivo: 0.35 } },
    { t: 17, label: '立柱遮挡 Mara', weights: { mara: 0.95, ivo: 0.4 } },
    { t: 21, label: 'Mara 倾听 Ivo', weights: { mara: 0.4, ivo: 0.9 } },
    { t: 25, label: 'Mara 转身回走', weights: { mara: 0.75, ivo: 0.5 } },
    { t: 29, label: 'Mara 反应', weights: { mara: 0.85, ivo: 0.6 } },
    { t: 33, label: '双方收束', weights: { mara: 0.6, ivo: 0.6 } },
  ],
};

const crossing: Scenario = {
  id: 'crossing',
  name: '多人交叉',
  tagline: '三名演员在不同深度交叉穿行，动作重点频繁转移',
  intent: '多人交叉时区分瞬时主目标，验证评分随真实投影更新、最短保持生效。',
  duration: 38,
  actors: [
    {
      id: 'mara',
      name: 'Mara',
      color: '#e0603c',
      height: 1.62,
      radius: 0.28,
      track: [
        { t: 0, x: 3.2, z: 2.2, yaw: -2.36, action: 'walk' },
        { t: 5, x: 1.4, z: 0.4, yaw: -2.36, action: 'walk' },
        { t: 9, x: -0.6, z: -1.0, yaw: -2.18, action: 'speak' },
        { t: 13, x: -2.4, z: -2.0, yaw: -2.08, action: 'gesture' },
        { t: 18, x: -3.0, z: -1.2, yaw: -0.64, action: 'listen' },
        { t: 23, x: -1.2, z: 0.8, yaw: 0.73, action: 'walk' },
        { t: 27, x: 1.0, z: 2.0, yaw: 1.07, action: 'react' },
        { t: 32, x: 2.8, z: 1.4, yaw: 1.89, action: 'speak' },
        { t: 38, x: 3.0, z: 1.2, yaw: 2.36, action: 'idle' },
      ],
    },
    {
      id: 'ivo',
      name: 'Ivo',
      color: '#3c8ce0',
      height: 1.78,
      radius: 0.3,
      track: [
        { t: 0, x: -3.1, z: 1.9, yaw: 2.28, action: 'walk' },
        { t: 4, x: -1.6, z: 0.6, yaw: 2.28, action: 'speak' },
        { t: 8, x: 0.1, z: -0.6, yaw: 2.19, action: 'walk' },
        { t: 12, x: 1.8, z: -1.6, yaw: 2.10, action: 'gesture' },
        { t: 16, x: 2.0, z: -0.2, yaw: 0.14, action: 'walk' },
        { t: 20, x: 1.1, z: 1.4, yaw: -0.51, action: 'listen' },
        { t: 24, x: -0.8, z: 2.0, yaw: -1.27, action: 'react' },
        { t: 29, x: -2.6, z: 1.1, yaw: -2.03, action: 'speak' },
        { t: 38, x: -2.8, z: 0.9, yaw: -2.36, action: 'idle' },
      ],
    },
    {
      id: 'tomas',
      name: 'Tomas',
      color: '#86c04a',
      height: 1.86,
      radius: 0.32,
      track: [
        { t: 0, x: 0.2, z: 3.4, yaw: -3.03, action: 'walk' },
        { t: 6, x: 0.0, z: 1.6, yaw: -3.03, action: 'walk' },
        { t: 10, x: -0.3, z: 0.1, yaw: -2.94, action: 'speak' },
        { t: 14, x: -0.6, z: -1.8, yaw: -2.99, action: 'gesture' },
        { t: 18, x: -0.2, z: -2.9, yaw: 2.79, action: 'listen' },
        { t: 22, x: 1.6, z: -2.4, yaw: 1.30, action: 'walk' },
        { t: 27, x: 2.6, z: -1.0, yaw: 0.62, action: 'react' },
        { t: 31, x: 1.8, z: 1.4, yaw: -0.32, action: 'speak' },
        { t: 38, x: 1.4, z: 1.8, yaw: -0.79, action: 'idle' },
      ],
    },
  ],
  beats: [
    { t: 0, label: '三方入场', weights: { mara: 0.6, ivo: 0.6, tomas: 0.6 } },
    { t: 4, label: 'Ivo 发话', weights: { mara: 0.5, ivo: 0.9, tomas: 0.45 } },
    { t: 9, label: 'Mara 接话', weights: { mara: 0.95, ivo: 0.5, tomas: 0.6 } },
    { t: 13, label: 'Tomas 手势', weights: { mara: 0.55, ivo: 0.4, tomas: 0.9 } },
    { t: 18, label: '三人换位', weights: { mara: 0.7, ivo: 0.7, tomas: 0.7 } },
    { t: 24, label: 'Ivo 反应', weights: { mara: 0.45, ivo: 0.95, tomas: 0.5 } },
    { t: 29, label: 'Ivo 收束发言', weights: { mara: 0.5, ivo: 1.0, tomas: 0.45 } },
    { t: 34, label: '尾声', weights: { mara: 0.55, ivo: 0.65, tomas: 0.55 } },
  ],
};

const occlusion: Scenario = {
  id: 'occlusion',
  name: '关键目标被遮挡',
  tagline: '挡板合拢把中心区的 Mara 与所有合法机位隔开，随后整前台降下侧幕',
  intent: '关键目标不可见时明确报告失败；替代镜头与安全位都必须是真实合法机位。',
  duration: 40,
  actors: [
    {
      id: 'mara',
      name: 'Mara',
      color: '#e0603c',
      height: 1.62,
      radius: 0.28,
      track: [
        { t: 0, x: 0.2, z: -1.2, yaw: -1.0, action: 'speak' },
        { t: 6, x: 0.5, z: -1.1, yaw: -1.0, action: 'gesture' },
        { t: 12, x: 0.55, z: -1.15, yaw: -1.0, action: 'speak' },
        { t: 16, x: 0.6, z: -1.2, yaw: -1.0, action: 'gesture' },
        { t: 22, x: 0.7, z: -1.15, yaw: -1.0, action: 'listen' },
        { t: 27, x: 0.75, z: -1.1, yaw: -1.0, action: 'gesture' },
        { t: 33, x: 0.8, z: -1.0, yaw: -1.0, action: 'speak' },
        { t: 40, x: 0.8, z: -0.9, yaw: -1.0, action: 'idle' },
      ],
    },
    {
      id: 'ivo',
      name: 'Ivo',
      color: '#3c8ce0',
      height: 1.78,
      radius: 0.3,
      track: [
        { t: 0, x: 3.1, z: 0.7, yaw: -2.3, action: 'listen' },
        { t: 8, x: 3.05, z: 0.72, yaw: -2.3, action: 'react' },
        { t: 14, x: 3.0, z: 0.75, yaw: -2.3, action: 'speak' },
        { t: 20, x: 2.95, z: 0.78, yaw: -2.3, action: 'gesture' },
        { t: 28, x: 2.9, z: 0.8, yaw: -2.3, action: 'speak' },
        { t: 34, x: 2.85, z: 0.82, yaw: -2.3, action: 'listen' },
        { t: 40, x: 2.8, z: 0.85, yaw: -2.3, action: 'idle' },
      ],
    },
  ],
  beats: [
    { t: 0, label: 'Mara 中心发言', weights: { mara: 1.0, ivo: 0.35 } },
    { t: 6, label: 'Mara 手势', weights: { mara: 0.95, ivo: 0.4 } },
    { t: 9, label: '挡板开始合拢', weights: { mara: 0.9, ivo: 0.45 } },
    { t: 12, label: 'Mara 被完全遮挡', weights: { mara: 1.0, ivo: 0.5 } },
    { t: 14, label: '侧幕降下', weights: { mara: 0.95, ivo: 0.7 } },
    { t: 17, label: '全台无可见目标', weights: { mara: 0.85, ivo: 0.85 } },
    { t: 23, label: '挡板回撤', weights: { mara: 0.7, ivo: 0.8 } },
    { t: 29, label: '侧幕升起', weights: { mara: 0.95, ivo: 0.55 } },
    { t: 33, label: 'Mara 恢复', weights: { mara: 1.0, ivo: 0.45 } },
  ],
};

export const SCENARIOS: Scenario[] = [twoHander, crossing, occlusion];

export const getScenario = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
};

/** Validates authored tracks: contiguous, time-ordered, finite, long enough. */
export const validateScenario = (s: Scenario): void => {
  for (const a of s.actors) {
    if (a.track.length < 2) throw new Error(`${a.id}: track needs >=2 keys`);
    for (let i = 0; i < a.track.length; i++) {
      const k = a.track[i];
      if (!Number.isFinite(k.t) || !Number.isFinite(k.x) || !Number.isFinite(k.z)) {
        throw new Error(`${a.id}: non-finite key at index ${i}`);
      }
      if (i > 0 && k.t <= a.track[i - 1].t) throw new Error(`${a.id}: keys not strictly ordered`);
    }
    if (a.track[0].t !== 0) throw new Error(`${a.id}: track must start at t=0`);
    if (a.track[a.track.length - 1].t < s.duration) {
      throw new Error(`${a.id}: track ends before scenario duration`);
    }
  }
  for (let i = 1; i < s.beats.length; i++) {
    if (s.beats[i].t <= s.beats[i - 1].t) throw new Error('beats not strictly ordered');
  }
};

export interface ScenicCue {
  id: string;
  label: string;
  tone: 'wall' | 'panel' | 'column' | 'prop';
  /** Fully-open and fully-closed poses; per-axis min/max are interpolated. */
  openBox: { min: [number, number, number]; max: [number, number, number] };
  closedBox: { min: [number, number, number]; max: [number, number, number] };
  closesAt: number;
  fullyClosedAt: number;
  opensAt: number;
  fullyOpenAt: number;
}

/**
 * Scenic cues with fixed timings: part of the performance, never moved to
 * rescue a camera. Two sliding panels isolate the centre performer, then a
 * full-width scenic drop closes the whole front, creating a genuine window in
 * which no performer is visible from any legal camera.
 */
export const occluderCuesFor = (scenarioId: string): ScenicCue[] => {
  if (scenarioId !== 'occlusion') return [];
  return [
    {
      id: 'shutter-a',
      label: '左挡板',
      tone: 'panel',
      // Slides from beyond the west wing to the centre, so closed spans the
      // full apron width and there is no diagonal sight-line around it.
      openBox: { min: [-12.2, 0, 0.26], max: [-7.8, 3.6, 0.44] },
      closedBox: { min: [-7.8, 0, 0.26], max: [0.45, 3.6, 0.44] },
      closesAt: 9,
      fullyClosedAt: 12,
      opensAt: 23,
      fullyOpenAt: 26,
    },
    {
      id: 'shutter-b',
      label: '右挡板',
      tone: 'panel',
      openBox: { min: [7.8, 0, 0.26], max: [12.2, 3.6, 0.44] },
      closedBox: { min: [-0.45, 0, 0.26], max: [7.8, 3.6, 0.44] },
      closesAt: 9.4,
      fullyClosedAt: 12.4,
      opensAt: 23.4,
      fullyOpenAt: 26.4,
    },
    {
      id: 'scenic-drop',
      label: '前区侧幕',
      tone: 'wall',
      // Hangs between the apron (z >= 2.6) and the performers (z <= 1.0).
      openBox: { min: [-7.8, 4.2, 1.75], max: [7.8, 7.4, 1.85] },
      closedBox: { min: [-7.8, 0, 1.75], max: [7.8, 4.2, 1.85] },
      closesAt: 14,
      fullyClosedAt: 17,
      opensAt: 29,
      fullyOpenAt: 32,
    },
  ];
};
