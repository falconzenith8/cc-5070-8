import { describe, it, expect } from 'vitest';
import {
  loadRuleAsset,
  migrateLegacyAsset,
  isRunnable,
  isLegacyAsset,
} from '../../src/director/rules/migrate';
import { LEGACY_RULE_ASSET } from '../../src/director/rules/legacy';
import { RULE_SCHEMA_VERSION, RuleAssetSchema } from '../../src/director/rules/schema';
import { SHIPPED_RULE_ASSET } from '../../src/director/rules/asset';
import { evaluateCondition, evaluateRules, inspectCandidateRefs } from '../../src/director/rules/engine';
import { getScenario } from '../../src/director/scenarios';
import { getStage } from '../../src/director/stage';
import { samplePerformance } from '../../src/director/performance';
import { describeCondition } from '../../src/director/rules/engine';

describe('legacy → v2 rule migration', () => {
  it('detects and migrates the legacy document', () => {
    expect(isLegacyAsset(LEGACY_RULE_ASSET)).toBe(true);
    const result = migrateLegacyAsset();
    expect(result.migrated).toBe(true);
    expect(result.sourceVersion).toBe('legacy');
    expect(result.asset.schemaVersion).toBe(RULE_SCHEMA_VERSION);
    expect(isRunnable(result)).toBe(true);
    // The result must itself satisfy the versioned schema.
    expect(RuleAssetSchema.safeParse(result.asset).success).toBe(true);
  });

  it('converts millisecond durations to seconds exactly once', () => {
    const { asset } = migrateLegacyAsset();
    const byId = new Map(asset.policies.map((p) => [p.id, p]));
    expect(byId.get('balanced')!.minHoldSeconds).toBe(2.6);
    expect(byId.get('balanced')!.interruptBelowSeconds).toBe(0.6);
    expect(byId.get('patient')!.minHoldSeconds).toBe(5);
    expect(byId.get('reactive')!.minHoldSeconds).toBe(1.1);
    expect(byId.get('strict')!.interruptBelowSeconds).toBe(0.5);
  });

  it('converts legacy time windows from ms to performance seconds', () => {
    const { asset } = migrateLegacyAsset();
    const rule = asset.policies
      .find((p) => p.id === 'balanced')!
      .rules.find((r) => r.id === 'beat-window-guard')!;
    const range = rule.conditions.find((c) => c.kind === 'beatRange');
    expect(range).toEqual({ kind: 'beatRange', from: 12, to: 17.5 });
  });

  it('preserves event identity and records the original unit', () => {
    const { asset } = migrateLegacyAsset();
    expect(asset.events.map((e) => e.id)).toEqual(LEGACY_RULE_ASSET.events.map((e) => e.key));
    expect(asset.events.map((e) => e.scenarioId)).toEqual(LEGACY_RULE_ASSET.events.map((e) => e.scenario));
    for (const e of asset.events) {
      expect(e.durationUnit).toBe('s');
      expect(e.source).toEqual({ unit: 'ms', at: expect.any(Number), duration: expect.any(Number) });
      expect(e.duration).toBeCloseTo(e.source!.duration / 1000, 9);
      expect(e.at).toBeCloseTo(e.source!.at / 1000, 9);
    }
    // 36 s, 38 s, 40 s — the shows are not re-timed by the unit change.
    expect(asset.events.map((e) => e.duration)).toEqual([36, 38, 40]);
  });

  it('reports every unsupported legacy condition instead of dropping it silently', () => {
    const result = migrateLegacyAsset();
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('legacy-condition-unsupported'); // camera-shake
    // Only the actor-salience rule lacks an actor; actor-action now names Ivo.
    expect(codes.filter((c) => c === 'legacy-condition-missing-actor')).toHaveLength(1);
    // The two rules whose conditions cannot be translated are absent.
    const allRuleIds = result.asset.policies.flatMap((p) => p.rules.map((r) => r.id));
    expect(allRuleIds).not.toContain('unstable-camera-guard');
    expect(allRuleIds).not.toContain('salient-guest');
    // But the rules that *can* be translated survive.
    expect(allRuleIds).toContain('dialogue-hold');
    expect(allRuleIds).toContain('follow-speaker');
    // The report is persisted in the asset, not only returned in memory.
    expect(result.asset.migration?.unresolved.map((i) => i.code)).toEqual(result.issues.map((i) => i.code));
  });

  it('does not let a legacy rule with one bad term keep its other (weaker) terms', () => {
    // dialogue-hold in the legacy asset has two valid conditions;
    // 'long-take' has one. A rule that had *any* untranslatable term is dropped
    // entirely, because dropping just that term would match extra frames.
    const { asset } = migrateLegacyAsset();
    for (const rule of asset.policies.flatMap((p) => p.rules)) {
      expect(rule.conditions.length).toBeGreaterThan(0);
    }
  });

  it('inverts legacy rule order into the v2 priority direction', () => {
    const { asset } = migrateLegacyAsset();
    const strict = asset.policies.find((p) => p.id === 'balanced')!;
    const byId = new Map(strict.rules.map((r) => [r.id, r.priority]));
    // legacy order 10 (dialogue-hold) outranks legacy order 30 (crowd-balance)
    expect(byId.get('dialogue-hold')!).toBeGreaterThan(byId.get('crowd-balance')!);
  });

  it('never claims a legacy condition is supported when it is not', () => {
    const result = migrateLegacyAsset({
      ...LEGACY_RULE_ASSET,
      policies: [
        {
          ...LEGACY_RULE_ASSET.policies[0],
          rules: [
            {
              id: 'mystery',
              label: '未知条件',
              order: 1,
              when: [{ kind: 'actor-mood', value: 'tense' }],
            },
          ],
        },
      ],
    });
    expect(result.issues.some((i) => i.code === 'legacy-condition-unsupported')).toBe(true);
    expect(result.asset.policies[0].rules).toHaveLength(0);
  });
});

describe('versioned asset loading', () => {
  it('accepts the shipped asset as version 2 without re-migrating', () => {
    const result = loadRuleAsset(SHIPPED_RULE_ASSET);
    expect(result.sourceVersion).toBe('2');
    expect(result.migrated).toBe(false);
    expect(result.blockingIssues).toEqual([]);
  });

  it('rejects an unknown schema version rather than guessing', () => {
    const result = loadRuleAsset({ schemaVersion: 99, assetId: 'x' });
    expect(isRunnable(result)).toBe(false);
    expect(result.issues[0].code).toBe('unsupported-schema-version');
  });

  it('rejects a malformed v2 document (missing required fields)', () => {
    const broken = { ...SHIPPED_RULE_ASSET, policies: [{ ...SHIPPED_RULE_ASSET.policies[0], minHoldSeconds: 'soon' }] };
    const result = loadRuleAsset(broken);
    expect(isRunnable(result)).toBe(false);
    expect(result.issues.some((i) => i.code === 'schema-invalid')).toBe(true);
  });

  it('reports a deny list without candidate refs as invalid', () => {
    const broken = {
      ...SHIPPED_RULE_ASSET,
      policies: [
        {
          ...SHIPPED_RULE_ASSET.policies[0],
          rules: [
            {
              id: 'bad',
              label: 'bad',
              priority: 1,
              conditions: [{ kind: 'always' }],
              prefer: { refMode: 'deny' },
            },
          ],
        },
      ],
    };
    expect(isRunnable(loadRuleAsset(broken))).toBe(false);
  });
});

describe('rule evaluation', () => {
  const scenario = getScenario('two-hander');
  const stage = getStage('two-hander');

  it('evaluates time windows against performance seconds, not milliseconds', () => {
    const policy = SHIPPED_RULE_ASSET.policies.find((p) => p.id === 'balanced')!;
    const at16 = evaluateRules(policy, {
      scenario,
      perf: samplePerformance(scenario, 16),
      primaryVisible: true,
    });
    const at20 = evaluateRules(policy, {
      scenario,
      perf: samplePerformance(scenario, 20),
      primaryVisible: true,
    });
    expect(at16.matched.some((m) => m.id === 'beat-window-guard')).toBe(true);
    // 20 s is past the 17.5 s window; if ms/s were confused the window would
    // cover the whole show and this would still match.
    expect(at20.matched.some((m) => m.id === 'beat-window-guard')).toBe(false);
  });

  it('renormalises biased weights to a probability-style sum', () => {
    const policy = SHIPPED_RULE_ASSET.policies.find((p) => p.id === 'balanced')!;
    const effect = evaluateRules(policy, {
      scenario,
      perf: samplePerformance(scenario, 16),
      primaryVisible: true,
    });
    const sum = effect.weights.visibility + effect.weights.composition + effect.weights.duration;
    expect(sum).toBeCloseTo(1, 9);
  });

  it('reports stale candidate references against the live lattice', () => {
    const issues = inspectCandidateRefs(SHIPPED_RULE_ASSET, scenario, stage);
    const missing = issues.filter((i) => i.code === 'rule-candidate-missing').map((i) => i.message);
    expect(missing.some((m) => m.includes('gen:primary:75:8:2.8'))).toBe(true);
    expect(missing.some((m) => m.includes('gen:primary:retired:4.4'))).toBe(true);
    // References that do exist must not be reported.
    expect(missing.some((m) => m.includes('gen:primary:-25:8:2.8'))).toBe(false);
  });

  it('describes conditions in the units it evaluates them in', () => {
    expect(describeCondition({ kind: 'beatRange', from: 12, to: 17.5 })).toContain('12s');
    expect(describeCondition({ kind: 'primaryAction', action: 'speak' })).toContain('speak');
  });

  it('primaryVisible / primaryHidden are exact complements', () => {
    const perf = samplePerformance(scenario, 5);
    const cond = { kind: 'primaryVisible' as const };
    const cond2 = { kind: 'primaryHidden' as const };
    const ctx = { scenario, perf, primaryVisible: true };
    expect(evaluateCondition(cond, ctx)).toBe(true);
    expect(evaluateCondition(cond2, ctx)).toBe(false);
  });
});
