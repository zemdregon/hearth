import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createDemo } from '../../src/client/demo';
import type { FamilyRecord } from '../../src/shared/types';

function libraryRecords(count: number, ownerId: string): FamilyRecord<'recipe'>[] {
  return Array.from({ length: count }, (_, index) => ({ id: `library-${String(index + 1).padStart(3, '0')}`, kind: 'recipe', ownerId, version: 1, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', data: { title: `Library recipe ${String(index + 1).padStart(3, '0')}`, description: 'A synthetic recipe fixture for our family cookbook.', servings: 4, prepMinutes: 10, cookMinutes: 20, ingredients: [{ name: index === 412 ? 'far-away saffron' : 'flour', quantity: 1, unit: 'cup' }], steps: ['Mix gently and cook.'], tags: [index === count - 1 ? 'Rare' : index % 2 ? 'Dinner' : 'Baking'], favorite: index >= count - 25 } }));
}

async function mockLibrary(page: Page, count: number) {
  const fixture = { ...createDemo(), demo: false };
  const otherRecords = fixture.records.filter(record => record.kind !== 'recipe');
  fixture.records = [...otherRecords, ...libraryRecords(count, fixture.user.id)];
  let bootstraps = 0;
  await page.route('**/api/bootstrap', route => { bootstraps += 1; return route.fulfill({ json: fixture }); });
  await page.route('**/api/records/**', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const record = fixture.records.find(item => item.id === id);
    if (!record) return route.fulfill({ status: 404, json: { error: 'Fixture record missing.' } });
    if (route.request().method() === 'DELETE') {
      fixture.records = fixture.records.filter(item => item.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    const input = route.request().postDataJSON();
    const updated = { ...record, data: input.data, version: record.version + 1 };
    fixture.records = fixture.records.map(item => item.id === id ? updated : item);
    return route.fulfill({ json: updated });
  });
  return {
    replace(count: number) { fixture.records = [...otherRecords, ...libraryRecords(count, fixture.user.id)]; },
    async refresh() { const before = bootstraps; await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect.poll(() => bootstraps).toBeGreaterThan(before); },
  };
}

const topPages = (page: Page) => page.getByRole('navigation', { name: 'Recipe pages', exact: true });
const nextPage = (page: Page) => topPages(page).getByRole('button', { name: 'Next recipe page', exact: true });
const previousPage = (page: Page) => topPages(page).getByRole('button', { name: 'Previous recipe page', exact: true });

for (const width of [320, 390]) {
  test(`500 recipes stay bounded and global filters work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockLibrary(page, 500);
    await page.goto('/#today');
    await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
    const openMilliseconds = await page.evaluate(async () => {
      const started = performance.now();
      document.querySelector<HTMLAnchorElement>('.mobile-bottom-nav a[href="#recipes"]')!.click();
      await new Promise<void>(resolve => { const ready = () => { if (document.querySelector('.recipe-grid')) requestAnimationFrame(() => requestAnimationFrame(() => resolve())); else requestAnimationFrame(ready); }; ready(); });
      return performance.now() - started;
    });
    await expect(page.locator('.recipe-card')).toHaveCount(24);
    await expect(topPages(page)).toContainText('1–24 of 500 recipes');
    await expect(topPages(page)).toContainText('Page 1 of 21');
    const nodes = await page.locator('body *').count();
    expect(nodes).toBeLessThan(1500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const search = page.getByRole('searchbox', { name: 'Search recipes or ingredients' });
    await search.fill('far-away saffron');
    await expect(page.locator('.recipe-card')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'View Library recipe 413' })).toBeVisible();
    const clearMilliseconds = await search.evaluate(async element => {
      const started = performance.now();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>(resolve => { const ready = () => { if (document.querySelectorAll('.recipe-card').length === 24) requestAnimationFrame(() => requestAnimationFrame(() => resolve())); else requestAnimationFrame(ready); }; ready(); });
      return performance.now() - started;
    });
    await expect(page.locator('.recipe-card')).toHaveCount(24);
    await page.getByRole('button', { name: 'Rare', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View Library recipe 500' })).toBeVisible();
    await expect(page.locator('.recipe-card')).toHaveCount(1);
    await page.getByRole('button', { name: 'All recipes', exact: true }).click();
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect(topPages(page)).toContainText('1–24 of 25 recipes');
    await expect(page.getByRole('button', { name: 'View Library recipe 476' })).toBeVisible();
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect(topPages(page)).toContainText('1–24 of 500 recipes');
    await nextPage(page).focus();
    await page.keyboard.press('Enter');
    await expect(topPages(page)).toContainText('25–48 of 500 recipes');
    await expect(nextPage(page)).toBeFocused();
    await expect(page.locator('.recipe-card')).toHaveCount(24);
    await topPages(page).screenshot({ path: test.info().outputPath(`recipe-pages-${width}.png`) });
    console.info('Recipe pagination fixture measurement', { width, nodes, openMilliseconds: Math.round(openMilliseconds), clearMilliseconds: Math.round(clearMilliseconds) });
  });
}

test('detail return preserves page and focus while refresh clamps without discarding a draft', async ({ page }) => {
  const library = await mockLibrary(page, 500);
  await page.goto('/#recipes');
  await nextPage(page).click(); await nextPage(page).click();
  await expect(topPages(page)).toContainText('49–72 of 500 recipes');
  await page.getByRole('button', { name: 'View Library recipe 055' }).click();
  await page.getByRole('button', { name: 'All recipes', exact: true }).click();
  await expect(topPages(page)).toContainText('49–72 of 500 recipes');
  await expect(page.getByRole('button', { name: 'View Library recipe 055' })).toBeFocused();
  await page.getByRole('button', { name: 'Add recipe', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Recipe name').fill('Keep my unsaved draft');
  await editor.getByLabel('Ingredient 1 name').fill('Do not lose this ingredient');
  library.replace(25); await library.refresh();
  await expect(editor.getByLabel('Recipe name')).toHaveValue('Keep my unsaved draft');
  await expect(editor.getByLabel('Ingredient 1 name')).toHaveValue('Do not lose this ingredient');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(topPages(page)).toContainText('25–25 of 25 recipes');
  await expect(nextPage(page)).toBeDisabled();
  library.replace(500); await library.refresh();
  await expect(topPages(page)).toContainText('25–48 of 500 recipes');
  await expect(page.locator('.recipe-card')).toHaveCount(24);
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('far-away saffron');
  await expect(page.getByRole('button', { name: 'View Library recipe 413' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill('not-in-this-library');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(topPages(page)).toContainText('1–24 of 500 recipes');
});

test('unfavoriting the last favorite on a final page clamps to remaining results', async ({ page }) => {
  await mockLibrary(page, 500);
  await page.goto('/#recipes');
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await nextPage(page).click();
  await expect(topPages(page)).toContainText('25–25 of 25 recipes');
  await expect(previousPage(page)).toBeFocused();
  await page.getByRole('button', { name: 'Unfavorite Library recipe 500' }).click();
  await expect(page.locator('.recipe-card')).toHaveCount(24);
  await expect(topPages(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View Library recipe 476' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search recipes or ingredients' })).toBeFocused();
});

test('deleting the only recipe on the final page returns to the preceding page', async ({ page }) => {
  await mockLibrary(page, 49);
  await page.goto('/#recipes');
  await nextPage(page).click(); await nextPage(page).click();
  await expect(topPages(page)).toContainText('49–49 of 49 recipes');
  await page.getByRole('button', { name: 'View Library recipe 049' }).click();
  await page.getByRole('button', { name: 'Delete recipe', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete recipe', exact: true }).click();
  await expect(topPages(page)).toContainText('25–48 of 48 recipes');
  await expect(page.locator('.recipe-card')).toHaveCount(24);
  await expect(nextPage(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'View Library recipe 025' })).toBeVisible();
});

test('empty and exact page-size boundaries never produce an empty or negative page', async ({ page }) => {
  const library = await mockLibrary(page, 0);
  await page.goto('/#recipes');
  await expect(page.getByRole('heading', { name: 'Your family cookbook starts here.' })).toBeVisible();
  await expect(topPages(page)).toHaveCount(0);
  for (const count of [1, 24, 25, 48, 49]) {
    library.replace(count); await library.refresh();
    if (count <= 24) {
      await expect(page.locator('.recipe-card')).toHaveCount(count);
      await expect(topPages(page)).toHaveCount(0);
    } else {
      while (await nextPage(page).isEnabled()) await nextPage(page).click();
      const lastPage = Math.ceil(count / 24);
      await expect(topPages(page)).toContainText(`Page ${lastPage} of ${lastPage}`);
      await expect(page.locator('.recipe-card')).toHaveCount(count - (lastPage - 1) * 24);
      await expect(nextPage(page)).toBeDisabled();
    }
  }
  library.replace(0); await library.refresh();
  await expect(page.getByRole('heading', { name: 'Your family cookbook starts here.' })).toBeVisible();
  await expect(topPages(page)).toHaveCount(0);
  await expect(page.locator('.recipe-card')).toHaveCount(0);
});
