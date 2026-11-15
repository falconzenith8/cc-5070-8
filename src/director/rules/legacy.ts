import type { ActorAction } from '../types';

/**
 * Legacy (pre-versioned) director rules, as authored for the original show.
 *
 * This is the *old contract* and is kept verbatim so migration has a real,
 * immutable source to convert from and so the tests can prove the translation.
 * Two properties make it awkward to consume directly:
 *
 *  - durations and windows are in **milliseconds**, while the runtime ticks in
 *    performance seconds;
 *  - conditions are free-form tags, some of which this build cannot evaluate.
 *
 * `migrateLegacyAsset` (./migrate.ts) performs the conversion and reports any
 * unsupported tag. Never widen the runtime to accept this shape.
 */

export interface LegacyCondition {
  kind: string;
  action?: string;
  actor?: string;
  value?: string | number;
  /** Used by `time-window`, in milliseconds. */
  fromMs?: number;
  toMs?: number;
  note?: string;
}

export interface LegacyRule {
  id: string;
  label: string;
  /** Legacy priority: lower number = higher priority (opposite of v2). */
  order: number;
  when: LegacyCondition[];
  /** Legacy anchor preference; `close-up` has no v2 equivalent. */
  shot?: 'wide' | 'medium' | 'close-up';
  /** Authored shot whitelist, referencing lattice cell ids from the old build. */
  allowedShots?: string[];
  /** Legacy free-text rationale, preserved for the migration report. */
  rationale?: string;
  weightBias?: { visibility?: number; composition?: number; duration?: number };
}

export interface LegacyPolicy {
  id: string;
  name: string;
  blurb: string;
  minHoldMs: number;
  switchMargin: number;
  interruptMargin: number;
  interruptBelowScore: number;
  interruptBelowMs: number;
  maxCutDeg: number;
  allowStopDown: boolean;
  weights: { visibility: number; composition: number; duration: number };
  rules: LegacyRule[];
}

export interface LegacyEvent {
  key: string;
  /** Scenario the event sequence belongs to. */
  scenario: string;
  name: string;
  startMs: number;
  lengthMs: number;
}

export interface LegacyShow {
  format: 'stage-director-rules';
  revision: 'legacy';
  showId: string;
  events: LegacyEvent[];
  policies: LegacyPolicy[];
}

const ACTOR_ACTIONS = new Set<ActorAction>(['idle', 'speak', 'gesture', 'walk', 'listen', 'react']);
export const isActorAction = (s: string): s is ActorAction => ACTOR_ACTIONS.has(s as ActorAction);

/**
 * The authored legacy asset for the three test shows. Kept as one document so
 * the same policies apply to every scenario, exactly as the runtime defaults
 * did before the migration.
 */
export const LEGACY_RULE_ASSET: LegacyShow = {
  format: 'stage-director-rules',
  revision: 'legacy',
  showId: 'stage-shot-director/default',
  events: [
    { key: 'two-hander', scenario: 'two-hander', name: '双角色对峙', startMs: 0, lengthMs: 36000 },
    { key: 'crossing', scenario: 'crossing', name: '多人交叉', startMs: 0, lengthMs: 38000 },
    { key: 'occlusion', scenario: 'occlusion', name: '关键目标被遮挡', startMs: 0, lengthMs: 40000 },
  ],
  policies: [
    {
      id: 'balanced',
      name: '平衡导演',
      blurb: '可见性、构图与可保持时长均衡；最短保持 2.6s，默认演出策略。',
      minHoldMs: 2600,
      switchMargin: 0.03,
      interruptMargin: 0.18,
      interruptBelowScore: 0.24,
      interruptBelowMs: 600,
      maxCutDeg: 95,
      allowStopDown: true,
      weights: { visibility: 0.5, composition: 0.32, duration: 0.18 },
      rules: [
        {
          id: 'dialogue-hold',
          label: '对白段落优先双人同框',
          order: 10,
          when: [
            { kind: 'primary-speaks' },
            // Ivo is the listening partner in this two-hander.
            { kind: 'actor-action', actor: 'ivo', action: 'listen' },
          ],
          shot: 'medium',
          weightBias: { composition: 0.38, visibility: 0.46 },
        },
        {
          id: 'beat-window-guard',
          label: '关键遮挡窗口保住主目标',
          order: 20,
          when: [{ kind: 'time-window', fromMs: 12000, toMs: 17500 }],
          // Two of these cells are from the old 5×3×2 lattice; `gen:primary:75:…`
          // was dropped when the azimuth set was narrowed and no longer exists.
          allowedShots: [
            'gen:primary:-25:8:2.8',
            'gen:primary:0:8:4.4',
            'gen:primary:75:8:2.8',
          ],
          weightBias: { visibility: 0.62, duration: 0.16 },
        },
        {
          id: 'keep-head-clear',
          label: '头部被挡的机位一律不用',
          order: 15,
          when: [{ kind: 'always' }],
          rationale: '原意为否决，但旧字段只列出允许机位；按白名单迁移，不扩大为黑名单。',
          allowedShots: ['gen:primary:-50:-12:2.8', 'gen:primary:25:-12:4.4'],
        },
        {
          id: 'crowd-balance',
          label: '群戏保持整体空间关系',
          order: 30,
          when: [{ kind: 'beat-label', value: '尾声' }],
          shot: 'wide',
          weightBias: { composition: 0.4 },
        },
      ],
    },
    {
      id: 'patient',
      name: '长镜头导演',
      blurb: '偏好长镜头，最短保持 5s、切点更保守，适合稳定叙事。',
      minHoldMs: 5000,
      switchMargin: 0.075,
      interruptMargin: 0.26,
      interruptBelowScore: 0.2,
      interruptBelowMs: 1000,
      maxCutDeg: 80,
      allowStopDown: true,
      weights: { visibility: 0.46, composition: 0.3, duration: 0.24 },
      rules: [
        {
          id: 'long-take',
          label: '长镜头段落压低切换欲望',
          order: 10,
          when: [{ kind: 'always' }],
          weightBias: { duration: 0.3, visibility: 0.42 },
        },
      ],
    },
    {
      id: 'reactive',
      name: '快切导演',
      blurb: '紧跟动作重点，最短保持 1.1s、切换阈值更低，会产生更多剪切。',
      minHoldMs: 1100,
      switchMargin: 0.012,
      interruptMargin: 0.1,
      interruptBelowScore: 0.3,
      interruptBelowMs: 350,
      maxCutDeg: 130,
      allowStopDown: true,
      weights: { visibility: 0.56, composition: 0.29, duration: 0.15 },
      rules: [
        {
          id: 'follow-speaker',
          label: '发言者优先单人近景',
          order: 10,
          when: [{ kind: 'primary-speaks' }],
          shot: 'close-up',
        },
        {
          id: 'salient-guest',
          label: '高显著度配角也需要覆盖',
          order: 20,
          // The legacy asset never named the actor, so migration must report it.
          when: [{ kind: 'actor-salience', value: 0.8 }],
        },
      ],
    },
    {
      id: 'strict',
      name: '严格构图',
      blurb: '更重视构图质量与画面稳定，违反构图即降级；最短保持 3.4s。',
      minHoldMs: 3400,
      switchMargin: 0.05,
      interruptMargin: 0.2,
      interruptBelowScore: 0.32,
      interruptBelowMs: 500,
      maxCutDeg: 90,
      allowStopDown: false,
      weights: { visibility: 0.44, composition: 0.44, duration: 0.12 },
      rules: [
        {
          id: 'composition-first',
          label: '构图优先，牺牲可见性也可接受',
          order: 10,
          when: [{ kind: 'always' }],
          weightBias: { composition: 0.48, visibility: 0.4 },
        },
        {
          id: 'unstable-camera-guard',
          label: '手持干扰条件下必须稳住机位',
          order: 5,
          when: [{ kind: 'camera-shake' }],
        },
        {
          id: 'strict-whitelist',
          label: '只接受预演时确认过的机位',
          order: 8,
          when: [{ kind: 'beat-label', value: 'Mara 中心发言' }],
          allowedShots: ['gen:primary:-25:8:4.4', 'gen:primary:retired:4.4'],
        },
      ],
    },
  ],
};
