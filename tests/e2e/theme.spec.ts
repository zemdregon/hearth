import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';

const appearance = (page: Page) => page.getByRole('combobox', { name: 'Appearance', exact: true });
const storedTheme = (page: Page) => page.evaluate(() => localStorage.getItem('hearth-theme'));
async function expectTheme(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', theme === 'dark' ? '#17211d' : '#315343');
}
async function openGate(page: Page, view = 'today') {
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, json: { error: 'Local theme test uses fictional demo data.' } }));
  await page.goto(`/#${view}`);
  await expect(appearance(page)).toBeVisible();
}
async function openDemo(page: Page, view = 'today') {
  await openGate(page, view);
  await page.getByRole('button', { name: 'Explore the local demo' }).click();
  await expect(page.getByRole('button', { name: 'Local demo', exact: true })).toBeVisible();
}
async function audit(page: Page, label: string, selector?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  if (selector) builder = builder.include(selector);
  expect((await builder.analyze()).violations, `${label}: accessibility including color contrast`).toEqual([]);
}

test('applies the system or saved appearance before the application module executes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.route(/\/src\/client\/main\.tsx(?:\?|$)/, route => route.abort());
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#root')).toBeEmpty();
  await expectTheme(page, 'dark');
  expect(await storedTheme(page)).toBeNull();
  await page.evaluate(() => localStorage.setItem('hearth-theme', 'light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#root')).toBeEmpty();
  await expectTheme(page, 'light');
});

test('defaults to System and follows live light and dark changes without persisting a choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openGate(page);
  await expect(appearance(page)).toHaveValue('system');
  await expectTheme(page, 'dark');
  await audit(page, 'dark sign-in gate');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dark');
  expect(await storedTheme(page)).toBeNull();
});

test('explicit choices survive reload and remain available in the signed-in topbar', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openGate(page);
  await expect(appearance(page).locator('option')).toHaveText(['System', 'Light', 'Dark']);
  await appearance(page).selectOption('dark');
  await expectTheme(page, 'dark');
  expect(await storedTheme(page)).toBe('dark');
  await page.reload();
  await expect(appearance(page)).toHaveValue('dark');
  await expectTheme(page, 'dark');

  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...createDemo(), demo: false } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
  await expect(appearance(page)).toHaveCount(1);
  await expect(page.locator('.topbar').getByRole('combobox', { name: 'Appearance' })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await appearance(page).selectOption('light');
  await expectTheme(page, 'light');
  expect(await storedTheme(page)).toBe('light');
  await page.reload();
  await expectTheme(page, 'light');
  await appearance(page).selectOption('system');
  await expectTheme(page, 'dark');
  expect(await storedTheme(page)).toBeNull();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('syncs explicit choices, System removal, and storage clearing across real tabs', async ({ page, context }) => {
  await context.route('**/api/bootstrap', route => route.fulfill({ status: 503, json: { error: 'Local theme test.' } }));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const other = await context.newPage();
  try {
    await other.emulateMedia({ colorScheme: 'light' });
    await other.goto('/');
    await expect(appearance(other)).toHaveValue('system');
    await appearance(page).selectOption('dark');
    await expect(appearance(other)).toHaveValue('dark');
    await expectTheme(other, 'dark');
    await appearance(other).selectOption('light');
    await expect(appearance(page)).toHaveValue('light');
    await expectTheme(page, 'light');
    await appearance(page).selectOption('system');
    await expect(appearance(other)).toHaveValue('system');
    expect(await storedTheme(other)).toBeNull();
    await appearance(other).selectOption('dark');
    await expectTheme(page, 'dark');
    await page.evaluate(() => localStorage.clear());
    await expect(appearance(other)).toHaveValue('system');
    await expectTheme(other, 'light');
    expect(await storedTheme(other)).toBeNull();
  } finally { await other.close(); }
});

test('blocked storage keeps appearance controls and the demo usable for the current page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage disabled for this fixture.', 'SecurityError'); } });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await openGate(page);
  await appearance(page).selectOption('dark');
  await expectTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'dark');
  await page.getByRole('button', { name: 'Explore the local demo' }).click();
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
  await expect(appearance(page)).toHaveValue('dark');
  await appearance(page).selectOption('system');
  await expectTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dark');
  await page.reload();
  await expect(appearance(page)).toHaveValue('system');
  await expectTheme(page, 'dark');
  expect(errors).toEqual([]);
});

test('production offline shell retains the selected appearance without caching private responses', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 401, json: { error: 'Sign in required.' } }));
  await page.goto('http://localhost:4173/');
  await appearance(page).selectOption('dark');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const paths = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) paths.push(new URL(request.url).pathname);
    return paths;
  });
  expect(paths).toContain('/theme-init.js');
  expect(paths.some(path => path.startsWith('/api/'))).toBe(false);
  await page.unroute('**/api/bootstrap');
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(appearance(page)).toHaveValue('dark');
  await expectTheme(page, 'dark');
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ 'hearth-theme': 'dark' });
});

test('dark desktop family screens and editing dialogs meet contrast and accessibility checks', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDemo(page);
  await expectTheme(page, 'dark');
  await audit(page, 'dark desktop shell');
  await page.screenshot({ path: test.info().outputPath('dark-desktop-dashboard.png'), fullPage: true });
  for (const [view, heading, editor] of [
    ['tasks', 'Shared tasks', 'Add task'],
    ['notes', 'Little notes', ''],
    ['events', 'Our calendar', ''],
    ['goals', 'Our bigger dreams', ''],
    ['profiles', 'Our people', ''],
    ['recipes', 'A little taste of home.', 'Add recipe'],
  ]) {
    await page.evaluate(hash => { window.location.hash = hash; }, view);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await audit(page, `dark ${view}`, '#main-content');
    if (editor) {
      await page.getByRole('button', { name: editor, exact: true }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await audit(page, `dark ${view} editor`, 'dialog');
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    }
  }
});

test('dark mobile wellness and settings stay accessible without horizontal overflow', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDemo(page);
  await expect(appearance(page)).toBeVisible();
  await expectTheme(page, 'dark');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await audit(page, 'dark mobile navigation');
  await page.keyboard.press('Escape');
  for (const [view, heading] of [
    ['moods', 'How are you, really?'],
    ['streaks', 'Every day adds up.'],
    ['questions', 'A small question. A closer connection.'],
    ['settings', 'Make it your own.'],
  ]) {
    await page.evaluate(hash => { window.location.hash = hash; }, view);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${view} horizontal overflow`).toBe(true);
    await audit(page, `dark mobile ${view}`);
    if (view === 'moods' || view === 'settings') await page.screenshot({ path: test.info().outputPath(`dark-mobile-${view}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => { window.location.hash = 'profiles'; });
  await expect(page.getByRole('heading', { name: 'Our people', level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.topbar').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await appearance(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: test.info().outputPath('dark-mobile-320-profiles.png'), fullPage: true });
});

test('dark appearance leaves recipe images uninverted and printed recipes light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDemo(page, 'recipes');
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Scan a photo', exact: true }).click();
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e12727'; context.fillRect(0, 0, 60, 80);
    context.fillStyle = '#2361d1'; context.fillRect(60, 0, 60, 80);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Recipe photo', { exact: true }).setInputFiles({ name: 'synthetic-theme-colors.png', mimeType: 'image/png', buffer: Buffer.from(source, 'base64') });
  const image = page.getByRole('img', { name: 'Selected recipe photo preview' });
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => {
    const filters: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) filters.push(getComputedStyle(node).filter);
    return filters.some(filter => /invert\(/.test(filter));
  })).toBe(false);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'View Sunday lemon & herb chicken', exact: true }).click();
  await page.emulateMedia({ media: 'print' });
  const sheet = page.getByRole('article', { name: 'Recipe print sheet' });
  await expect(sheet).toBeVisible();
  await expect(page.locator('#root')).toBeHidden();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(sheet).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(sheet.getByRole('heading', { level: 1 })).toHaveCSS('color', 'rgb(17, 17, 17)');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.emulateMedia({ media: 'screen' });
  await expectTheme(page, 'dark');
  await expect(sheet).toBeHidden();
});
