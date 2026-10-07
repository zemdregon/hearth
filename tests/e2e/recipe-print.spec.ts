import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createDemo } from '../../src/client/demo';
import type { FamilyRecord, Recipe } from '../../src/shared/types';

const recipe: Recipe = { title: 'Our printable family bread', description: 'A recipe to keep beside the mixing bowl.', servings: 4, prepMinutes: 15, cookMinutes: 30, ingredients: [{ name: 'flour', quantity: 1.5, quantityMax: 2, unit: 'cups', note: 'sifted' }, { name: 'salt to taste', quantity: null, unit: '' }], steps: ['Mix 1 cup of flour into the bowl.', 'Bake at 180°C for 30 minutes.'], tags: ['Baking'], favorite: false, sourceUrl: 'http://recipes.example.org/family-bread' };

async function openRecipe(page: Page, value: Recipe = recipe) {
  const fixture = { ...createDemo(), demo: false };
  fixture.user = { ...fixture.user, name: 'PRIVATE MEMBER SENTINEL' };
  const record: FamilyRecord<'recipe'> = { id: 'printable-recipe', kind: 'recipe', data: value, ownerId: fixture.user.id, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fixture.records.push(record);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.goto('/#recipes');
  await page.getByRole('button', { name: `View ${value.title}`, exact: true }).click();
}

test('Print uses current portions, includes source and every ingredient, and isolates the recipe from the family shell', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/records**', route => { writes += 1; return route.fulfill({ status: 500, json: { error: 'Printing must never write a recipe.' } }); });
  await page.addInitScript(() => {
    Reflect.set(window, 'hearthPrintCalls', 0);
    window.print = () => { Reflect.set(window, 'hearthPrintCalls', Reflect.get(window, 'hearthPrintCalls') + 1); };
  });
  await openRecipe(page);
  const sheet = page.getByRole('article', { name: 'Recipe print sheet', includeHidden: true });
  await expect(sheet).toBeHidden();
  await page.getByLabel('Servings', { exact: true }).fill('8');
  await expect(page.getByRole('status')).toContainText('Ingredient amounts shown for 8 servings.');
  await page.getByRole('checkbox', { name: /flour/ }).check();
  await page.getByRole('button', { name: 'Print recipe', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'hearthPrintCalls'))).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(sheet).toBeVisible();
  await expect(page.locator('#root')).toBeHidden();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(sheet).toContainText('Serves 8');
  await expect(sheet).toContainText('3–4 cups flour');
  await expect(sheet).toContainText('salt to taste');
  await expect(sheet).toContainText('Ingredient amounts scaled from 4 to 8 servings.');
  await expect(sheet).toContainText('cooking times, and temperatures stay as written.');
  await expect(sheet).toContainText('Bake at 180°C for 30 minutes.');
  await expect(sheet).toContainText('http://recipes.example.org/family-bread');
  const printedText = (await page.locator('body').innerText()).trim();
  expect(printedText).toBe((await sheet.innerText()).trim());
  expect(printedText).not.toContain('PRIVATE MEMBER SENTINEL');
  expect(printedText).not.toContain('Shared tasks');
  expect(writes).toBe(0);
  await page.emulateMedia({ media: 'screen' });
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: 'Reset to 4 servings' }).click();
  await expect(page.getByLabel('Servings', { exact: true })).toHaveValue('4');
  await expect(page.locator('.recipe-ingredient-list')).toContainText('1 1/2–2 cups flour');
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Servings', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('dialog').getByLabel('Ingredient 1 amount')).toHaveValue('1.5–2');
  expect(writes).toBe(0);
});

test('invalid portions explain the fallback, disable printing, and reset to the original recipe', async ({ page }) => {
  await openRecipe(page);
  const portions = page.getByLabel('Servings', { exact: true });
  await portions.fill('0');
  await expect(portions).toHaveAttribute('aria-invalid', 'true');
  await expect(portions).toHaveAttribute('aria-describedby', 'recipe-scaling-note recipe-portions-error');
  await expect(page.getByRole('alert')).toContainText('Original amounts shown.');
  await expect(page.getByRole('button', { name: 'Print recipe', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reset to 4 servings' }).click();
  await expect(portions).toHaveValue('4');
  await expect(page.getByRole('button', { name: 'Print recipe', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reset to 4 servings' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All recipes', exact: true }).click();
  await expect(page.locator('.recipe-print-sheet')).toHaveCount(0);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('heading', { name: 'A little taste of home.' })).toBeVisible();
});

test('a long recipe prints across pages without clipping or exposing an open editor', async ({ page }) => {
  const longRecipe: Recipe = { ...recipe, title: 'Long recipe print fixture', steps: Array.from({ length: 12 }, (_, index) => `Step ${index + 1}. ${'Stir the mixture gently, keeping the printed instructions beside your bowl. '.repeat(18)}${index === 11 ? '\nFINAL METHOD SENTINEL' : ''}`), sourceUrl: `https://recipes.example.org/${'a-long-source-'.repeat(50)}` };
  await openRecipe(page, longRecipe);
  await page.getByLabel('Servings', { exact: true }).fill('6');
  await page.getByRole('button', { name: 'Edit recipe', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Recipe name').fill('PRIVATE UNSAVED DRAFT SENTINEL');
  await page.emulateMedia({ media: 'print' });
  const sheet = page.getByRole('article', { name: 'Recipe print sheet' });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sheet).toContainText('Hearth · saved recipe');
  await expect(sheet).toContainText('FINAL METHOD SENTINEL');
  await expect(sheet).toContainText('Serves 6');
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('PRIVATE UNSAVED DRAFT SENTINEL');
  expect(bodyText).not.toContain('PRIVATE MEMBER SENTINEL');
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('visible');
  expect(await sheet.evaluate(element => element.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const pdf = await page.pdf({ path: test.info().outputPath('hearth-long-recipe.pdf'), format: 'A4', preferCSSPageSize: true });
  const pageCount = (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  expect(pageCount).toBeGreaterThan(1);
  expect(pageCount).toBeLessThan(10);
  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Recipe name')).toHaveValue('PRIVATE UNSAVED DRAFT SENTINEL');
});
