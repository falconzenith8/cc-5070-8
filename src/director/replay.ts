import type { CandidateEvaluation, DirectorFrame, DirectorWarning, OnAirShot } from './types';

/** Compact, serialisable record of one directed frame, for replay/export. */
export interface ReplayFrame {
  t: number;
  step: number;
  beat: string;
  primary: string;
  feasibleCount: number;
  primaryAvailable: boolean;
  onAir: {
    shotId: number;
    candidateId: string;
    label: string;
    role: OnAirShot['role'];
    target: string;
    pos: [number, number, number];
    aim: [number, number, number];
    fov: number;
    startedAt: number;
  } | null;
  decision: {
    type: string;
    cut: boolean;
    interruption: string | null;
    reason: string;
    liveScore: number;
    bestScore: number;
    bestCandidateId: string | null;
  };
  shots: {
    id: string;
    label: string;
    feasible: boolean;
    reject: string;
    total: number;
    visibility: number;
    composition: number;
    duration: number;
    holdSeconds: number;
  }[];
  warnings: DirectorWarning[];
}

export interface ReplayLog {
  version: 1;
  scenarioId: string;
  policyId: string;
  aspect: number;
  tickHz: number;
  recordedAt: string;
  frames: ReplayFrame[];
  shots: {
    shotId: number;
    label: string;
    candidateId: string;
    role: OnAirShot['role'];
    startedAt: number;
    selectionReason: string;
    target: string;
  }[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const frameToReplay = (f: DirectorFrame): ReplayFrame => ({
  t: r3(f.time),
  step: f.step,
  beat: f.perf.beatLabel,
  primary: f.perf.primaryId,
  feasibleCount: f.feasibleCount,
  primaryAvailable: f.primaryAvailable,
  onAir: f.onAir
    ? {
        shotId: f.onAir.shotId,
        candidateId: f.onAir.sourceCandidateId,
        label: f.onAir.label,
        role: f.onAir.role,
        target: f.onAir.targetName,
        pos: [r3(f.onAir.pos.x), r3(f.onAir.pos.y), r3(f.onAir.pos.z)],
        aim: [r3(f.onAir.aim.x), r3(f.onAir.aim.y), r3(f.onAir.aim.z)],
        fov: r3(f.onAir.fov),
        startedAt: r3(f.onAir.startedAt),
      }
    : null,
  decision: {
    type: f.decision.type,
    cut: f.decision.cut,
    interruption: f.decision.interruption,
    reason: f.decision.reason,
    liveScore: r3(f.decision.liveScore),
    bestScore: r3(f.decision.bestScore),
    bestCandidateId: f.decision.bestCandidateId,
  },
  shots: f.candidates
    .filter((c) => c.kind === 'generated')
    .map((c) => compactCandidate(c)),
  warnings: f.warnings,
});

const compactCandidate = (c: CandidateEvaluation) => ({
  id: c.id,
  label: c.label,
  feasible: c.feasible,
  reject: c.rejectReason,
  total: r3(c.scores.total),
  visibility: r3(c.scores.visibility),
  composition: r3(c.scores.composition),
  duration: r3(c.scores.duration),
  holdSeconds: r3(c.features.holdSeconds),
});

/**
 * Accumulates frames into a replay log. Sampling is decoupled from the render
 * loop: we persist every Nth tick so the export stays small but faithful.
 */
export class ReplayRecorder {
  private frames: ReplayFrame[] = [];
  private shots = new Map<number, ReplayLog['shots'][number]>();
  private lastShotId = 0;
  private startedAt = new Date().toISOString();
  constructor(
    readonly scenarioId: string,
    readonly policyId: string,
    readonly aspect: number,
    readonly tickHz: number,
    private every = 2,
  ) {}

  push(f: DirectorFrame) {
    if (f.onAir && f.onAir.shotId !== this.lastShotId) {
      this.lastShotId = f.onAir.shotId;
      this.shots.set(f.onAir.shotId, {
        shotId: f.onAir.shotId,
        label: f.onAir.label,
        candidateId: f.onAir.sourceCandidateId,
        role: f.onAir.role,
        startedAt: r3(f.onAir.startedAt),
        selectionReason: f.onAir.selectionReason,
        target: f.onAir.targetName,
      });
    }
    if (f.step % this.every === 0) this.frames.push(frameToReplay(f));
  }

  reset() {
    this.frames = [];
    this.shots = new Map();
    this.lastShotId = 0;
    this.startedAt = new Date().toISOString();
  }

  toLog(): ReplayLog {
    return {
      version: 1,
      scenarioId: this.scenarioId,
      policyId: this.policyId,
      aspect: this.aspect,
      tickHz: this.tickHz,
      recordedAt: this.startedAt,
      frames: this.frames,
      shots: [...this.shots.values()].sort((a, b) => a.startedAt - b.startedAt),
    };
  }

  get frameCount() {
    return this.frames.length;
  }
}
