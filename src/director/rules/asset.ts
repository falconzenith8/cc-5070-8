import assetDocument from '../../../assets/rules/stage-director.rules.v2.json';
import { loadRuleAsset } from './migrate';
import type { RuleAsset, RuleIssue, RuleLoadResult } from './schema';

/**
 * The rule asset shipped with the build. It is read from the checked-in JSON
 * (never re-migrated at runtime), so what the director runs is exactly what was
 * reviewed and committed. `loadRuleAsset` re-validates it on import: a corrupted
 * or hand-edited asset fails loudly instead of directing the show.
 */
export const SHIPPED_RULE_ASSET_RESULT: RuleLoadResult = loadRuleAsset(assetDocument);

export const SHIPPED_RULE_ASSET: RuleAsset = SHIPPED_RULE_ASSET_RESULT.asset;

/** Migration issues recorded inside the asset when it was produced. */
export const SHIPPED_MIGRATION_ISSUES: RuleIssue[] = SHIPPED_RULE_ASSET.migration?.unresolved ?? [];

export const SHIPPED_ASSET_PROBLEMS: RuleIssue[] = SHIPPED_RULE_ASSET_RESULT.issues;
