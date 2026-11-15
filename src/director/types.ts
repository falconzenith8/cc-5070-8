import type { Vec3 } from './math3d';

export interface Occluder {
  id: string;
  label: string;
  min: Vec3;
  max: Vec3;
  tone: 'wall' | 'panel' | 'column' | 'prop';
}

export interface BoxVolume {
  id: string;
  label: string;
  min: Vec3;
  max: Vec3;
}

export interface CameraBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface StageGeometry {
  id: string;
  label: string;
  floorY: number;
  cameraBounds: CameraBounds;
  stageBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Static blockers. Moving scenic panels are added per frame from cues. */
  occluders: Occluder[];
  /** Volumes where a camera may never be placed (rigging, scenic enclosure). */
  noCameraVolumes: BoxVolume[];
  /** Physical wide fallback rig used only by the no-feasible-candidate policy. */
  safetyRig: { x: number; z: number; y: number; fov: number };
}

export type ActorAction = 'idle' | 'speak' | 'gesture' | 'walk' | 'listen' | 'react';

export interface TrackKey {
  t: number;
  x: number;
  z: number;
  yaw: number;
  action: ActorAction;
}

export interface ActorDef {
  id: string;
  name: string;
  color: string;
  height: number;
  radius: number;
  track: TrackKey[];
}

export interface Beat {
  t: number;
  label: string;
  /** Dramatic salience per actor, 0..1. Authored by the performance, not the camera. */
  weights: Record<string, number>;
}

export interface Scenario {
  id: string;
  name: string;
  tagline: string;
  duration: number;
  actors: ActorDef[];
  beats: Beat[];
  intent: string;
}

export interface PerfActor {
  id: string;
  name: string;
  color: string;
  height: number;
  radius: number;
  pos: Vec3;
  yaw: number;
  action: ActorAction;
  salience: number;
}

export interface PerformanceState {
  scenarioId: string;
  time: number;
  actors: PerfActor[];
  primaryId: string;
  focusPoint: Vec3;
  focusSpread: number;
  beatLabel: string;
  beatIndex: number;
}

export interface CameraSpec {
  pos: Vec3;
  aim: Vec3;
  fov: number;
}

export interface ScoreBreakdown {
  visibility: number;
  composition: number;
  duration: number;
  total: number;
}

export type AnchorKind = 'primary' | 'secondary' | 'two-shot' | 'group' | 'safety';

export interface RawCandidate {
  id: string;
  label: string;
  kind: 'generated' | 'safety';
  anchor: AnchorKind;
  cam: CameraSpec;
  targets: string[];
  /** Single subject used for framing metrics; for group shots this is '' */
  frameTarget: string;
  lens: 'wide' | 'standard' | 'tight';
  azimuthDeg: number;
  elevationLabel: string;
}

export interface CandidateFeatures {
  primaryVisibility: number;
  targetVisibility: number;
  groupVisibility: number;
  primaryHeadVisible: boolean;
  primaryHeadInFrame: boolean;
  targetsHeadInFrame: boolean;
  framedHeadVisible: boolean;
  screenHeightFrac: number;
  headroom: number;
  thirdsOffset: number;
  groupBalance: number;
  faceScore: number;
  holdSeconds: number;
  /** Angular distance between this candidate and the on-air camera (diagnostic). */
  panFromOnAirDeg: number;
}

export interface ScoringWeights {
  visibility: number;
  composition: number;
  duration: number;
}

export interface CandidateEvaluation extends RawCandidate {
  geomValid: boolean;
  geomReason: string;
  feasible: boolean;
  rejectReason: string;
  scores: ScoreBreakdown;
  features: CandidateFeatures;
  summary: string;
  /** Authored rules that gave this candidate a preference bonus. */
  ruleBonus?: { amount: number; ruleIds: string[] };
  /** Authored rule ids that removed this candidate from the feasible set. */
  ruleDeniedBy?: string[];
}

export interface OnAirShot {
  shotId: number;
  label: string;
  sourceCandidateId: string;
  targetActor: string;
  targetName: string;
  /** Full set of subjects the shot is composed for (e.g. both actors of a two-shot). */
  targetIds: string[];
  anchorKind: AnchorKind;
  pos: Vec3;
  aim: Vec3;
  fov: number;
  lens: 'wide' | 'standard' | 'tight';
  startedAt: number;
  /** What the shot was selected for, e.g. primary or a substitute. */
  role: 'primary' | 'substitute' | 'safety';
  selectionReason: string;
}

export type DecisionType =
  | 'start'
  | 'cut'
  | 'hold'
  | 'interrupt'
  | 'keep-no-alternatives'
  | 'fallback-safety'
  | 'fallback-black'
  | 'recover'
  | 'none';

export interface DirectorDecision {
  type: DecisionType;
  reason: string;
  cut: boolean;
  /** Non-null when the cut bypassed or overrode the minimum hold. */
  interruption: string | null;
  onAirLabel: string | null;
  bestCandidateId: string | null;
  bestScore: number;
  liveScore: number;
}

export type Severity = 'info' | 'warn' | 'error';

export interface DirectorWarning {
  code: string;
  severity: Severity;
  message: string;
}

export interface RuleTraceEntry {
  id: string;
  label: string;
  priority: number;
  /** Why the rule matched: the resolved condition values for this frame. */
  conditions: string[];
}

export interface DirectorFrame {
  time: number;
  step: number;
  perf: PerformanceState;
  occluders: Occluder[];
  candidates: CandidateEvaluation[];
  feasibleCount: number;
  primaryAvailable: boolean;
  onAir: OnAirShot | null;
  onAirEval: CandidateEvaluation | null;
  decision: DirectorDecision;
  warnings: DirectorWarning[];
  black: boolean;
  shotAge: number;
  policyId: string;
  policyLabel: string;
  safety: CandidateEvaluation | null;
  switchesThisRun: number;
  /** Versioned-rule provenance for this frame. */
  ruleAssetId: string;
  ruleAssetVersion: number;
  /** Rules that matched this frame, highest priority first. */
  rules: RuleTraceEntry[];
  /** Effective (rule-biased, normalised) weights used for scoring. */
  scoringWeights: ScoringWeights;
}
