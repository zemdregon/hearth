import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';
import { addDays, todayInTimezone } from '../../src/shared/calendar';
import type { Bootstrap, FamilyRecord } from '../../src/shared/types';

function moodFamily(ownCount: number, sharedPartnerCount = 0): Bootstrap {
  const family = createDemo();
  const today = todayInTimezone('UTC');
  const records: FamilyRecord<'mood'>[] = [];
  for (let index = 1; index <= ownCount; index += 1) {
    const date = addDays(today, -index);
    records.push({ id: `own-${index}`, kind: 'mood', ownerId: family.user.id, version: 1, createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, data: { date, score: 4, shared: index % 5 === 0, note: `Fictional own reflection ${index}.` } });
  }
  for (let index = 1; index <= sharedPartnerCount; index += 1) {
    const date = addDays(today, -index);
    records.push({ id: `partner-${index}`, kind: 'mood', ownerId: family.members[1].id, version: 1, createdAt: `${date}T13:00:00.000Z`, updatedAt: `${date}T13:00:00.000Z`, data: { date, score: 3, shared: true, note: `Fictional partner reflection ${index}.` } });
  }
  return { ...family, demo: false, records };
}

async function openFamily(page: Page, family: Bootstrap) {
  await page.route('**/api/bootstrap', route => route.fulfill({ json: family }));
  await page.goto('/#moods');
  await expect(page.getByRole('heading', { name: 'How are you, really?' })).toBeVisible();
}

const next = (page: Page) => page.getByRole('navigation', { name: 'Mood history pages, top' }).getByRole('button', { name: 'Next mood page' });
const previous = (page: Page) => page.getByRole('navigation', { name: 'Mood history pages, top' }).getByRole('button', { name: 'Previous mood page' });

test('five years of moods stay bounded, ordered, and retain an unsaved draft across pages and filters', async ({ page }) => {
  await openFamily(page, moodFamily(1825, 40));
  const cards = page.locator('.mood-history-card');
  await expect(cards).toHaveCount(30);
  await expect(page.getByText('Showing 1–30 of 1,825 check-ins', { exact: true })).toBeVisible();
  await expect(cards.first()).toContainText('Fictional own reflection 1.');
  await expect(cards.last()).toContainText('Fictional own reflection 30.');
  await expect(previous(page)).toBeDisabled();
  await page.getByRole('radio', { name: 'Good', exact: true }).check();
  const note = page.getByRole('textbox', { name: 'Anything on your mind?' });
  await note.fill('A new unsaved thought, kept while browsing older memories.');
  await next(page).click();
  await expect(page.getByText('Showing 31–60 of 1,825 check-ins', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(30);
  await expect(cards.first()).toContainText('Fictional own reflection 31.');
  await expect(cards.last()).toContainText('Fictional own reflection 60.');
  await next(page).click();
  await expect(cards.first()).toContainText('Fictional own reflection 61.');
  await previous(page).click();
  await expect(cards.first()).toContainText('Fictional own reflection 31.');
  await page.getByRole('button', { name: 'Shared with family', exact: true }).click();
  await expect(page.getByText('Showing 1–30 of 405 check-ins', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(30);
  await expect(previous(page)).toBeDisabled();
  await expect(cards.first()).toContainText('Fictional partner reflection 1.');
  await expect(note).toHaveValue('A new unsaved thought, kept while browsing older memories.');
  await expect(page.getByRole('radio', { name: 'Good', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'My check-ins', exact: true }).click();
  await expect(page.getByText('Showing 1–30 of 1,825 check-ins', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(30);
});

test('editing an older check-in remains tied to its record when its page is left', async ({ page }) => {
  const family = moodFamily(95, 10);
  let patchedId = '';
  await page.route('**/api/records/*', async route => {
    if (route.request().method() !== 'PATCH') return route.abort();
    patchedId = route.request().url().split('/').at(-1)!;
    const original = family.records.find(record => record.id === patchedId)!;
    const body = route.request().postDataJSON();
    expect(body.version).toBe(original.version);
    const saved = { ...original, data: body.data, version: original.version + 1 } as FamilyRecord;
    family.records = family.records.map(record => record.id === patchedId ? saved : record);
    await route.fulfill({ json: saved });
  });
  await openFamily(page, family);
  await next(page).click();
  await page.locator('.mood-history-card').first().getByRole('button', { name: /^Edit/ }).click();
  const note = page.getByRole('textbox', { name: 'Anything on your mind?' });
  await note.fill('This edit belongs to the older thirty-first entry.');
  await next(page).click();
  await page.getByRole('button', { name: 'Shared with family', exact: true }).click();
  await expect(note).toHaveValue('This edit belongs to the older thirty-first entry.');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(addDays(todayInTimezone('UTC'), -31));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect(patchedId).toBe('own-31');
  await page.getByRole('button', { name: 'My check-ins', exact: true }).click();
  await next(page).click();
  await expect(page.locator('.mood-history-card').first()).toContainText('This edit belongs to the older thirty-first entry.');
});

test('deleting the last item on a page clamps the history without dropping another draft', async ({ page }) => {
  const family = moodFamily(61);
  await page.route('**/api/records/*', async route => {
    if (route.request().method() !== 'DELETE') return route.abort();
    const id = route.request().url().split('/').at(-1)!;
    expect(route.request().postDataJSON().version).toBe(1);
    family.records = family.records.filter(record => record.id !== id);
    await route.fulfill({ json: { ok: true } });
  });
  await openFamily(page, family);
  const note = page.getByRole('textbox', { name: 'Anything on your mind?' });
  await note.fill('A draft kept while removing an unrelated old entry.');
  await next(page).click();
  await next(page).click();
  await expect(page.getByText('Showing 61–61 of 61 check-ins', { exact: true })).toBeVisible();
  await expect(page.locator('.mood-history-card')).toHaveCount(1);
  await expect(next(page)).toBeDisabled();
  await page.locator('.mood-history-card').getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete check-in', exact: true }).click();
  await expect(page.getByText('Showing 31–60 of 60 check-ins', { exact: true })).toBeVisible();
  await expect(page.locator('.mood-history-card')).toHaveCount(30);
  await expect(next(page)).toBeDisabled();
  await expect(note).toHaveValue('A draft kept while removing an unrelated old entry.');
});

test('mobile history controls and ranges are accessible and bottom paging returns to the heading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFamily(page, moodFamily(730));
  const bottom = page.getByRole('navigation', { name: 'Mood history pages, bottom' });
  await bottom.getByRole('button', { name: 'Next mood page' }).click();
  await expect(page.getByRole('heading', { name: 'Life, day by day' })).toBeFocused();
  await expect(page.getByText('Showing 31–60 of 730 check-ins', { exact: true })).toBeVisible();
  await expect(page.locator('.mood-history-card')).toHaveCount(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const audit = await new AxeBuilder({ page }).include('#main-content').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.mood-history-page-number').first()).toHaveCSS('font-size', '12px');
});
