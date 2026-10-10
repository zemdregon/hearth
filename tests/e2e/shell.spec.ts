import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { createDemo } from '../../src/client/demo';

async function openDemo(page: Page, view = 'today') {
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, json: { error: 'Local deployment has not been configured.' } }));
  await page.goto(`/#${view}`);
  await page.getByRole('button', { name: 'Explore the local demo' }).click();
}

test('authentication gate distinguishes local demo and real family sign-in', async ({ page }) => {
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, json: { error: 'Local deployment has not been configured.' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByText('Local deployment has not been configured.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Explore the local demo' }).click();
  await expect(page.getByRole('button', { name: 'Local demo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Your account and family members' }).click();
  await page.getByRole('button', { name: 'Leave demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
});

test('module pause hides its UI, preserves records, and exports only visible demo data', async ({ page }) => {
  await openDemo(page, 'settings');
  await page.getByRole('switch', { name: 'Recipe book', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Recipe book', exact: true })).not.toBeChecked();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Recipe book' })).toHaveCount(0);
  await page.goto('/#recipes');
  await expect(page.getByRole('heading', { name: 'A little room to pause' })).toBeVisible();
  await page.getByRole('button', { name: 'Make it your own', exact: true }).click();
  await page.getByRole('switch', { name: 'Recipe book', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Recipe book' }).click();
  await expect(page.getByRole('heading', { name: 'Sunday lemon & herb chicken', exact: true })).toBeVisible();
  await page.goto('/#settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export data' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^hearth-demo-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported.demo).toBe(true);
  expect(exported.records.some((record: { id: string }) => record.id === 'recipe-lemon')).toBe(true);
  expect(exported.records.some((record: { id: string }) => record.id === 'mood-sam')).toBe(false);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('demo member switching respects administrator controls', async ({ page }) => {
  await openDemo(page, 'settings');
  await page.getByRole('button', { name: 'Your account and family members' }).click();
  await page.getByRole('button', { name: 'View as' }).click();
  await expect(page.getByText('Your family administrator can change which modules are enabled.')).toBeVisible();
  for (const control of await page.getByRole('switch').all()) await expect(control).toBeDisabled();
});

test('empty real family dashboard reports real zeros with no sample memories', async ({ page }) => {
  const bootstrap = { ...createDemo(), demo: false, records: [] };
  await page.route('**/api/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A lovely clear list' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Start a family favorite' })).toBeVisible();
  await expect(page.getByText('No dates just yet')).toBeVisible();
  await expect(page.getByText('Sunday lemon & herb chicken')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Local demo', exact: true })).toHaveCount(0);
});

test('mobile navigation restores focus and shared dashboard remains accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  await menu.click();
  await expect(page.locator('.sidebar .mobile-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
  await menu.click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Little notes' }).click();
  await expect(page.getByRole('heading', { name: 'Little notes' })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
  await page.getByRole('navigation', { name: 'Quick navigation' }).getByRole('link', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'View family reminders' }).click();
  await expect(page.getByRole('dialog')).toContainText('Pick up fresh flowers for the table');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'View family reminders' })).toBeFocused();
});
