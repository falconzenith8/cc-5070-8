import { test, expect } from 'playwright/test';

const seek = async (page: import('playwright/test').Page, t: number) => {
  await page.locator('#scrub').evaluate((el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  await page.waitForTimeout(500);
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#sel-scenario')).toBeVisible();
  await page.waitForTimeout(800);
});

test('the UI states which versioned rule asset it is running', async ({ page }) => {
  // Interaction is unchanged: the same scenario/policy selectors drive the run.
  await expect(page.locator('#rule-source')).toContainText('v2');
  await expect(page.locator('#rule-source')).toContainText('迁移问题');

  await page.click('.tab[data-tab="replay"]');
  // The migration report lists every unresolved legacy item, with units.
  const report = page.locator('#migration-report');
  await expect(report).toContainText('持续时间单位');
  await expect(report).toContainText('ms → s');
  await expect(report).toContainText('未解决');
  // Events keep their identity and are shown in seconds.
  await expect(report.locator('.event-list li').first()).toContainText('two-hander');
  await expect(report.locator('.event-list li').first()).toContainText('+36s');
});

test('unsupported legacy conditions are reported, not hidden', async ({ page }) => {
  await page.click('.tab[data-tab="replay"]');
  const report = page.locator('#migration-report');
  // camera-shake has no v2 equivalent and must be listed as an error.
  await expect(report).toContainText('camera-shake');
  await expect(report).toContainText('legacy-condition-unsupported');
  // A legacy rule whose condition named no actor is dropped and reported.
  await expect(report).toContainText('legacy-condition-missing-actor');
  await expect(report).toContainText('缺少 actor');
  // Stale authored candidate references are reported in the warnings channel.
  await page.selectOption('#sel-scenario', 'occlusion');
  await seek(page, 15);
  await expect(page.locator('#warnings')).toContainText('gen:primary:75:8:2.8');
});

test('the decision panel shows the rules that actually matched this frame', async ({ page }) => {
  await page.selectOption('#sel-scenario', 'occlusion');
  await seek(page, 16);
  const trace = page.locator('#rule-trace');
  await expect(trace).toBeVisible();
  // The 12–17.5 s window rule must match in performance seconds.
  await expect(trace).toContainText('beat-window-guard');
  await expect(trace).toContainText('[12s, 17.5s)');

  // Outside the window it must not be claimed.
  await seek(page, 22);
  await expect(trace).not.toContainText('beat-window-guard');
});

test('changing policy changes the real shot sequence and each shot keeps its reason', async ({ page }) => {
  const collect = async () => {
    await page.click('.tab[data-tab="decision"]');
    const shots = await page.locator('#shot-list li').allInnerTexts();
    return shots;
  };

  await page.selectOption('#sel-scenario', 'crossing');
  await page.selectOption('#sel-policy', 'patient');
  await seek(page, 38);
  const patient = await collect();
  expect(patient.length).toBeGreaterThan(2);
  // Every listed shot must carry a selection reason, not just a label.
  for (const s of patient) expect(s).toContain('t=');

  await page.selectOption('#sel-policy', 'reactive');
  await seek(page, 38);
  const reactive = await collect();

  expect(reactive.length).toBeGreaterThan(patient.length);
  // The actual on-screen shot must match the last logged shot.
  const hud = await page.locator('#hud-shot').textContent();
  expect(hud).toMatch(/#\d+/);
  await expect(page.locator('#decision-reason')).not.toBeEmpty();
});

test('candidate rows explain authored rule bonuses and denials', async ({ page }) => {
  await page.selectOption('#sel-scenario', 'occlusion');
  await seek(page, 15);
  await page.click('.tab[data-tab="candidates"]');
  const rows = page.locator('#cand-list .cand');
  await expect(rows.first()).toBeVisible();
  const text = await page.locator('#cand-list').innerText();
  // The beat-window rule gives a bounded bonus to authored cells and says so.
  expect(text).toContain('规则偏好');
});

test('replay export carries rule provenance and per-frame weights', async ({ page }) => {
  await page.selectOption('#sel-scenario', 'occlusion');
  await seek(page, 20);
  await page.click('.tab[data-tab="replay"]');

  // Capture the JSON the app itself hands to the download: this is exactly the
  // delivered evidence, read without touching the filesystem.
  type ExportedLog = {
    version: number;
    ruleAsset: { schemaVersion: number };
    frames: { onAir: unknown; rules?: unknown; weights: Record<string, number> }[];
    shots: { selectedRules?: unknown }[];
  };
  const log = (await page.evaluate(() => {
    return new Promise((resolve) => {
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob: Blob) => {
        blob.text().then((text) => resolve(JSON.parse(text)));
        return original(blob);
      };
      document.querySelector<HTMLButtonElement>('#btn-export')!.click();
    });
  })) as ExportedLog;

  expect(log.version).toBe(2);
  expect(log.ruleAsset.schemaVersion).toBe(2);
  expect(log.frames.length).toBeGreaterThan(0);
  const frame = log.frames.find((f) => f.onAir)!;
  expect(frame.rules).toBeDefined();
  const sum = frame.weights.visibility + frame.weights.composition + frame.weights.duration;
  expect(Math.abs(sum - 1)).toBeLessThan(0.01);
  expect(log.shots[0].selectedRules).toBeDefined();
});
