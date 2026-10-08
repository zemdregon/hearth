import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';
import type { Bootstrap, FamilyCapacity, FamilyRecord } from '../../src/shared/types';

function familyFixture(capacity?: FamilyCapacity): Bootstrap {
  return { ...createDemo(), demo: false, records: [], capacity };
}

async function refresh(page: Page) {
  const response = page.waitForResponse('**/api/bootstrap');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response;
}

const states = [
  { capacity: 'available', label: 'Storage available', notice: false },
  { capacity: 'near-limit', label: 'Family storage is nearly full', notice: true },
  { capacity: 'full', label: 'Family storage has reached a limit', notice: true },
  { capacity: undefined, label: 'Storage status unavailable', notice: false },
] as const;

for (const state of states) {
  test(`${state.capacity ?? 'missing'} capacity uses family guidance without deriving usage from visible records`, async ({ page }) => {
    const fixture = familyFixture(state.capacity);
    // A member with no visible records can still receive a family-wide warning.
    fixture.user = fixture.members.find(member => member.role === 'member')!;
    await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
    await page.goto('/#settings');
    const card = page.getByRole('region', { name: 'Family storage', exact: true });
    await expect(card.getByRole('status')).toHaveText(state.label);
    await expect(card).toContainText('whole family, including private records and paused modules');
    await expect(card).toContainText('Pausing a module preserves its data and does not free storage.');
    await expect(card).toContainText('only records visible to you in enabled modules');
    await expect(card).toContainText('do not remove data or back up the whole family');
    await expect(card).toContainText('Review records with their owners');
    await expect(card).toContainText('never deletes records automatically');
    expect(await card.innerText()).not.toMatch(/\d|%|\bbytes?\b/i);
    for (const member of fixture.members) expect(await card.innerText()).not.toContain(member.name);
    await expect(page.getByRole('button', { name: 'Export data', exact: true })).toBeEnabled();
    const notice = page.getByRole('complementary', { name: 'Family storage notice' });
    if (state.notice) {
      await expect(notice).toContainText(state.label);
      await expect(notice.getByRole('link', { name: 'Review family storage' })).toHaveAttribute('href', '#settings');
    } else {
      await expect(notice).toHaveCount(0);
      await expect(card).toContainText(state.capacity ? 'A larger save can still reach a limit.' : 'Available space cannot be confirmed.');
    }
  });
}

test('capacity refreshes preserve open drafts and keep guidance across views', async ({ page }) => {
  const fixture = familyFixture('available');
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.goto('/#tasks');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const draft = page.getByLabel('What needs doing?');
  await draft.fill('Keep this unsaved family plan');
  for (const capacity of ['near-limit', 'full', undefined] as const) {
    fixture.capacity = capacity;
    await refresh(page);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(draft).toHaveValue('Keep this unsaved family plan');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Add task', exact: true })).toBeEnabled();
    await expect(page.locator('.capacity-notice')).toHaveCount(capacity ? 1 : 0);
    if (capacity) await expect(page.locator('.capacity-notice')).toContainText(capacity === 'full' ? 'has reached a limit' : 'is nearly full');
  }
  await page.getByRole('button', { name: 'Close dialog' }).click();
  fixture.capacity = 'full';
  fixture.modules = fixture.modules.map(module => module.id === 'recipes' ? { ...module, enabled: false } : module);
  await refresh(page);
  const notice = page.getByRole('complementary', { name: 'Family storage notice' });
  for (const view of ['today', 'recipes', 'settings']) {
    await page.evaluate(value => { window.location.hash = value; }, view);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Family storage has reached a limit');
  }
  await page.evaluate(() => { window.location.hash = 'today'; });
  await notice.getByRole('link', { name: 'Review family storage' }).click();
  await expect(page.getByRole('region', { name: 'Family storage', exact: true })).toBeVisible();
});

test('a confirmed save invalidates previous guidance if the following refresh fails', async ({ page }) => {
  const fixture = familyFixture('full');
  let connectionLost = false;
  await page.route('**/api/bootstrap', route => connectionLost ? route.abort('failed') : route.fulfill({ json: fixture }));
  await page.route('**/api/records', async route => {
    const body = route.request().postDataJSON();
    const record: FamilyRecord = { id: 'capacity-confirmed-save', kind: body.kind, data: body.data, ownerId: fixture.user.id, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    connectionLost = true;
    await route.fulfill({ status: 201, json: record });
  });
  await page.goto('/#tasks');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByLabel('What needs doing?').fill('Saved with capacity guidance');
  await page.getByRole('dialog').getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved with capacity guidance', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  await expect(page.locator('.capacity-notice')).toHaveCount(0);
  await page.getByRole('link', { name: 'Make it your own', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Family storage', exact: true }).getByRole('status')).toHaveText('Storage status unavailable');
});

test('mobile capacity guidance is accessible, fits the screen, and stays out of print', async ({ page }) => {
  const fixture = familyFixture('near-limit');
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#settings');
  const card = page.getByRole('region', { name: 'Family storage', exact: true });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.capacity-notice')).toBeHidden();
  await expect(page.locator('.family-capacity')).toBeHidden();
});

test('recipe print sheets exclude capacity warnings and family guidance', async ({ page }) => {
  const fixture = { ...createDemo(), demo: false, capacity: 'full' as const };
  fixture.records = fixture.records.filter(record => record.kind === 'recipe');
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.goto('/#recipes');
  await expect(page.locator('.capacity-notice')).toBeVisible();
  await page.getByRole('button', { name: 'View Sunday lemon & herb chicken', exact: true }).click();
  await page.emulateMedia({ media: 'print' });
  const sheet = page.getByRole('article', { name: 'Recipe print sheet' });
  await expect(sheet).toBeVisible();
  await expect(page.locator('.capacity-notice')).toBeHidden();
  const printed = (await page.locator('body').innerText()).trim();
  expect(printed).toBe((await sheet.innerText()).trim());
  expect(printed).not.toContain('Family storage');
});

test('sign-out clears capacity and a late refresh cannot restore it', async ({ page }) => {
  const fixture = familyFixture('full');
  let delay = false;
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/bootstrap', async route => {
    if (delay) await pending;
    await route.fulfill({ json: fixture });
  });
  await page.goto('/#settings');
  await expect(page.locator('.capacity-notice')).toBeVisible();
  delay = true;
  const request = page.waitForRequest('**/api/bootstrap');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await request;
  await page.evaluate(() => { const channel = new BroadcastChannel('hearth-session'); channel.postMessage('logout'); channel.close(); });
  await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
  const response = page.waitForResponse('**/api/bootstrap');
  release?.();
  await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.capacity-notice,.family-capacity')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
});
