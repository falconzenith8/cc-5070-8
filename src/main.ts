import * as THREE from 'three';
import './style.css';
import { SCENARIOS, getScenario } from './director/scenarios';
import { getStage } from './director/stage';
import {
  RULE_ASSET,
  RULE_ASSET_ISSUES,
  RULE_ASSET_MIGRATED,
  RULE_ASSET_SOURCE,
  createDirectorState,
  getPolicy,
  getPolicyRuleSet,
  optionsFor,
  tickDirector,
  POLICIES,
  type DirectorState,
} from './director/director';
import { SHIPPED_ASSET_PROBLEMS, SHIPPED_MIGRATION_ISSUES } from './director/rules/asset';
import type { DirectorFrame } from './director/types';
import { createStageScene, type StageScene } from './render/stageScene';
import { ReplayRecorder, type ReplayLog } from './director/replay';
import {
  buildDiagnostics,
  candidateRow,
  cutLogItem,
  escapeHtml,
  renderMigrationReport,
  shotListItem,
  toCsv,
} from './ui/panels';

interface AppState {
  scenarioId: string;
  policyId: string;
  playing: boolean;
  time: number;
  tickHz: number;
  speed: number;
  showOverlay: boolean;
  showCandidates: boolean;
  director: DirectorState;
  opts: ReturnType<typeof optionsFor>;
  scenario: ReturnType<typeof getScenario>;
  stage: ReturnType<typeof getStage>;
  recorder: ReplayRecorder;
  lastFrame: DirectorFrame | null;
  selectedCandidateId: string | null;
  showRejected: boolean;
}

const TICK_HZ = 60;

/** Rule provenance attached to every recorded replay log. */
const replayRuleAsset = (policyId: string) => ({
  assetId: RULE_ASSET.assetId,
  schemaVersion: RULE_ASSET.schemaVersion,
  weights: { ...getPolicyRuleSet(policyId).weights },
});

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <span class="logo" aria-hidden="true"></span>
      <div>
        <h1>实时演出镜头导演</h1>
        <p class="sub">固定演出轨迹 · 几何生成候选机位 · 实时投影评分 · 可重放诊断</p>
      </div>
    </div>
    <div class="live-badges">
      <span id="badge-scenario" class="badge"></span>
      <span id="badge-policy" class="badge"></span>
      <span id="badge-fps" class="badge ghost">-- fps</span>
    </div>
  </header>

  <main class="layout">
    <section class="stage-panel">
      <div class="viewport" id="director-viewport">
        <canvas id="director-canvas"></canvas>
        <div class="viewport-label">
          <span class="dot"></span> 实际播出镜头 (program)
        </div>
        <div class="blackout" id="blackout" hidden>
          <div>
            <strong>无可用机位</strong>
            <span>黑场 · 导演仍在运行</span>
          </div>
        </div>
        <div class="hud" id="hud">
          <div class="hud-line"><span>镜头</span><b id="hud-shot">--</b></div>
          <div class="hud-line"><span>保持</span><b id="hud-age">0.0s</b></div>
          <div class="hud-line"><span>目标</span><b id="hud-target">--</b></div>
        </div>
      </div>

      <div class="overview-row">
        <div class="viewport small" id="overview-viewport">
          <canvas id="overview-canvas"></canvas>
          <div class="viewport-label"><span class="dot amber"></span> 舞台总览 (overview)</div>
        </div>
        <div class="controls">
          <div class="control-grid">
            <label>场景
              <select id="sel-scenario">
                ${SCENARIOS.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}
              </select>
            </label>
            <label>导演策略
              <select id="sel-policy">
                ${POLICIES.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
              </select>
            </label>
          </div>
          <p class="policy-desc" id="policy-desc"></p>
          <div class="transport">
            <button id="btn-play" class="primary">▶ 开演</button>
            <button id="btn-restart" title="回到起点并重置导演状态">⟲ 重来</button>
            <button id="btn-step" title="单步推进一帧">⏭ 单步</button>
          </div>
          <div class="scrub">
            <input id="scrub" type="range" min="0" max="36" step="0.01" value="0" />
            <div class="scrub-ticks" id="scrub-ticks"></div>
          </div>
          <div class="transport secondary">
            <label class="inline">速度
              <select id="sel-speed">
                <option value="0.5">0.5×</option>
                <option value="1" selected>1×</option>
                <option value="2">2×</option>
              </select>
            </label>
            <label class="check"><input type="checkbox" id="chk-overlay" /> 显示机位禁区/范围</label>
            <label class="check"><input type="checkbox" id="chk-candidates" /> 总览显示候选</label>
          </div>
          <p class="rule-source" id="rule-source"></p>
        </div>
      </div>

      <div class="beat-strip" id="beat-strip"></div>
    </section>

    <aside class="side-panel">
      <div class="tabs">
        <button class="tab active" data-tab="decision">选择依据</button>
        <button class="tab" data-tab="candidates">候选诊断</button>
        <button class="tab" data-tab="replay">重放导出</button>
      </div>

      <div class="tab-body" id="tab-decision">
        <div class="decision-card" id="decision-card"></div>
        <div class="reason-card">
          <h3>本帧选择原因</h3>
          <p id="decision-reason" class="reason-text">等待开演…</p>
          <div class="reason-meta" id="decision-meta"></div>
        </div>
        <div class="warnings" id="warnings"></div>
        <div class="rule-trace">
          <h3>命中规则（本帧）</h3>
          <div id="rule-trace"></div>
        </div>
        <div class="shot-history">
          <h3>镜头序列</h3>
          <ol id="shot-list"></ol>
        </div>
      </div>

      <div class="tab-body" id="tab-candidates" hidden>
        <div class="cand-toolbar">
          <span id="cand-count">--</span>
          <label class="check"><input type="checkbox" id="chk-show-rejected" checked /> 显示淘汰候选</label>
        </div>
        <div class="cand-list" id="cand-list"></div>
      </div>

      <div class="tab-body" id="tab-replay" hidden>
        <div class="replay-info" id="replay-info"></div>
        <div class="transport">
          <button id="btn-export" class="primary">导出重放 JSON</button>
          <button id="btn-export-reasons">导出镜头与理由 CSV</button>
        </div>
        <p class="hint">重放文件记录每个采样帧的候选评分、选中镜头机位与切换原因；同一条演出轨迹可离线复算比对。</p>
        <h3>规则资产与迁移报告</h3>
        <div class="migration-report" id="migration-report"></div>
        <h3>切换日志</h3>
        <ol class="cut-log" id="cut-log"></ol>
      </div>
    </aside>
  </main>

  <footer class="footer">
    <span id="footer-status">就绪</span>
    <span class="spacer"></span>
    <span>固定轨迹 · 不移动角色迁就机位</span>
  </footer>
`;

const els = {
  selScenario: document.querySelector<HTMLSelectElement>('#sel-scenario')!,
  selPolicy: document.querySelector<HTMLSelectElement>('#sel-policy')!,
  selSpeed: document.querySelector<HTMLSelectElement>('#sel-speed')!,
  policyDesc: document.querySelector<HTMLParagraphElement>('#policy-desc')!,
  badgeScenario: document.querySelector<HTMLSpanElement>('#badge-scenario')!,
  badgePolicy: document.querySelector<HTMLSpanElement>('#badge-policy')!,
  badgeFps: document.querySelector<HTMLSpanElement>('#badge-fps')!,
  play: document.querySelector<HTMLButtonElement>('#btn-play')!,
  restart: document.querySelector<HTMLButtonElement>('#btn-restart')!,
  step: document.querySelector<HTMLButtonElement>('#btn-step')!,
  scrub: document.querySelector<HTMLInputElement>('#scrub')!,
  scrubTicks: document.querySelector<HTMLDivElement>('#scrub-ticks')!,
  beatStrip: document.querySelector<HTMLDivElement>('#beat-strip')!,
  hudShot: document.querySelector<HTMLElement>('#hud-shot')!,
  hudAge: document.querySelector<HTMLElement>('#hud-age')!,
  hudTarget: document.querySelector<HTMLElement>('#hud-target')!,
  blackout: document.querySelector<HTMLDivElement>('#blackout')!,
  decisionCard: document.querySelector<HTMLDivElement>('#decision-card')!,
  decisionReason: document.querySelector<HTMLParagraphElement>('#decision-reason')!,
  decisionMeta: document.querySelector<HTMLDivElement>('#decision-meta')!,
  warnings: document.querySelector<HTMLDivElement>('#warnings')!,
  ruleTrace: document.querySelector<HTMLDivElement>('#rule-trace')!,
  ruleSource: document.querySelector<HTMLParagraphElement>('#rule-source')!,
  migrationReport: document.querySelector<HTMLDivElement>('#migration-report')!,
  shotList: document.querySelector<HTMLOListElement>('#shot-list')!,
  candList: document.querySelector<HTMLDivElement>('#cand-list')!,
  candCount: document.querySelector<HTMLSpanElement>('#cand-count')!,
  showRejected: document.querySelector<HTMLInputElement>('#chk-show-rejected')!,
  cutLog: document.querySelector<HTMLOListElement>('#cut-log')!,
  replayInfo: document.querySelector<HTMLDivElement>('#replay-info')!,
  footerStatus: document.querySelector<HTMLSpanElement>('#footer-status')!,
  chkOverlay: document.querySelector<HTMLInputElement>('#chk-overlay')!,
  chkCandidates: document.querySelector<HTMLInputElement>('#chk-candidates')!,
  directorViewport: document.querySelector<HTMLDivElement>('#director-viewport')!,
  overviewViewport: document.querySelector<HTMLDivElement>('#overview-viewport')!,
  directorCanvas: document.querySelector<HTMLCanvasElement>('#director-canvas')!,
  overviewCanvas: document.querySelector<HTMLCanvasElement>('#overview-canvas')!,
  decisionTab: document.querySelector<HTMLDivElement>('#tab-decision')!,
  candidatesTab: document.querySelector<HTMLDivElement>('#tab-candidates')!,
  replayTab: document.querySelector<HTMLDivElement>('#tab-replay')!,
};

const state: AppState = {
  scenarioId: 'two-hander',
  policyId: 'balanced',
  playing: false,
  time: 0,
  tickHz: TICK_HZ,
  speed: 1,
  showOverlay: false,
  showCandidates: false,
  director: createDirectorState(),
  opts: optionsFor('two-hander', 'balanced', 16 / 9, 1 / TICK_HZ),
  scenario: getScenario('two-hander'),
  stage: getStage('two-hander'),
  recorder: new ReplayRecorder('two-hander', 'balanced', 16 / 9, TICK_HZ, replayRuleAsset('balanced')),
  lastFrame: null,
  selectedCandidateId: null,
  showRejected: true,
};

const shotHistory: { shotId: number; label: string; startedAt: number; role: string; target: string; selectionReason: string }[] = [];
const cutHistory: { time: number; type: string; interruption: string | null; reason: string; label: string }[] = [];

const showFatal = (message: string) => {
  const banner = document.createElement('div');
  banner.className = 'fatal';
  banner.innerHTML = `<strong>导演界面异常</strong><span>${escapeHtml(message)}</span>`;
  document.body.appendChild(banner);
  const blackout = document.querySelector<HTMLDivElement>('#blackout');
  if (blackout) blackout.hidden = false;
};

// --- WebGL setup ---------------------------------------------------------
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: els.directorCanvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
} catch (err) {
  showFatal(`WebGL 初始化失败：${(err as Error).message}`);
  throw err;
}

const overviewRenderer = new THREE.WebGLRenderer({ canvas: els.overviewCanvas, antialias: true });
overviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
overviewRenderer.outputColorSpace = THREE.SRGBColorSpace;

let stage3d: StageScene;
try {
  stage3d = createStageScene(renderer, state.scenarioId);
} catch (err) {
  showFatal(`场景构建失败：${(err as Error).message}`);
  throw err;
}

const candidateMarkers = new THREE.Group();
stage3d.scene.add(candidateMarkers);

const clearCandidateMarkers = () => {
  for (const child of [...candidateMarkers.children]) {
    candidateMarkers.remove(child);
    const m = child as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  }
};

const drawCandidateMarkers = (frame: DirectorFrame) => {
  clearCandidateMarkers();
  if (!state.showCandidates) return;
  for (const c of frame.candidates) {
    if (c.kind !== 'generated' || !c.feasible) continue;
    const geo = new THREE.SphereGeometry(0.075, 8, 8);
    const isAir = frame.onAir?.sourceCandidateId === c.id;
    const mat = new THREE.MeshBasicMaterial({
      color: isAir ? 0x39d0ff : new THREE.Color().setHSL(0.33, 0.9, 0.5 + c.scores.total * 0.25),
      transparent: true,
      opacity: isAir ? 1 : 0.35 + c.scores.total * 0.5,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(c.cam.pos.x, c.cam.pos.y, c.cam.pos.z);
    candidateMarkers.add(m);
  }
};

// --- Rendering sizes -----------------------------------------------------
const fitCanvases = () => {
  const dRect = els.directorViewport.getBoundingClientRect();
  const w = Math.max(320, dRect.width);
  const h = Math.max(220, dRect.height);
  renderer.setSize(w, h, false);
  stage3d.resize(w / h);

  const oRect = els.overviewViewport.getBoundingClientRect();
  const ow = Math.max(200, oRect.width);
  const oh = Math.max(140, oRect.height);
  overviewRenderer.setSize(ow, oh, false);
  stage3d.resize(w / h);
  stage3d.overviewCam.aspect = ow / oh;
  stage3d.overviewCam.updateProjectionMatrix();

  // Recompute scoring aspect: the same aspect is used by the director.
  const aspect = w / h;
  if (Math.abs(aspect - state.opts.aspect) > 0.002) {
    state.opts.aspect = aspect;
    state.recorder = new ReplayRecorder(state.scenarioId, state.policyId, aspect, TICK_HZ, replayRuleAsset(state.policyId));
    resetDirector(false);
  }
};

// --- Director driving ----------------------------------------------------
const resetDirector = (keepTime: boolean) => {
  state.director = createDirectorState();
  shotHistory.length = 0;
  cutHistory.length = 0;
  state.recorder.reset();
  state.lastFrame = null;
  state.selectedCandidateId = null;
  if (!keepTime) state.time = 0;
  renderHistory();
  ensureFrameAtCurrentTime();
};

/**
 * Advance the director to `targetTime`. Scrubbing forward replays every tick so
 * hold timing, switching history and diagnostics match what live playback
 * produced — there is no "teleport" shortcut that would fabricate a state.
 */
const advanceTo = (targetTime: number) => {
  forcePanels = true;
  const dt = 1 / state.tickHz;
  const maxSteps = Math.ceil(state.scenario.duration * state.tickHz) + 2;
  let guard = 0;
  while (state.time + 1e-6 < targetTime && guard < maxSteps) {
    state.time = Math.min(state.time + dt, state.scenario.duration);
    stepOnce();
    guard++;
    if (state.time >= state.scenario.duration) break;
  }
  if (guard >= maxSteps) {
    showFatal('推进步数超限：演出时长或 tick 配置异常');
  }
};

const stepOnce = () => {
  forcePanels = true;
  const step = Math.round(state.time * state.tickHz);
  const frame = tickDirector(state.director, state.opts, { time: state.time, step });
  applyFrame(frame);
};

const ensureFrameAtCurrentTime = () => {
  if (state.time === 0 && state.lastFrame === null) stepOnce();
};

let forcePanels = false;

const applyFrame = (frame: DirectorFrame) => {
  state.lastFrame = frame;
  state.recorder.push(frame);
  stage3d.update(frame);
  drawCandidateMarkers(frame);

  if (frame.onAir) {
    const prev = shotHistory[shotHistory.length - 1];
    if (!prev || prev.shotId !== frame.onAir.shotId) {
      shotHistory.push({
        shotId: frame.onAir.shotId,
        label: frame.onAir.label,
        startedAt: frame.onAir.startedAt,
        role: frame.onAir.role,
        target: frame.onAir.targetName,
        selectionReason: frame.onAir.selectionReason,
      });
      if (shotHistory.length > 40) shotHistory.shift();
    }
  }
  if (frame.decision.cut && frame.decision.type !== 'start') {
    cutHistory.push({
      time: frame.time,
      type: frame.decision.type,
      interruption: frame.decision.interruption,
      reason: frame.decision.reason,
      label: frame.onAir?.label ?? '—',
    });
    if (cutHistory.length > 60) cutHistory.shift();
  }

  updatePanels(frame);
  if (forcePanels || !state.playing) {
    renderCandidateList(frame);
    renderHistory();
    renderBeatStrip(frame);
    renderReplayInfo();
    forcePanels = false;
  }
};

// --- Panel updates -------------------------------------------------------
let lastPanelUpdate = 0;
const updatePanels = (frame: DirectorFrame) => {
  const diag = buildDiagnostics(frame);
  els.decisionCard.innerHTML = diag.cardHtml;
  els.decisionMeta.innerHTML = diag.metaHtml;
  els.warnings.innerHTML = diag.warningsHtml;
  els.ruleTrace.innerHTML = diag.rulesHtml;
  els.decisionReason.textContent = frame.decision.reason;

  els.hudShot.textContent = frame.onAir ? `#${frame.onAir.shotId} ${frame.onAir.targetName}` : '黑场';
  els.hudAge.textContent = `${frame.shotAge.toFixed(1)}s`;
  els.hudTarget.textContent = frame.onAir ? frame.onAir.label : '—';
  els.blackout.hidden = !frame.black;

  const now = performance.now();
  if (now - lastPanelUpdate > 180) {
    lastPanelUpdate = now;
    renderCandidateList(frame);
    renderHistory();
    renderBeatStrip(frame);
    renderReplayInfo();
    els.badgeScenario.textContent = state.scenario.name;
    els.badgePolicy.textContent = frame.policyLabel;
    els.footerStatus.textContent = frame.black
      ? '⚠ 无可用机位，输出黑场'
      : `t=${frame.time.toFixed(2)}s · ${frame.decision.type} · 可行候选 ${frame.feasibleCount}`;
  }
};

const renderCandidateList = (frame: DirectorFrame) => {
  const all = frame.candidates;
  const list = state.showRejected ? all : all.filter((c) => c.feasible);
  const sorted = [...list].sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    return b.scores.total - a.scores.total;
  });
  els.candCount.textContent = `${frame.feasibleCount} 个可行 / ${all.filter((c) => c.kind === 'generated').length} 个生成候选`;
  els.candList.innerHTML = sorted
    .map((c) => candidateRow(c, frame.onAir?.sourceCandidateId ?? null, state.selectedCandidateId))
    .join('');
};

const renderHistory = () => {
  els.shotList.innerHTML = [...shotHistory].reverse().map(shotListItem).join('') || '<li class="empty">尚未开演</li>';
  els.cutLog.innerHTML =
    [...cutHistory].reverse().map((c) => cutLogItem(c.time, c.type, c.interruption, c.reason, c.label)).join('') ||
    '<li class="empty">尚未发生切换</li>';
};

const renderBeatStrip = (frame: DirectorFrame) => {
  els.beatStrip.innerHTML = frame.perf.actors
    .map((a) => {
      const isPrimary = a.id === frame.perf.primaryId;
      return `<div class="beat-actor ${isPrimary ? 'primary' : ''}" style="--actor:${a.color}">
        <span class="ba-dot"></span>
        <span class="ba-name">${escapeHtml(a.name)}</span>
        <span class="ba-act">${a.action}</span>
        <div class="ba-meter"><i style="width:${(a.salience * 100).toFixed(0)}%"></i></div>
      </div>`;
    })
    .join('') + `<div class="beat-label">本拍：${escapeHtml(frame.perf.beatLabel)}</div>`;
};

const renderReplayInfo = () => {
  els.replayInfo.innerHTML = `
    <div><span>已记录采样帧</span><b>${state.recorder.frameCount}</b></div>
    <div><span>镜头数</span><b>${state.recorder.toLog().shots.length}</b></div>
    <div><span>场景 / 策略</span><b>${escapeHtml(state.scenario.name)} / ${escapeHtml(getPolicy(state.policyId).label)}</b></div>
    <div><span>规则资产</span><b>${escapeHtml(RULE_ASSET.assetId)} v${RULE_ASSET.schemaVersion}</b></div>
  `;
};

const renderRuleSource = () => {
  const shownIssues = SHIPPED_MIGRATION_ISSUES.length + RULE_ASSET_ISSUES.length + SHIPPED_ASSET_PROBLEMS.length;
  els.ruleSource.innerHTML = `规则资产 <code>${escapeHtml(RULE_ASSET.assetId)}</code> v${
    RULE_ASSET.schemaVersion
  } · 来源 ${escapeHtml(RULE_ASSET_SOURCE)}${RULE_ASSET_MIGRATED ? '（已迁移）' : '（迁移自 legacy）'} · 迁移问题 ${shownIssues} 项`;
  // The shipped asset persists the migration report it was produced with; the
  // in-memory load result only carries validation problems. Show both so a
  // dropped legacy condition can never be mistaken for a clean migration.
  els.migrationReport.innerHTML = renderMigrationReport({
    asset: RULE_ASSET,
    issues: [...SHIPPED_MIGRATION_ISSUES, ...RULE_ASSET_ISSUES],
    sourceVersion: RULE_ASSET_SOURCE,
    migrated: RULE_ASSET_MIGRATED,
    extraIssues: SHIPPED_ASSET_PROBLEMS,
  });
};

const renderBeatTicks = () => {
  els.scrubTicks.innerHTML = state.scenario.beats
    .map((b) => `<span style="left:${(b.t / state.scenario.duration) * 100}%" title="${escapeHtml(b.label)}"></span>`)
    .join('');
};

// --- Frame loop ----------------------------------------------------------
let lastWall = performance.now();
let fpsAccum = 0;
let fpsCount = 0;

const frameLoop = () => {
  const now = performance.now();
  const wallDt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;

  if (state.playing) {
    const target = Math.min(state.scenario.duration, state.time + wallDt * state.speed);
    advanceTo(target);
    if (state.time >= state.scenario.duration) {
      state.playing = false;
      els.play.textContent = '▶ 开演';
      els.play.classList.remove('playing');
    }
    els.scrub.value = state.time.toFixed(2);
  }

  if (state.lastFrame) stage3d.update(state.lastFrame);

  renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
  renderer.render(stage3d.scene, stage3d.directorCam);

  overviewRenderer.setViewport(0, 0, overviewRenderer.domElement.width, overviewRenderer.domElement.height);
  overviewRenderer.render(stage3d.scene, stage3d.overviewCam);

  fpsAccum += wallDt;
  fpsCount++;
  if (fpsAccum >= 0.5) {
    els.badgeFps.textContent = `${Math.round(fpsCount / fpsAccum)} fps`;
    fpsAccum = 0;
    fpsCount = 0;
  }

  requestAnimationFrame(frameLoop);
};

// --- Controls ------------------------------------------------------------
const applyScenarioChange = (id: string) => {
  state.scenarioId = id;
  state.scenario = getScenario(id);
  state.stage = getStage(id);
  state.opts = optionsFor(id, state.policyId, state.opts.aspect, 1 / TICK_HZ);
  state.recorder = new ReplayRecorder(id, state.policyId, state.opts.aspect, TICK_HZ, replayRuleAsset(state.policyId));
  stage3d.setScenario(id);
  els.scrub.max = state.scenario.duration.toFixed(2);
  renderBeatTicks();
  resetDirector(false);
  setPlaying(false);
  els.scrub.value = '0';
};

const applyPolicyChange = (id: string) => {
  state.policyId = id;
  state.opts = optionsFor(state.scenarioId, id, state.opts.aspect, 1 / TICK_HZ);
  state.recorder = new ReplayRecorder(state.scenarioId, id, state.opts.aspect, TICK_HZ, replayRuleAsset(id));
  els.policyDesc.textContent = getPolicy(id).description;
  // Re-run from the start so switching policies never mixes histories.
  resetDirector(false);
  setPlaying(false);
  els.scrub.value = '0';
};

const setPlaying = (playing: boolean) => {
  if (playing && state.time >= state.scenario.duration - 1e-6) {
    resetDirector(false);
    els.scrub.value = '0';
  }
  state.playing = playing;
  els.play.textContent = playing ? '⏸ 暂停' : '▶ 开演';
  els.play.classList.toggle('playing', playing);
};

els.selScenario.addEventListener('change', () => applyScenarioChange(els.selScenario.value));
els.selPolicy.addEventListener('change', () => applyPolicyChange(els.selPolicy.value));
els.selSpeed.addEventListener('change', () => {
  state.speed = Number(els.selSpeed.value);
});
els.play.addEventListener('click', () => setPlaying(!state.playing));
els.restart.addEventListener('click', () => {
  resetDirector(false);
  setPlaying(false);
  els.scrub.value = '0';
});
els.step.addEventListener('click', () => {
  setPlaying(false);
  const next = Math.min(state.scenario.duration, state.time + 1 / TICK_HZ);
  advanceTo(next);
  els.scrub.value = state.time.toFixed(2);
});
els.scrub.addEventListener('input', () => {
  setPlaying(false);
  const target = Number(els.scrub.value);
  if (target < state.time) {
    resetDirector(true);
    state.time = 0;
  }
  advanceTo(target);
});
els.chkOverlay.addEventListener('change', () => {
  state.showOverlay = els.chkOverlay.checked;
  stage3d.setShowOverlay(state.showOverlay);
});
els.chkCandidates.addEventListener('change', () => {
  state.showCandidates = els.chkCandidates.checked;
  if (state.lastFrame) drawCandidateMarkers(state.lastFrame);
});
els.showRejected.addEventListener('change', () => {
  state.showRejected = els.showRejected.checked;
  if (state.lastFrame) renderCandidateList(state.lastFrame);
});
els.candList.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-cand]');
  if (!target) return;
  const id = target.dataset.cand ?? null;
  state.selectedCandidateId = state.selectedCandidateId === id ? null : id;
  if (state.lastFrame) renderCandidateList(state.lastFrame);
});

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    els.decisionTab.hidden = which !== 'decision';
    els.candidatesTab.hidden = which !== 'candidates';
    els.replayTab.hidden = which !== 'replay';
    if (which === 'candidates' && state.lastFrame) renderCandidateList(state.lastFrame);
    if (which === 'replay') renderReplayInfo();
  });
}

const download = (filename: string, content: string, mime: string) => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

document.querySelector('#btn-export')!.addEventListener('click', () => {
  const log: ReplayLog = state.recorder.toLog();
  download(`replay-${state.scenarioId}-${state.policyId}.json`, JSON.stringify(log, null, 2), 'application/json');
});
document.querySelector('#btn-export-reasons')!.addEventListener('click', () => {
  const log = state.recorder.toLog();
  download(`shots-${state.scenarioId}-${state.policyId}.csv`, toCsv(log), 'text/csv');
});

window.addEventListener('resize', fitCanvases);
window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    setPlaying(!state.playing);
  } else if (ev.code === 'ArrowRight') {
    setPlaying(false);
    advanceTo(Math.min(state.scenario.duration, state.time + 0.25));
    els.scrub.value = state.time.toFixed(2);
  } else if (ev.code === 'ArrowLeft') {
    setPlaying(false);
    resetDirector(true);
    state.time = 0;
    advanceTo(Math.max(0, state.time - 0.25));
    els.scrub.value = state.time.toFixed(2);
  }
});

// --- Boot ----------------------------------------------------------------
els.policyDesc.textContent = getPolicy(state.policyId).description;
els.scrub.max = state.scenario.duration.toFixed(2);
renderRuleSource();
renderBeatTicks();
fitCanvases();
resetDirector(false);
stepOnce();
els.scrub.value = '0';
requestAnimationFrame(frameLoop);
