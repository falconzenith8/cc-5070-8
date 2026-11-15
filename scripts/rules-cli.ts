/**
 * Auxiliary command-line helper for the stage shot director.
 *
 * The graphical interface is the primary entry point (npm run dev). This tool
 * exists so rule assets can be migrated, validated and inspected in a clean
 * directory or in CI, without a browser.
 *
 * Usage:
 *   npx tsx scripts/rules-cli.ts migrate [--out path] [--in legacy.json]
 *   npx tsx scripts/rules-cli.ts validate <asset.json>
 *   npx tsx scripts/rules-cli.ts report [--in legacy.json] [--scenario id]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateLegacyAsset, loadRuleAsset, isRunnable } from '../src/director/rules/migrate';
import { inspectCandidateRefs, withMissingRefs } from '../src/director/rules/engine';
import { SCENARIOS, getScenario } from '../src/director/scenarios';
import { getStage } from '../src/director/stage';
import type { LegacyShow } from '../src/director/rules/legacy';
import type { RuleIssue, RuleLoadResult } from '../src/director/rules/schema';

const args = process.argv.slice(2);
const command = args[0] ?? 'report';

const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const positional = args.slice(1).filter((a, i) => !a.startsWith('--') && !args[i]?.startsWith('--'));

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const formatIssues = (issues: RuleIssue[]): string => {
  if (issues.length === 0) return '  无问题。';
  return issues
    .map((i) => `  [${i.severity}] ${i.code} @ ${i.path || '(root)'}\n      ${i.message}`)
    .join('\n');
};

const loadInput = (): RuleLoadResult => {
  const inputPath = option('--in');
  if (!inputPath) return migrateLegacyAsset();
  const input = readJson(inputPath);
  // A legacy document is migrated; a v2 document is validated as-is.
  const looksLegacy =
    typeof input === 'object' && input !== null && (input as Record<string, unknown>).revision === 'legacy';
  if (looksLegacy) {
    const result = migrateLegacyAsset(input as LegacyShow);
    return result;
  }
  return loadRuleAsset(input);
};

const attachMissingRefs = (result: RuleLoadResult, scenarioIds: string[]): { asset: RuleLoadResult['asset']; issues: RuleIssue[] } => {
  let asset = result.asset;
  const issues: RuleIssue[] = [];
  const seen = new Set<string>();
  for (const id of scenarioIds) {
    const scenario = getScenario(id);
    const refIssues = inspectCandidateRefs(asset, scenario, getStage(id));
    for (const issue of refIssues) {
      // The same stale ref is missing in every scenario; report it once.
      if (seen.has(issue.message)) continue;
      seen.add(issue.message);
      issues.push(issue);
    }
    const missing = refIssues
      .map((i) => /候选 (\S+) 在当前场景/.exec(i.message)?.[1])
      .filter((x): x is string => Boolean(x));
    if (missing.length > 0) asset = withMissingRefs(asset, [...new Set([...(asset.migration?.candidateRefsMissing ?? []), ...missing])]);
  }
  return { asset, issues };
};

const printReport = (result: RuleLoadResult, scenarioIds: string[]) => {
  const { asset, issues } = attachMissingRefs(result, scenarioIds);
  console.log(`规则资产 ${asset.assetId}`);
  console.log(`  schemaVersion: ${asset.schemaVersion}  (source: ${result.sourceVersion})`);
  console.log(`  provenance: ${asset.provenance}`);
  if (asset.migration) {
    console.log(
      `  migration: ${asset.migration.fromVersion} → v${asset.schemaVersion}; ` +
        `durationUnit ${asset.migration.durationUnitFrom} → ${asset.migration.durationUnitTo}; ` +
        `rules +${asset.migration.rulesMigrated} / -${asset.migration.rulesDropped}; ` +
        `candidateRefs ${asset.migration.candidateRefsRetained}`,
    );
  }
  console.log('  事件（持续时间单位 s）:');
  for (const e of asset.events) {
    const src = e.source ? `（原始 ${e.source.at}ms + ${e.source.duration}ms）` : '';
    console.log(`    - ${e.id}: ${e.label} @${e.at}s +${e.duration}s${src}`);
  }
  console.log('  策略:');
  for (const p of asset.policies) {
    console.log(
      `    - ${p.id} ${p.label}: 最短保持 ${p.minHoldSeconds}s，中断宽限 ${p.interruptBelowSeconds}s，规则 ${p.rules.length} 条`,
    );
  }
  console.log('  迁移与校验问题:');
  console.log(formatIssues([...result.issues, ...issues]));
};

switch (command) {
  case 'migrate': {
    const result = loadInput();
    const out = option('--out');
    if (!isRunnable(result)) {
      console.error('迁移存在阻断性错误，拒绝写出资产：');
      console.error(formatIssues(result.blockingIssues));
      process.exitCode = 2;
      break;
    }
    if (!out) {
      console.log(JSON.stringify(result.asset, null, 2));
      break;
    }
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(result.asset, null, 2)}\n`, 'utf8');
    console.log(`已写出 ${target}（schemaVersion ${result.asset.schemaVersion}）`);
    // Warnings and dropped legacy conditions are printed, never suppressed.
    console.log(formatIssues(result.issues));
    if (result.issues.length > 0) {
      console.log(`注意：${result.issues.length} 条旧条件/引用问题已在报告中列出，资产其余部分照常迁移。`);
    }
    break;
  }
  case 'validate': {
    const path = positional[0];
    if (!path) {
      console.error('用法: rules-cli.ts validate <asset.json>');
      process.exitCode = 2;
      break;
    }
    const result = loadRuleAsset(readJson(resolve(path)));
    console.log(formatIssues(result.issues));
    if (!isRunnable(result)) process.exitCode = 2;
    break;
  }
  case 'report':
  default: {
    const result = loadInput();
    const scenarioIds = option('--scenario') ? [option('--scenario')!] : SCENARIOS.map((s) => s.id);
    printReport(result, scenarioIds);
    if (!isRunnable(result)) process.exitCode = 2;
    break;
  }
}
