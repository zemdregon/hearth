import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';

async function openRecipe(page: Page) {
  const fixture = { ...createDemo(), demo: false };
  const record = fixture.records.find(record => record.kind === 'recipe')!;
  if (record.kind !== 'recipe') throw new Error('Missing recipe fixture');
  record.data.ingredients = Array.from({ length: 40 }, (_, index) => ({ name: `Ingredient ${index + 1}`, quantity: 1, unit: 'g' }));
  record.data.steps = Array.from({ length: 30 }, (_, index) => `Step ${index + 1}: Mix gently, prepare the next ingredient, and cook until ready.`);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.goto('/#recipes');
  await page.getByRole('button', { name: `View ${record.data.title}`, exact: true }).click();
  return record.data.title;
}

type PanelName = 'ingredients' | 'steps';
const tab = (page: Page, name: 'Ingredients' | 'Steps') => page.getByRole('tab', { name, exact: true });
// Vertical scroll position relative to the panel's top, the quantity the app remembers per tab.
const panelOffset = (page: Page, name: PanelName) => page.locator(`#recipe-panel-${name}`).evaluate(element => -element.getBoundingClientRect().top);
async function scrollPanelTo(page: Page, name: PanelName, offset: number) {
  await page.locator(`#recipe-panel-${name}`).evaluate((element, wanted) => window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top + wanted, behavior: 'instant' }), offset);
  return panelOffset(page, name);
}
const stickyBarBottom = (page: Page) => page.getByRole('tablist', { name: 'Recipe sections' }).evaluate(element => element.getBoundingClientRect().bottom);

test('recipe tabs preserve servings and ingredient checks, support keyboard navigation and print both sections', async ({ page }) => {
  await openRecipe(page);
  const ingredients = page.getByRole('tab', { name: 'Ingredients', exact: true });
  const steps = page.getByRole('tab', { name: 'Steps', exact: true });
  await expect(ingredients).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Servings', { exact: true }).fill('8');
  await page.getByRole('checkbox').first().check();
  await ingredients.focus();
  await ingredients.press('ArrowRight');
  await expect(steps).toBeFocused();
  await expect(steps).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Steps' })).toBeVisible();
  await expect(page.getByLabel('Servings', { exact: true })).toBeHidden();
  await steps.press('Home');
  await expect(ingredients).toBeFocused();
  await expect(page.getByLabel('Servings', { exact: true })).toHaveValue('8');
  await expect(page.getByRole('checkbox').first()).toBeChecked();
  await ingredients.press('End');
  await expect(steps).toBeFocused();
  await page.emulateMedia({ media: 'print' });
  const sheet = page.getByRole('article', { name: 'Recipe print sheet' });
  await expect(sheet).toContainText('Ingredient 40');
  await expect(sheet).toContainText('Step 30:');
  await expect(page.getByRole('tablist')).toBeHidden();
});

for (const colorScheme of ['light', 'dark'] as const) test(`mobile ${colorScheme} recipe tabs remain anchored and start each section at its beginning and remember where you were`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme });
  await openRecipe(page);
  const tabs = page.getByRole('tablist', { name: 'Recipe sections' });
  await page.getByRole('checkbox').nth(25).scrollIntoViewIfNeeded();
  expect((await tabs.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect((await tabs.boundingBox())!.y).toBeLessThan(2);
  const ingredientsPlace = await panelOffset(page, 'ingredients');
  await page.getByRole('tab', { name: 'Steps', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Steps' })).toBeVisible();
  await expect(page.locator('.recipe-step-list li').first()).toBeInViewport();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.locator('.recipe-step-list li').nth(20).scrollIntoViewIfNeeded();
  expect((await tabs.boundingBox())!.y).toBeLessThan(2);
  await page.getByRole('tab', { name: 'Ingredients', exact: true }).click();
  expect(Math.abs((await panelOffset(page, 'ingredients')) - ingredientsPlace)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('checkbox').nth(25)).toBeInViewport();
  expect((await page.getByRole('checkbox').nth(25).boundingBox())!.y).toBeGreaterThanOrEqual(await stickyBarBottom(page) - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`recipe-tabs-${colorScheme}.png`) });
});

for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }]) test(`${viewport.name} tabs each remember their own scroll position, and a first visit starts at the beginning`, async ({ page }) => {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await openRecipe(page);
  const tolerance = 3;
  // Ingredients: scroll until ingredient 12 is on screen.
  await page.getByRole('checkbox').nth(11).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const ingredientPlace = await panelOffset(page, 'ingredients');
  expect(ingredientPlace).toBeGreaterThan(150);
  // First visit to Steps starts at its beginning, with the first step clear of the sticky bar.
  await tab(page, 'Steps').click();
  await expect(page.locator('.recipe-step-list li').first()).toBeInViewport();
  const stepsStart = await panelOffset(page, 'steps');
  expect(stepsStart).toBeLessThan(0);
  expect((await page.locator('.recipe-step-list li').first().boundingBox())!.y).toBeGreaterThanOrEqual(await stickyBarBottom(page) - 1);
  // Steps: scroll to a different depth, beyond the ingredient depth.
  await page.locator('.recipe-step-list li').nth(9).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const stepPlace = await panelOffset(page, 'steps');
  expect(Math.abs(stepPlace - ingredientPlace)).toBeGreaterThan(50);
  expect((await page.getByRole('tablist').boundingBox())!.y).toBeLessThan(2);
  await tab(page, 'Ingredients').click();
  expect(Math.abs((await panelOffset(page, 'ingredients')) - ingredientPlace)).toBeLessThanOrEqual(tolerance);
  await expect(page.getByRole('checkbox').nth(11)).toBeInViewport();
  expect((await page.getByRole('checkbox').nth(11).boundingBox())!.y).toBeGreaterThanOrEqual(await stickyBarBottom(page) - 1);
  await tab(page, 'Steps').click();
  expect(Math.abs((await panelOffset(page, 'steps')) - stepPlace)).toBeLessThanOrEqual(tolerance);
  await expect(page.locator('.recipe-step-list li').nth(9)).toBeInViewport();
  // Repeated flips stay put.
  for (let round = 0; round < 3; round += 1) {
    await tab(page, 'Ingredients').click();
    await tab(page, 'Steps').click();
  }
  expect(Math.abs((await panelOffset(page, 'steps')) - stepPlace)).toBeLessThanOrEqual(tolerance);
  await tab(page, 'Ingredients').click();
  expect(Math.abs((await panelOffset(page, 'ingredients')) - ingredientPlace)).toBeLessThanOrEqual(tolerance);
  await page.screenshot({ path: test.info().outputPath(`recipe-tab-restore-${viewport.name}.png`) });
});

test('positions are restored when switching by keyboard and the tab buttons keep focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRecipe(page);
  const ingredients = tab(page, 'Ingredients');
  const steps = tab(page, 'Steps');
  const ingredientPlace = await scrollPanelTo(page, 'ingredients', 900);
  await ingredients.focus();
  await ingredients.press('ArrowRight');
  await expect(steps).toBeFocused();
  const stepPlace = await scrollPanelTo(page, 'steps', 1400);
  await steps.focus();
  await steps.press('Home');
  await expect(ingredients).toBeFocused();
  expect(Math.abs((await panelOffset(page, 'ingredients')) - ingredientPlace)).toBeLessThanOrEqual(3);
  await ingredients.press('End');
  await expect(steps).toBeFocused();
  expect(Math.abs((await panelOffset(page, 'steps')) - stepPlace)).toBeLessThanOrEqual(3);
  await steps.press('ArrowLeft');
  await expect(ingredients).toBeFocused();
  expect(Math.abs((await panelOffset(page, 'ingredients')) - ingredientPlace)).toBeLessThanOrEqual(3);
  expect(await page.evaluate(() => document.activeElement?.closest('[role="tabpanel"]') ?? null)).toBeNull();
});

test('servings and ingredient check marks are kept alongside each remembered position', async ({ page }) => {
  await openRecipe(page);
  await page.getByLabel('Servings', { exact: true }).fill('8');
  await page.getByRole('checkbox').nth(2).check();
  await page.getByRole('checkbox').nth(30).check();
  const ingredientPlace = await scrollPanelTo(page, 'ingredients', 1000);
  await tab(page, 'Steps').click();
  const stepPlace = await scrollPanelTo(page, 'steps', 600);
  await tab(page, 'Ingredients').click();
  expect(Math.abs((await panelOffset(page, 'ingredients')) - ingredientPlace)).toBeLessThanOrEqual(3);
  await expect(page.getByRole('checkbox').nth(2)).toBeChecked();
  await expect(page.getByRole('checkbox').nth(30)).toBeChecked();
  await expect(page.getByRole('checkbox').nth(3)).not.toBeChecked();
  await scrollPanelTo(page, 'ingredients', 0);
  await expect(page.getByLabel('Servings', { exact: true })).toHaveValue('8');
  await tab(page, 'Steps').click();
  expect(Math.abs((await panelOffset(page, 'steps')) - stepPlace)).toBeLessThanOrEqual(3);
});

test('a restored position is clamped when the panel became shorter, rather than misplaced', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRecipe(page);
  await scrollPanelTo(page, 'ingredients', 1500);
  await tab(page, 'Steps').click();
  await scrollPanelTo(page, 'steps', 400);
  // Simulate a shorter panel (a text-size change, an edited recipe) while the Ingredients panel is hidden.
  await page.addStyleTag({ content: '.recipe-ingredient-list li:nth-child(n+8) { display: none; }' });
  await tab(page, 'Ingredients').click();
  const panel = page.locator('#recipe-panel-ingredients');
  const box = (await panel.boundingBox())!;
  const bottomGap = await page.evaluate(() => innerHeight) - box.y - box.height;
  // The end of the panel is reached, but the view is not pushed past it into blank space.
  expect(bottomGap).toBeGreaterThanOrEqual(-1);
  await expect(page.getByRole('heading', { name: 'Ingredients', exact: true })).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBeGreaterThanOrEqual(0);
  // The unchanged Steps tab still returns to its own place.
  await tab(page, 'Steps').click();
  expect(Math.abs((await panelOffset(page, 'steps')) - 400)).toBeLessThanOrEqual(3);
});

test('a panel that fits the screen is shown from its start and never scrolled out of reach', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRecipe(page);
  await scrollPanelTo(page, 'ingredients', 1500);
  await tab(page, 'Steps').click();
  await page.addStyleTag({ content: '.recipe-ingredient-list li:nth-child(n+4), .recipe-ingredients .pantry-check { display: none; }' });
  await tab(page, 'Ingredients').click();
  await expect(page.getByLabel('Servings', { exact: true })).toBeInViewport();
  expect((await page.getByLabel('Servings', { exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(await stickyBarBottom(page) - 1);
});

test('position memory lives in component state only and a reopened recipe starts fresh', async ({ page }) => {
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(window, '__storageWrites', { value: writes });
    for (const store of [Storage.prototype]) {
      for (const method of ['setItem', 'removeItem', 'clear'] as const) {
        const original = store[method] as (...args: string[]) => void;
        store[method] = function (this: Storage, ...args: string[]) { writes.push(`${this === window.localStorage ? 'local' : 'session'}.${method}:${args[0] ?? ''}`); return original.apply(this, args); } as never;
      }
    }
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => { writes.push(`idb.open:${String(args[0])}`); return open(...args); };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const title = await openRecipe(page);
  const baseline = await page.evaluate(() => ({ local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), writes: (window as unknown as { __storageWrites: string[] }).__storageWrites.length }));
  await scrollPanelTo(page, 'ingredients', 900);
  await tab(page, 'Steps').click();
  await scrollPanelTo(page, 'steps', 1200);
  await tab(page, 'Ingredients').click();
  await tab(page, 'Steps').click();
  const after = await page.evaluate(() => ({ local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), writes: (window as unknown as { __storageWrites: string[] }).__storageWrites.length, databases: 0 }));
  expect(after.local).toBe(baseline.local);
  expect(after.session).toBe(baseline.session);
  expect(after.writes).toBe(baseline.writes);
  // Leave and come back: Ingredients is selected and at the top, and Steps has no remembered depth either.
  await page.getByRole('button', { name: 'All recipes' }).click();
  await page.getByRole('button', { name: `View ${title}`, exact: true }).click();
  await expect(tab(page, 'Ingredients')).toHaveAttribute('aria-selected', 'true');
  expect(await panelOffset(page, 'ingredients')).toBeLessThan(0);
  await scrollPanelTo(page, 'ingredients', 700);
  await tab(page, 'Steps').click();
  await expect(page.locator('.recipe-step-list li').first()).toBeInViewport();
  expect(await panelOffset(page, 'steps')).toBeLessThan(0);
});

test('reduced motion restores positions immediately and print still shows everything after switching', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await openRecipe(page);
  const ingredientPlace = await scrollPanelTo(page, 'ingredients', 800);
  await tab(page, 'Steps').click();
  await scrollPanelTo(page, 'steps', 1100);
  await tab(page, 'Ingredients').click();
  // Read straight after the click: no smooth-scroll animation may still be running.
  expect(Math.abs((await panelOffset(page, 'ingredients')) - ingredientPlace)).toBeLessThanOrEqual(3);
  await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
  const sheet = page.getByRole('article', { name: 'Recipe print sheet' });
  await expect(sheet).toContainText('Ingredient 40');
  await expect(sheet).toContainText('Step 30:');
  await expect(page.getByRole('tablist')).toBeHidden();
});
