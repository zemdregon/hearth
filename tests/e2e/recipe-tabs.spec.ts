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
}

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

for (const colorScheme of ['light', 'dark'] as const) test(`mobile ${colorScheme} recipe tabs remain anchored and switch to the start of each section`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme });
  await openRecipe(page);
  const tabs = page.getByRole('tablist', { name: 'Recipe sections' });
  await page.getByRole('checkbox').nth(25).scrollIntoViewIfNeeded();
  expect((await tabs.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect((await tabs.boundingBox())!.y).toBeLessThan(2);
  await page.getByRole('tab', { name: 'Steps', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Steps' })).toBeVisible();
  await expect(page.locator('.recipe-step-list li').first()).toBeInViewport();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.locator('.recipe-step-list li').nth(20).scrollIntoViewIfNeeded();
  expect((await tabs.boundingBox())!.y).toBeLessThan(2);
  await page.getByRole('tab', { name: 'Ingredients', exact: true }).click();
  await expect(page.getByLabel('Servings', { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`recipe-tabs-${colorScheme}.png`) });
});
