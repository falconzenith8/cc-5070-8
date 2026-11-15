import {
  RuleAssetSchema,
  RULE_SCHEMA_VERSION,
  type EventAsset,
  type PolicyRuleSet,
  type RuleAsset,
  type RuleCondition,
  type RuleIssue,
  type RuleLoadResult,
  type RuleVec,
} from './schema';
import {
  LEGACY_RULE_ASSET,
  isActorAction,
  type LegacyCondition,
  type LegacyPolicy,
  type LegacyShow,
  type LegacyRule,
} from './legacy';

const MS_PER_SECOND = 1000;

const secondsFromMs = (ms: number): number => ms / MS_PER_SECOND;

/** Collect rule issues rather than throwing on the first one: migration reports all. */
class IssueLog {
  readonly issues: RuleIssue[] = [];
  error(code: string, path: string, message: string) {
    this.issues.push({ code, severity: 'error', path, message });
  }
  warn(code: string, path: string, message: string) {
    this.issues.push({ code, severity: 'warn', path, message });
  }
}

interface ConditionTranslation {
  condition: RuleCondition | null;
  /** Rule must be dropped: a conjunction loses meaning if a term is removed. */
  fatal: boolean;
}

const translateCondition = (
  legacy: LegacyCondition,
  path: string,
  log: IssueLog,
): ConditionTranslation => {
  switch (legacy.kind) {
    case 'primary-speaks': {
      if (legacy.action !== undefined) {
        log.error(
          'legacy-condition-unsupported-field',
          path,
          `旧条件 primary-speaks 不接受 action="${legacy.action}"，无法保持原语义。`,
        );
        return { condition: null, fatal: true };
      }
      return { condition: { kind: 'primaryAction', action: 'speak' }, fatal: false };
    }
    case 'actor-action': {
      if (!legacy.actor) {
        // The legacy tag identified the action but not who performs it. Guessing
        // an actor would silently change which frames the rule applies to.
        log.error(
          'legacy-condition-missing-actor',
          path,
          `旧条件 actor-action 缺少 actor，无法确定作用对象，规则未迁移。`,
        );
        return { condition: null, fatal: true };
      }
      if (!legacy.action || !isActorAction(legacy.action)) {
        log.error(
          'legacy-condition-bad-action',
          path,
          `旧条件 actor-action 的 action="${legacy.action ?? ''}" 不是合法动作。`,
        );
        return { condition: null, fatal: true };
      }
      return {
        condition: { kind: 'actorAction', actorId: legacy.actor, action: legacy.action },
        fatal: false,
      };
    }
    case 'beat-label': {
      if (typeof legacy.value !== 'string' || legacy.value.length === 0) {
        log.error('legacy-condition-bad-value', path, '旧条件 beat-label 缺少文本 value。');
        return { condition: null, fatal: true };
      }
      return { condition: { kind: 'beatLabel', contains: legacy.value }, fatal: false };
    }
    case 'time-window': {
      const { fromMs, toMs } = legacy;
      if (typeof fromMs !== 'number' || typeof toMs !== 'number' || !(toMs > fromMs)) {
        log.error(
          'legacy-condition-bad-window',
          path,
          `旧条件 time-window 需要 fromMs < toMs，收到 ${String(fromMs)}..${String(toMs)}。`,
        );
        return { condition: null, fatal: true };
      }
      // Unit conversion happens here, exactly once: ms in, seconds out.
      return {
        condition: { kind: 'beatRange', from: secondsFromMs(fromMs), to: secondsFromMs(toMs) },
        fatal: false,
      };
    }
    case 'actor-salience': {
      if (typeof legacy.value !== 'number' || legacy.value < 0 || legacy.value > 1) {
        log.error('legacy-condition-bad-value', path, '旧条件 actor-salience 需要 0..1 的阈值。');
        return { condition: null, fatal: true };
      }
      if (!legacy.actor) {
        log.error(
          'legacy-condition-missing-actor',
          path,
          '旧条件 actor-salience 缺少 actor，无法确定作用对象，规则未迁移。',
        );
        return { condition: null, fatal: true };
      }
      return {
        condition: { kind: 'salienceAtLeast', actorId: legacy.actor, value: legacy.value },
        fatal: false,
      };
    }
    case 'primary-available':
      return { condition: { kind: 'primaryVisible' }, fatal: false };
    case 'primary-unavailable':
      return { condition: { kind: 'primaryHidden' }, fatal: false };
    case 'shutters-closed':
      return { condition: { kind: 'shuttersClosed' }, fatal: false };
    case 'always':
      return { condition: { kind: 'always' }, fatal: false };
    default:
      log.error(
        'legacy-condition-unsupported',
        path,
        `旧条件 kind="${legacy.kind}" 在 v${RULE_SCHEMA_VERSION} 中没有等价表达，规则未迁移。`,
      );
      return { condition: null, fatal: true };
  }
};

const LEGACY_SHOT_TO_LENS: Record<NonNullable<LegacyRule['shot']>, 'wide' | 'standard' | 'tight'> = {
  wide: 'wide',
  medium: 'standard',
  'close-up': 'tight',
};

const translateRule = (
  legacy: LegacyRule,
  path: string,
  log: IssueLog,
  stats: { migrated: number; dropped: number; conditionsDropped: number; candidateRefs: number },
): RuleVec | null => {
  const conditions: RuleCondition[] = [];
  for (let i = 0; i < legacy.when.length; i++) {
    const translated = translateCondition(legacy.when[i], `${path}.conditions[${i}]`, log);
    if (translated.condition) conditions.push(translated.condition);
    // A conjunction missing a term matches *more* frames than authored; dropping
    // the rule and reporting is the only faithful option.
    if (translated.fatal) {
      stats.dropped += 1;
      stats.conditionsDropped += legacy.when.length - conditions.length;
      return null;
    }
  }
  if (conditions.length === 0) {
    log.error('legacy-rule-empty', path, '旧规则没有任何可迁移条件，规则未迁移。');
    stats.dropped += 1;
    return null;
  }

  let lens: 'wide' | 'standard' | 'tight' | undefined;
  if (legacy.shot === 'close-up') {
    log.warn(
      'legacy-shot-approximated',
      `${path}.prefer.lens`,
      '旧 shot="close-up" 没有一对一镜头档位，已映射为最接近的 tight。',
    );
    lens = 'tight';
  } else if (legacy.shot) {
    lens = LEGACY_SHOT_TO_LENS[legacy.shot];
  }

  if (legacy.rationale) {
    // Free-text rationale has no machine meaning; keep it visible to the
    // operator instead of quietly discarding authored intent.
    log.warn('legacy-rule-rationale', `${path}.rationale`, `旧规则附注：${legacy.rationale}`);
  }
  if (legacy.allowedShots) stats.candidateRefs += legacy.allowedShots.length;
  stats.migrated += 1;

  // A legacy `veto` rule's whitelist described the only cells it permitted:
  // translating it as an allow-list preserves that exactly. Other whitelists
  // were preferences and stay allow-lists too; none become a deny-list.
  const refMode: 'allow' | 'deny' = 'allow';
  const prefer = {
    ...(lens ? { lens } : {}),
    ...(legacy.allowedShots ? { candidateRefs: [...legacy.allowedShots], refMode } : {}),
  };

  return {
    id: legacy.id,
    label: legacy.label,
    // Legacy order is "lower number wins"; v2 priority is "higher wins".
    priority: 100 - legacy.order,
    conditions,
    ...(Object.keys(prefer).length > 0 ? { prefer } : {}),
    ...(legacy.weightBias ? { weightBias: legacy.weightBias } : {}),
  };
};

const translatePolicy = (
  legacy: LegacyPolicy,
  path: string,
  log: IssueLog,
  stats: { migrated: number; dropped: number; conditionsDropped: number; candidateRefs: number },
): PolicyRuleSet => {
  const rules: RuleVec[] = [];
  for (let i = 0; i < legacy.rules.length; i++) {
    const migrated = translateRule(legacy.rules[i], `${path}.rules[${i}]`, log, stats);
    if (migrated) rules.push(migrated);
  }
  return {
    id: legacy.id,
    label: legacy.name,
    description: legacy.blurb,
    timeUnit: 's',
    minHoldSeconds: secondsFromMs(legacy.minHoldMs),
    switchMargin: legacy.switchMargin,
    interruptMargin: legacy.interruptMargin,
    interruptBelowScore: legacy.interruptBelowScore,
    interruptBelowSeconds: secondsFromMs(legacy.interruptBelowMs),
    maxCutDeg: legacy.maxCutDeg,
    allowStopDown: legacy.allowStopDown,
    weights: { ...legacy.weights },
    rules,
  };
};

const translateEvents = (legacy: LegacyShow, log: IssueLog): EventAsset[] => {
  const seen = new Set<string>();
  const events: EventAsset[] = legacy.events.map((e, i) => {
    if (seen.has(e.key)) {
      log.error('legacy-event-duplicate-id', `events[${i}]`, `旧事件 key="${e.key}" 重复。`);
    }
    seen.add(e.key);
    if (e.lengthMs <= 0) {
      log.error('legacy-event-bad-duration', `events[${i}]`, '旧事件 lengthMs 必须为正。');
    }
    return {
      id: e.key,
      label: e.name,
      scenarioId: e.scenario,
      // Unit conversion once, at the boundary. Seconds are the runtime unit.
      at: secondsFromMs(e.startMs),
      duration: secondsFromMs(e.lengthMs),
      durationUnit: 's',
      source: { unit: 'ms', at: e.startMs, duration: e.lengthMs },
    };
  });
  // Identity check: order and ids must survive translation unchanged.
  const sameLength = events.length === legacy.events.length;
  const sameOrder = events.every((e, i) => e.id === legacy.events[i].key);
  if (!sameLength || !sameOrder) {
    log.error('legacy-event-identity-lost', 'events', '事件身份未能在迁移中保持。');
  }
  return events;
};

/** True when the document is the pre-versioned shape. */
export const isLegacyAsset = (input: unknown): input is LegacyShow => {
  if (!input || typeof input !== 'object') return false;
  const o = input as Record<string, unknown>;
  return o.format === 'stage-director-rules' && o.revision === 'legacy';
};

/**
 * Converts a legacy show to the versioned rule asset. Unsupported legacy
 * conditions are reported as errors and the containing rule is omitted, so the
 * result never contains a rule with silently weakened meaning.
 */
export const migrateLegacyAsset = (legacy: LegacyShow = LEGACY_RULE_ASSET): RuleLoadResult => {
  const log = new IssueLog();
  const stats = { migrated: 0, dropped: 0, conditionsDropped: 0, candidateRefs: 0 };
  const events = translateEvents(legacy, log);
  const policies = legacy.policies.map((p, i) => translatePolicy(p, `policies[${i}]`, log, stats));

  const candidateRefs = new Set<string>();
  for (const p of policies) {
    for (const r of p.rules) for (const id of r.prefer?.candidateRefs ?? []) candidateRefs.add(id);
  }

  const candidate: RuleAsset = {
    schemaVersion: RULE_SCHEMA_VERSION,
    assetId: legacy.showId,
    provenance: `migrated from legacy revision "${legacy.revision}" (durations ms→s, priority order→100-order)`,
    notes:
      '每个旧规则都经过条件翻译；无法表达的条件已作为 error 报告，对应规则未迁移。' +
      '事件 at/duration 已换算为秒，source 保留原始毫秒值。',
    events,
    policies,
    migration: {
      fromVersion: 'legacy',
      durationUnitFrom: 'ms',
      durationUnitTo: 's',
      conversion: 'seconds = milliseconds / 1000; priority = 100 - legacy.order',
      rulesMigrated: stats.migrated,
      rulesDropped: stats.dropped,
      conditionsDropped: stats.conditionsDropped,
      candidateRefsRetained: candidateRefs.size,
      // Filled in by the runtime against the live lattice; empty at load time.
      candidateRefsMissing: [],
      // Persist the migration report itself, so a shipped asset states what was
      // dropped instead of relying on a console that CI never sees.
      unresolved: log.issues.map((i) => ({ ...i })),
    },
  };

  const parsed = RuleAssetSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      log.error('schema-invalid', issue.path.join('.'), issue.message);
    }
    // Return the unvalidated candidate so callers can still render the report;
    // the rule loader refuses to run an asset that failed validation.
    return {
      asset: candidate,
      issues: log.issues,
      blockingIssues: log.issues.filter((i) => i.severity === 'error'),
      migrated: true,
      sourceVersion: 'legacy',
    };
  }
  return {
    asset: parsed.data,
    issues: log.issues,
    // Schema-level errors block; the reported legacy gaps above do not, because
    // they concern omitted rules rather than an unreadable asset.
    blockingIssues: [],
    migrated: true,
    sourceVersion: 'legacy',
  };
};

/**
 * Loads a rule asset from untrusted JSON. Accepts the versioned v2 shape or the
 * legacy document, which is migrated. Any other version is reported, not
 * guessed at.
 */
export const loadRuleAsset = (input: unknown): RuleLoadResult => {
  if (isLegacyAsset(input)) return migrateLegacyAsset(input);

  if (input && typeof input === 'object') {
    const version = (input as Record<string, unknown>).schemaVersion;
    if (version === RULE_SCHEMA_VERSION) {
      const parsed = RuleAssetSchema.safeParse(input);
      if (!parsed.success) {
        const issues: RuleIssue[] = parsed.error.issues.map((issue) => ({
          code: 'schema-invalid',
          severity: 'error' as const,
          path: issue.path.join('.'),
          message: issue.message,
        }));
        // Preserve the raw document for reporting; callers must not run it.
        return {
          asset: input as RuleAsset,
          issues,
          blockingIssues: issues,
          migrated: false,
          sourceVersion: String(version),
        };
      }
      return { asset: parsed.data, issues: [], blockingIssues: [], migrated: false, sourceVersion: String(version) };
    }
    const issues: RuleIssue[] = [
      {
        code: 'unsupported-schema-version',
        severity: 'error',
        path: 'schemaVersion',
        message: `不支持的规则资产版本 ${String(version)}；本构建只接受 ${RULE_SCHEMA_VERSION} 或 legacy 文档。`,
      },
    ];
    return {
      asset: input as RuleAsset,
      issues,
      blockingIssues: issues,
      migrated: false,
      sourceVersion: String(version),
    };
  }

  const issues: RuleIssue[] = [
    {
      code: 'unreadable-asset',
      severity: 'error',
      path: '',
      message: '规则资产无法识别：既不是 versioned 文档，也不是 legacy 演出文档。',
    },
  ];
  return {
    asset: LEGACY_RULE_ASSET as unknown as RuleAsset,
    issues,
    blockingIssues: issues,
    migrated: false,
    sourceVersion: 'unknown',
  };
};

/** Convenience: the migrated asset the runtime ships with. */
export const DEFAULT_RULE_ASSET: RuleAsset = migrateLegacyAsset().asset;

/** True when the asset passed schema validation and may be run or written. */
export const isRunnable = (result: RuleLoadResult): boolean => result.blockingIssues.length === 0;
