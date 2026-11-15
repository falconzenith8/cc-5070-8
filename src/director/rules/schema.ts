import { z } from 'zod';
import type { ActorAction } from '../types';

/**
 * Versioned director rule asset.
 *
 * A rule asset is the *authored* half of direction: how candidates are scored,
 * which authored situation favours which shot, and when the incumbent may be
 * left. It contains no camera geometry and no actor positions — those are
 * measured from the fixed performance every tick.
 *
 * `schemaVersion` is mandatory and is what makes an asset safe to load. The
 * migration layer (./migrate.ts) translates older shapes into this one and
 * reports anything it cannot translate instead of dropping it silently.
 */
export const RULE_SCHEMA_VERSION = 2 as const;

/** Provenance of a value that migration converted from another unit. */
export const SourceTimeSchema = z
  .object({
    unit: z.literal('ms'),
    at: z.number().min(0),
    duration: z.number().min(0),
  })
  .strict();

/**
 * A show event carried through migration so the authored identity of a beat is
 * never lost. `at` and `duration` are normalised to seconds; `source` retains
 * the pre-migration unit and values so the conversion is auditable.
 */
export const EventSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Scenario this event belongs to; keeps event identity show-scoped. */
    scenarioId: z.string().min(1),
    at: z.number().min(0),
    duration: z.number().min(0),
    durationUnit: z.literal('s'),
    source: SourceTimeSchema.optional(),
  })
  .strict();

export const ACTIONS = ['idle', 'speak', 'gesture', 'walk', 'listen', 'react'] as const satisfies
  readonly ActorAction[];

/** Score weights applied to the three measured terms. Must each be 0..1. */
export const ScoringWeightsSchema = z
  .object({
    visibility: z.number().min(0).max(1),
    composition: z.number().min(0).max(1),
    duration: z.number().min(0).max(1),
  })
  .strict();

/** A parameterised, machine-checkable condition on the current performance. */
export const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primaryAction'), action: z.enum(ACTIONS) }).strict(),
  z.object({ kind: z.literal('actorAction'), actorId: z.string().min(1), action: z.enum(ACTIONS) }).strict(),
  z.object({ kind: z.literal('beatLabel'), contains: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('beatRange'),
      /** Inclusive start, exclusive end, in seconds of performance time. */
      from: z.number().min(0),
      to: z.number().min(0),
    })
    .strict()
    .refine((v) => v.to > v.from, { message: 'beatRange.to must be greater than .from' }),
  z
    .object({
      kind: z.literal('salienceAtLeast'),
      actorId: z.string().min(1),
      value: z.number().min(0).max(1),
    })
    .strict(),
  // True when at least one *legal* camera position can see the primary's head
  // (>= 20% visible). Deliberately weaker than "a feasible shot exists": this
  // is a measurement, not a direction decision.
  z.object({ kind: z.literal('primaryVisible') }).strict(),
  z.object({ kind: z.literal('primaryHidden') }).strict(),
  z.object({ kind: z.literal('shuttersClosed') }).strict(),
  z.object({ kind: z.literal('always') }).strict(),
]);

export type RuleCondition = z.infer<typeof ConditionSchema>;

/**
 * One authored direction rule. `conditions` are ANDed. `prefer` narrows the
 * candidate domain and can override policy weights for matching frames. Neither
 * can invent a candidate or move a camera.
 */
export const RuleSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Priority when several rules match; higher wins, ties break by id. */
    priority: z.number().int(),
    conditions: z.array(ConditionSchema).min(1),
    prefer: z
      .object({
        anchors: z.array(z.enum(['primary', 'secondary', 'two-shot', 'group'])).min(1).optional(),
        lens: z.enum(['wide', 'standard', 'tight']).optional(),
        /** Minimum predicted hold, in seconds of performance time. */
        minHoldSeconds: z.number().min(0).optional(),
        /**
         * Authored candidate references, carried over from the legacy shot
         * whitelist/blacklist. Matched against the live lattice; references no
         * longer produced are reported, never silently ignored.
         *  - `allow`: matching refs receive a score bonus (advisory, because a
         *    hard whitelist would override measured feasibility).
         *  - `deny`: matching refs are removed from the feasible set.
         */
        candidateRefs: z.array(z.string().min(1)).min(1).optional(),
        refMode: z.enum(['allow', 'deny']).optional(),
      })
      .strict()
      .optional(),
    weightBias: ScoringWeightsSchema.partial().optional(),
  })
  .strict()
  .refine((r) => !r.prefer?.candidateRefs || Boolean(r.prefer.refMode), {
    message: 'prefer.candidateRefs requires prefer.refMode',
    path: ['prefer', 'refMode'],
  })
  .refine((r) => !r.prefer?.refMode || Boolean(r.prefer.candidateRefs), {
    message: 'prefer.refMode requires prefer.candidateRefs',
    path: ['prefer', 'candidateRefs'],
  })
  .refine((r) => !r.prefer?.candidateRefs || r.prefer.refMode !== 'deny' || r.prefer.candidateRefs.length > 0, {
    message: 'deny lists must name at least one candidate',
    path: ['prefer', 'candidateRefs'],
  });

/** Camera-switching policy. All durations are seconds of performance time. */
export const PolicyRuleSetSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    timeUnit: z.literal('s'),
    minHoldSeconds: z.number().min(0),
    switchMargin: z.number().min(0),
    interruptMargin: z.number().min(0),
    interruptBelowScore: z.number().min(0).max(1),
    interruptBelowSeconds: z.number().min(0),
    maxCutDeg: z.number().min(0).max(180),
    allowStopDown: z.boolean(),
    weights: ScoringWeightsSchema,
    rules: z.array(RuleSchema),
  })
  .strict();

export const RuleAssetSchema = z
  .object({
    schemaVersion: z.literal(RULE_SCHEMA_VERSION),
    assetId: z.string().min(1),
    /** Human-readable provenance, including which legacy revision this is. */
    provenance: z.string().min(1),
    notes: z.string().optional(),
    /** Performance events migrated from the legacy show. Never reordered. */
    events: z.array(EventSchema).min(1),
    policies: z.array(PolicyRuleSetSchema).min(1),
    /** What the migration changed, for auditing without re-running it. */
    migration: z
      .object({
        fromVersion: z.string().min(1),
        durationUnitFrom: z.string().min(1),
        durationUnitTo: z.literal('s'),
        conversion: z.string().min(1),
        rulesMigrated: z.number().int().min(0),
        rulesDropped: z.number().int().min(0),
        conditionsDropped: z.number().int().min(0),
        candidateRefsRetained: z.number().int().min(0),
        candidateRefsMissing: z.array(z.string()),
        /** Every legacy condition/rule the translation could not preserve. */
        unresolved: z
          .array(
            z
              .object({
                code: z.string().min(1),
                severity: z.enum(['error', 'warn']),
                path: z.string(),
                message: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ScoringWeightsAsset = z.infer<typeof ScoringWeightsSchema>;
export type SourceTime = z.infer<typeof SourceTimeSchema>;
export type EventAsset = z.infer<typeof EventSchema>;
export type RuleVec = z.infer<typeof RuleSchema>;
export type PolicyRuleSet = z.infer<typeof PolicyRuleSetSchema>;
export type RuleAsset = z.infer<typeof RuleAssetSchema>;

export interface RuleIssue {
  /** Stable, greppable code: `legacy-unsupported-condition`, `schema-invalid`, … */
  code: string;
  severity: 'error' | 'warn';
  /** Dotted path into the source document, e.g. `policies[0].rules[2].conditions[0]`. */
  path: string;
  message: string;
}

export interface RuleLoadResult {
  asset: RuleAsset;
  /** Non-empty means a caller-visible report is owed to the user. */
  issues: RuleIssue[];
  /**
   * Subset of `issues` that prevents the asset from being run or written.
   * Unsupported legacy conditions are reported but the *rest* of the asset is
   * still faithful and migratable — they are warnings-with-report, not a reason
   * to discard every policy.
   */
  blockingIssues: RuleIssue[];
  /** True when the input was in the pre-versioned `legacy` shape. */
  migrated: boolean;
  /** Version string of the *input*: `legacy` or `2`. */
  sourceVersion: string;
}

/**
 * Legacy condition kinds this build knows how to translate. Anything else in a
 * legacy asset must be reported by `migrateLegacyAsset`, never dropped quietly.
 */
export const LEGACY_CONDITION_KINDS = {
  'primary-speaks': 'primaryAction(speak)',
  'actor-action': 'actorAction(actorId, action)',
  'beat-label': 'beatLabel(contains)',
  'time-window': 'beatRange(fromMs→s, toMs→s)',
  'actor-salience': 'salienceAtLeast(actorId, value)',
  always: 'always',
} as const;
