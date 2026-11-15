import type { Occluder, PerfActor, PerformanceState, RawCandidate, Scenario, StageGeometry } from '../types';
import { generateCandidates } from '../candidates';
import { samplePerformance, shuttersClosedAt } from '../performance';
import { movingOccludersAt } from '../performance';
import {
  type PolicyRuleSet,
  type RuleAsset,
  type RuleCondition,
  type RuleIssue,
  type RuleVec,
  type ScoringWeightsAsset,
} from './schema';

/** Score bonus applied per matched authored preference (anchors/lens/refs). */
export const PREFERENCE_BONUS = 0.06;

export interface RuleFrameContext {
  scenario: Scenario;
  perf: PerformanceState;
  /**
   * Measured, weight-independent: at least one geometrically legal lattice
   * cell sees >= 20% of the primary. This is *not* the same as "a feasible
   * shot exists" — feasibility also depends on hold/framing — so it is safe to
   * evaluate before scoring.
   */
  primaryVisible: boolean;
}

export interface MatchedRule {
  id: string;
  label: string;
  priority: number;
}

export interface MatchedPreference {
  rule: RuleVec;
  matched: MatchedRule;
}

export interface RuleEffect {
  /** Policy weights after matched `weightBias`, renormalised to sum 1. */
  weights: ScoringWeightsAsset;
  /** All matched rules, highest priority first. */
  matched: MatchedRule[];
  /** Matched rules that declare `prefer`, highest priority first. */
  preferences: MatchedPreference[];
  /** Authored allow-list refs, with the rules that allowed them. */
  allow: Map<string, MatchedRule[]>;
  /** Authored deny-list refs, with the rules that denied them. */
  deny: Map<string, MatchedRule[]>;
  /** Highest hold floor declared by a matched rule, in seconds. */
  minHoldSeconds: number | null;
}

const actorOf = (perf: PerformanceState, id: string): PerfActor | undefined =>
  perf.actors.find((a) => a.id === id);

export const evaluateCondition = (condition: RuleCondition, ctx: RuleFrameContext): boolean => {
  switch (condition.kind) {
    case 'primaryAction':
      return actorOf(ctx.perf, ctx.perf.primaryId)?.action === condition.action;
    case 'actorAction':
      return actorOf(ctx.perf, condition.actorId)?.action === condition.action;
    case 'beatLabel':
      return ctx.perf.beatLabel.includes(condition.contains);
    case 'beatRange':
      return ctx.perf.time >= condition.from && ctx.perf.time < condition.to;
    case 'salienceAtLeast':
      return (actorOf(ctx.perf, condition.actorId)?.salience ?? 0) >= condition.value;
    case 'primaryVisible':
      return ctx.primaryVisible;
    case 'primaryHidden':
      return !ctx.primaryVisible;
    case 'shuttersClosed':
      return shuttersClosedAt(ctx.scenario.id, ctx.perf.time);
    case 'always':
      return true;
  }
};

const normalizeWeights = (w: ScoringWeightsAsset): ScoringWeightsAsset => {
  const sum = w.visibility + w.composition + w.duration;
  // A zero-sum bias would make every candidate score 0; rank on equal terms
  // instead of silently ranking on nothing.
  if (sum <= 1e-9) return { visibility: 1 / 3, composition: 1 / 3, duration: 1 / 3 };
  return { visibility: w.visibility / sum, composition: w.composition / sum, duration: w.duration / sum };
};

const prioritySort = (a: MatchedRule, b: MatchedRule): number =>
  b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Resolves the authored rules against one frame. Pure: it reads the performance
 * only, never candidate scores or camera history.
 */
export const evaluateRules = (policy: PolicyRuleSet, ctx: RuleFrameContext): RuleEffect => {
  const matched: MatchedRule[] = [];
  const preferences: MatchedPreference[] = [];
  for (const rule of policy.rules) {
    if (!rule.conditions.every((c) => evaluateCondition(c, ctx))) continue;
    const m: MatchedRule = { id: rule.id, label: rule.label, priority: rule.priority };
    matched.push(m);
    if (rule.prefer) preferences.push({ rule, matched: m });
  }
  matched.sort(prioritySort);
  preferences.sort((a, b) => prioritySort(a.matched, b.matched));

  const weights: ScoringWeightsAsset = { ...policy.weights };
  let minHoldSeconds: number | null = null;
  // Apply lowest priority first so a higher-priority rule's bias wins.
  const matchedRules = matched
    .map((m) => policy.rules.find((r) => r.id === m.id)!)
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  for (const rule of matchedRules) {
    const bias = rule.weightBias;
    if (bias) {
      for (const key of ['visibility', 'composition', 'duration'] as const) {
        const v = bias[key];
        if (v !== undefined) weights[key] = v;
      }
    }
    const floor = rule.prefer?.minHoldSeconds;
    if (floor !== undefined) minHoldSeconds = minHoldSeconds === null ? floor : Math.max(minHoldSeconds, floor);
  }

  const allow = new Map<string, MatchedRule[]>();
  const deny = new Map<string, MatchedRule[]>();
  for (const { rule, matched: m } of preferences) {
    const refs = rule.prefer?.candidateRefs;
    if (!refs) continue;
    const target = rule.prefer?.refMode === 'deny' ? deny : allow;
    for (const ref of refs) {
      const list = target.get(ref) ?? [];
      if (!list.some((r) => r.id === m.id)) list.push(m);
      target.set(ref, list);
    }
  }

  return { weights: normalizeWeights(weights), matched, preferences, allow, deny, minHoldSeconds };
};

/**
 * Score bonus for one raw candidate under the matched preferences. Multiple
 * matching preferences accumulate; the amount is intentionally small relative
 * to measured score differences, since authored preference must not override
 * what the projection actually sees.
 */
export const preferenceBonus = (raw: RawCandidate, preferences: MatchedPreference[]): number => {
  let bonus = 0;
  for (const { rule } of preferences) {
    const p = rule.prefer;
    if (!p) continue;
    let matchedRule = false;
    if (p.anchors && p.anchors.includes(raw.anchor as (typeof p.anchors)[number])) matchedRule = true;
    if (p.lens && p.lens === raw.lens) matchedRule = true;
    if (p.candidateRefs?.includes(raw.id)) matchedRule = true;
    if (matchedRule) bonus += PREFERENCE_BONUS;
  }
  return bonus;
};

/** True when a candidate reference exists in the lattice at any sample time. */
export const candidateRefExists = (ref: string, raws: RawCandidate[]): boolean => raws.some((r) => r.id === ref);

/**
 * Checks each authored candidate reference against the live lattice at the
 * supplied sample times. Missing refs are returned with their rule so they can
 * be surfaced to the operator rather than silently ignored.
 */
export const inspectCandidateRefs = (
  asset: RuleAsset,
  scenario: Scenario,
  stage: StageGeometry,
  sampleTimes?: number[],
): RuleIssue[] => {
  const refs = new Map<string, { ruleId: string; path: string }>();
  asset.policies.forEach((policy, pi) => {
    policy.rules.forEach((rule, ri) => {
      for (const ref of rule.prefer?.candidateRefs ?? []) {
        refs.set(ref, {
          ruleId: rule.id,
          path: `policies[${pi}].rules[${ri}].prefer.candidateRefs`,
        });
      }
    });
  });
  if (refs.size === 0) return [];

  const times = sampleTimes ?? [0, scenario.duration / 4, scenario.duration / 2, (scenario.duration * 3) / 4];
  const seen = new Set<string>();
  for (const t of times) {
    const perf = samplePerformance(scenario, t);
    const occluders: Occluder[] = [...stage.occluders, ...movingOccludersAt(scenario.id, t)];
    const raws = generateCandidates({ scenario, stage, perf, occluders, aspect: 16 / 9 });
    for (const r of raws) if (refs.has(r.id)) seen.add(r.id);
  }

  const issues: RuleIssue[] = [];
  const reported = new Set<string>();
  for (const [ref, meta] of refs) {
    if (seen.has(ref) || reported.has(ref)) continue;
    reported.add(ref);
    issues.push({
      code: 'rule-candidate-missing',
      severity: 'warn',
      path: meta.path,
      message: `规则「${meta.ruleId}」引用的候选 ${ref} 在当前场景的候选网格中不存在（该引用不生效）。`,
    });
  }
  return issues;
};

/** Human-readable resolution of one condition for this frame's trace. */
export const describeCondition = (condition: RuleCondition): string => {
  switch (condition.kind) {
    case 'primaryAction':
      return `主目标动作 = ${condition.action}`;
    case 'actorAction':
      return `${condition.actorId} 动作 = ${condition.action}`;
    case 'beatLabel':
      return `节拍名含「${condition.contains}」`;
    case 'beatRange':
      return `时间 ∈ [${condition.from}s, ${condition.to}s)`;
    case 'salienceAtLeast':
      return `${condition.actorId} 显著度 ≥ ${condition.value}`;
    case 'primaryVisible':
      return '主目标在某个合法机位可见';
    case 'primaryHidden':
      return '主目标在所有合法机位不可见';
    case 'shuttersClosed':
      return '侧幕/挡板已完全闭合';
    case 'always':
      return '恒真';
  }
};

/** Replaces the asset's migration block with the live missing-ref list. */
export const withMissingRefs = (asset: RuleAsset, missing: string[]): RuleAsset =>
  asset.migration ? { ...asset, migration: { ...asset.migration, candidateRefsMissing: missing } } : asset;
