import type { CandidateEvaluation, DirectorDecision, DirectorFrame, DirectorWarning } from '../director/types';

export const DECISION_LABELS: Record<DirectorDecision['type'], { label: string; cls: string }> = {
  start: { label: '开演首个镜头', cls: 'ok' },
  cut: { label: '按评分切换', cls: 'ok' },
  hold: { label: '保持当前镜头', cls: 'hold' },
  interrupt: { label: '必要中断', cls: 'interrupt' },
  'keep-no-alternatives': { label: '无更优解·保持', cls: 'hold' },
  'fallback-safety': { label: '降级安全机位', cls: 'fallback' },
  'fallback-black': { label: '黑场', cls: 'error' },
  recover: { label: '恢复', cls: 'ok' },
  none: { label: '—', cls: 'hold' },
};

export const warningClass = (w: DirectorWarning): string =>
  w.severity === 'error' ? 'w-error' : w.severity === 'warn' ? 'w-warn' : 'w-info';

export const formatWarning = (w: DirectorWarning): string => `[${w.severity}] ${w.message}`;

const bar = (label: string, value: number, max = 1): string => {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return `<div class="bar-row"><span>${label}</span><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><b>${(value * 100).toFixed(0)}</b></div>`;
};

export const candidateRow = (c: CandidateEvaluation, onAirId: string | null, selectedId: string | null): string => {
  const isOnAir = c.id === onAirId;
  const isSel = c.id === selectedId;
  const verdict = c.feasible
    ? `<span class="chip ok">可行</span>`
    : `<span class="chip bad">淘汰</span>`;
  const reason = c.feasible ? c.summary : c.rejectReason;
  const cls = ['cand', isOnAir ? 'on-air' : '', isSel ? 'selected' : '', c.feasible ? '' : 'rejected'].join(' ');
  return `
    <button class="${cls}" data-cand="${c.id}" type="button">
      <div class="cand-head">
        <span class="cand-id">${c.id.replace(/^gen:/, '')}</span>
        ${verdict}
        ${isOnAir ? '<span class="chip air">播出中</span>' : ''}
      </div>
      <div class="cand-title">${escapeHtml(c.label)}</div>
      <div class="cand-scores">
        ${bar('可见', c.scores.visibility)}
        ${bar('构图', c.scores.composition)}
        ${bar('保持', c.scores.duration)}
        <div class="total">综合 <b>${(c.scores.total * 100).toFixed(1)}</b></div>
      </div>
      <div class="cand-reason">${escapeHtml(reason)}</div>
      <div class="cand-feats">
        <span>画高 ${(c.features.screenHeightFrac * 100).toFixed(0)}%</span>
        <span>头余 ${(c.features.headroom * 100).toFixed(0)}%</span>
        <span>保持 ${c.features.holdSeconds.toFixed(1)}s</span>
        <span>正脸 ${(c.features.faceScore * 100).toFixed(0)}%</span>
        <span>主目标可见 ${(c.features.primaryVisibility * 100).toFixed(0)}%</span>
      </div>
    </button>`;
};

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Diagnostics {
  cardHtml: string;
  metaHtml: string;
  warningsHtml: string;
}

export const buildDiagnostics = (f: DirectorFrame): Diagnostics => {
  const d = DECISION_LABELS[f.decision.type];
  const best = f.decision.bestScore;
  const live = f.decision.liveScore;
  const delta = best - live;
  const feasible = f.feasibleCount;
  const total = f.candidates.filter((c) => c.kind === 'generated').length;

  const cardHtml = `
    <div class="decision-head">
      <span class="dec-badge ${d.cls}">${d.label}</span>
      <span class="dec-time">t=${f.time.toFixed(2)}s</span>
    </div>
    <div class="dec-grid">
      <div><span>当前镜头</span><b>${f.onAir ? escapeHtml(f.onAir.label) : '—'}</b></div>
      <div><span>机位角色</span><b>${
        f.onAir ? ({ primary: '主目标位', substitute: '替代位', safety: '安全位' } as const)[f.onAir.role] : '—'
      }</b></div>
      <div><span>在场时长</span><b>${f.shotAge.toFixed(1)}s</b></div>
      <div><span>可行候选</span><b>${feasible} / ${total}</b></div>
      <div><span>当前评分</span><b>${(live * 100).toFixed(1)}</b></div>
      <div><span>最佳评分</span><b>${(best * 100).toFixed(1)} <em class="delta ${delta > 0 ? 'neg' : ''}">${
        delta > 0.0005 ? `(−${(delta * 100).toFixed(1)} 未切)` : ''
      }</em></b></div>
      <div><span>主目标可达</span><b class="${f.primaryAvailable ? 'ok-t' : 'bad-t'}">${f.primaryAvailable ? '是' : '否'}</b></div>
      <div><span>策略</span><b>${escapeHtml(f.policyLabel)}</b></div>
    </div>
    <div class="dec-bar">
      <div class="dec-live" style="width:${(live * 100).toFixed(1)}%"></div>
      <div class="dec-best" style="width:${(Math.max(0, best) * 100).toFixed(1)}%"></div>
    </div>
    <p class="dec-meta">主目标：${escapeHtml(primaryName(f))} · 本拍：${escapeHtml(f.perf.beatLabel)}</p>
  `;

  const metaHtml = `
    <div><span>决策类型</span><b>${f.decision.type}</b></div>
    <div><span>是否剪切</span><b>${f.decision.cut ? '是' : '否'}</b></div>
    <div><span>中断标记</span><b>${f.decision.interruption ? escapeHtml(f.decision.interruption) : '—'}</b></div>
    <div><span>本轮累计切换</span><b>${f.switchesThisRun}</b></div>
    <div><span>最佳候选</span><b>${f.decision.bestCandidateId ? escapeHtml(f.decision.bestCandidateId.replace(/^gen:/, '')) : '—'}</b></div>
    <div><span>镜头编号</span><b>${f.onAir ? `#${f.onAir.shotId}` : '—'}</b></div>
  `;

  const warningsHtml =
    f.warnings.length === 0
      ? `<p class="no-warn">无异常：所有候选与机位均通过几何与可见性校验。</p>`
      : f.warnings.map((w) => `<p class="${warningClass(w)}">${escapeHtml(w.message)}</p>`).join('');

  return { cardHtml, metaHtml, warningsHtml };
};

const primaryName = (f: DirectorFrame): string =>
  f.perf.actors.find((a) => a.id === f.perf.primaryId)?.name ?? f.perf.primaryId;

export const shotListItem = (
  shot: {
    shotId: number;
    label: string;
    startedAt: number;
    role: string;
    target: string;
    selectionReason: string;
  },
): string => `
  <li>
    <span class="shot-num">#${shot.shotId}</span>
    <div>
      <div class="shot-title">${escapeHtml(shot.label)}</div>
      <div class="shot-meta">t=${shot.startedAt.toFixed(1)}s · ${escapeHtml(shot.target)} · ${escapeHtml(shot.role)}</div>
      <div class="shot-reason">${escapeHtml(shot.selectionReason)}</div>
    </div>
  </li>`;

export const cutLogItem = (time: number, type: string, interruption: string | null, reason: string, label: string): string => `
  <li class="${interruption ? 'is-interrupt' : ''}">
    <span class="cut-time">${time.toFixed(2)}s</span>
    <div>
      <div class="cut-title">${escapeHtml(type)}${interruption ? ` · ${escapeHtml(interruption)}` : ''}</div>
      <div class="cut-shot">→ ${escapeHtml(label)}</div>
      <div class="cut-reason">${escapeHtml(reason)}</div>
    </div>
  </li>`;

export const toCsv = (log: import('../director/replay').ReplayLog): string => {
  const rows = [
    ['shot_id', 'started_at', 'label', 'candidate_id', 'role', 'target', 'selection_reason'].join(','),
  ];
  for (const s of log.shots) {
    rows.push(
      [s.shotId, s.startedAt, s.label, s.candidateId, s.role, s.target, s.selectionReason]
        .map((v) => csvCell(String(v)))
        .join(','),
    );
  }
  return rows.join('\n');
};

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
