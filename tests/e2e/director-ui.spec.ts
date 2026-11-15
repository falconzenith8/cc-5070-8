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

test('the app starts without fatal errors or console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.reload();
  await expect(page.locator('#sel-scenario')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.fatal')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('sidebar tabs actually swap panels', async ({ page }) => {
  await expect(page.locator('#tab-decision')).toBeVisible();
  await expect(page.locator('#tab-candidates')).toBeHidden();

  await page.click('.tab[data-tab="candidates"]');
  await expect(page.locator('#tab-candidates')).toBeVisible();
  await expect(page.locator('#tab-decision')).toBeHidden();

  await page.click('.tab[data-tab="replay"]');
  await expect(page.locator('#tab-replay')).toBeVisible();
  await expect(page.locator('#tab-candidates')).toBeHidden();

  await page.click('.tab[data-tab="decision"]');
  await expect(page.locator('#tab-decision')).toBeVisible();
  await expect(page.locator('#tab-replay')).toBeHidden();
});

test('candidate diagnostics list real scored cameras for the current beat', async ({ page }) => {
  await page.selectOption('#sel-scenario', 'occlusion');
  await seek(page, 20);
  await page.click('.tab[data-tab="candidates"]');

  const rows = page.locator('#cand-list .cand');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(20);

  // Every row must carry a computed score, not a placeholder.
  const totals = await page.locator('#cand-list .cand .total b').allInnerTexts();
  expect(totals.length).toBeGreaterThan(20);
  for (const t of totals.slice(0, 10)) expect(Number(t)).toBeGreaterThanOrEqual(0);

  await expect(page.locator('#cand-count')).toContainText('生成候选');
});

test('program view and decision panel agree during a genuine blackout', async ({ page }) => {
  await page.selectOption('#sel-scenario', 'occlusion');
  await seek(page, 22);

  // The scenic drop is closed: no legal camera sees anyone, so the wide rig
  // holds an honestly empty stage and the UI says why.
  await expect(page.locator('.dec-badge')).toContainText('无更优解');
  await expect(page.locator('#decision-card')).toContainText('0 / 90');
  await expect(page.locator('.warnings')).toContainText('不可见');
  await expect(page.locator('.warnings')).not.toContainText('所有候选与机位均通过');
});

test('occlusion arc: isolate, fall back, then recover without stalling', async ({ page }) => {
  await page.selectOption('#sel-scenario', 'occlusion');

  await seek(page, 13.2);
  await expect(page.locator('#decision-card')).toContainText('替代位');

  await seek(page, 20);
  await expect(page.locator('#decision-card')).toContainText('安全位');
  await expect(page.locator('#decision-card')).toContainText('0 / 90');

  await seek(page, 34);
  await expect(page.locator('#decision-card')).toContainText('主目标位');
  await expect(page.locator('#decision-card')).not.toContainText('0 / 90');
});

test('replay tab logs each cut with a reason, and export produces JSON', async ({ page }) => {
  await page.selectOption('#sel-scenario', 'occlusion');
  await seek(page, 36);
  await page.click('.tab[data-tab="replay"]');

  const log = page.locator('#cut-log li');
  expect(await log.count()).toBeGreaterThan(2);
  await expect(log.first()).toContainText('→');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export'),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
});

test('switching director policy changes the cut log', async ({ page }) => {
  const shotList = async () => {
    await page.click('.tab[data-tab="replay"]');
    const n = await page.locator('#cut-log li').count();
    await page.click('.tab[data-tab="decision"]');
    return n;
  };

  await page.selectOption('#sel-scenario', 'crossing');
  await page.selectOption('#sel-policy', 'patient');
  await seek(page, 38);
  const patientCuts = await shotList();

  await page.selectOption('#sel-policy', 'reactive');
  await seek(page, 38);
  const reactiveCuts = await shotList();

  expect(patientCuts).toBeGreaterThan(0);
  expect(reactiveCuts).toBeGreaterThan(patientCuts);
});
