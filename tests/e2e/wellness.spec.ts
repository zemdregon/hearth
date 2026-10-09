import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addDays, formatDate, todayInTimezone } from '../../src/shared/calendar';
import { createDemo } from '../../src/client/demo';
import type { Bootstrap, FamilyCapacity } from '../../src/shared/types';

async function demo(page: Page, module: string) {
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Local demo test.' }) }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the local demo' }).click();
  await page.evaluate(value => { window.location.hash = value; }, module);
}

async function switchMember(page: Page, name: string) {
  await page.getByRole('button', { name: 'Your account and family members' }).click();
  await page.locator('.profile-menu-member').filter({ has: page.getByText(name, { exact: true }) }).getByRole('button', { name: 'View as' }).click();
}

test('habit owner can check in and undo while another member can only view', async ({ page }) => {
  await demo(page, 'streaks');
  await expect(page.getByRole('heading', { name: 'Every day adds up.' })).toBeVisible();
  await page.getByRole('button', { name: 'Check in for today', exact: true }).click();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.streak-stats > div').first()).toContainText('8');
  await page.getByRole('button', { name: 'Checked in today · undo' }).click();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toBeVisible();
  await switchMember(page, 'Sam');
  await expect(page.getByText('Only they can change their check-ins.', { exact: false })).toBeVisible();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check in for today', exact: true })).toHaveCount(0);
});

test('habit creation and deletion preserve a usable empty calendar', async ({ page }) => {
  await demo(page, 'streaks');
  await page.getByRole('button', { name: 'Add a habit' }).click();
  await page.getByLabel('Habit name').fill('A few pages before bed');
  await page.getByRole('button', { name: 'Create habit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A few pages before bed' })).toBeVisible();
  await expect(page.locator('.streak-stats > div').first()).toContainText('0');
  await page.getByRole('button', { name: 'Check in for today', exact: true }).click();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Delete A few pages before bed' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete habit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A few pages before bed' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A little fresh air', exact: true })).toBeVisible();
});

test('the backdate dialog speaks plainly about one day, large spans, errors and closing', async ({ page }) => {
  await demo(page, 'streaks');
  const today = todayInTimezone('UTC');
  const yesterday = addDays(today, -1);
  await page.getByRole('button', { name: 'Add a habit' }).click();
  const dialog = page.getByRole('dialog');
  const start = dialog.getByLabel('Already doing this?');
  await dialog.getByLabel('Habit name').fill('Evening walk');
  // One day: singular, and a single date instead of “Oct 8 through Oct 8”.
  await start.fill(yesterday);
  const help = dialog.locator('#habit-start-help');
  await expect(help).toHaveText(`Counts 1 day as checked in, ${formatDate(yesterday)}. You can uncheck any day afterward.`);
  await expect(help).not.toContainText('through');
  await start.fill(addDays(today, -5));
  await expect(help).toHaveText(`Counts 5 days as checked in, ${formatDate(addDays(today, -5))} through ${formatDate(yesterday)}. You can uncheck any day afterward.`);
  await expect(dialog.getByText('This adds one check-in record for each day.')).toHaveCount(0);
  // A long span says how many records it makes; a roomy family space needs no warning.
  await start.fill(addDays(today, -40));
  await expect(dialog.getByText('This adds one check-in record for each day.')).toBeVisible();
  await expect(start).toHaveAccessibleDescription(/This adds one check-in record for each day\./);
  await expect(dialog.getByText(/may not fit/)).toHaveCount(0);
  // An invalid start is an error, in the error style, announced as an alert.
  await start.fill(addDays(today, -400));
  await expect(help).toHaveAttribute('role', 'alert');
  await expect(help).toHaveClass(/wellness-error/);
  await expect(help).not.toHaveClass(/muted/);
  // Cancelling clears both the name and the date.
  await start.fill(addDays(today, -5));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a habit' }).click();
  await expect(dialog.getByLabel('Habit name')).toHaveValue('');
  await expect(dialog.getByLabel('Already doing this?')).toHaveValue('');
  // A habit that started yesterday has a one-day streak, and says “1 day”.
  await dialog.getByLabel('Habit name').fill('Evening walk');
  await dialog.getByLabel('Already doing this?').fill(yesterday);
  await dialog.getByRole('button', { name: 'Create habit', exact: true }).click();
  const mini = page.locator('.habit-selector').filter({ hasText: 'Evening walk' }).locator('.habit-mini-streak');
  await expect(mini).toHaveText(/^1\s*day$/);
});

for (const capacity of ['near-limit', 'full'] as FamilyCapacity[]) {
  test.describe(`a family space that is ${capacity}`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test('warns that a long backdate may not fit, and shows server errors without a field prefix', async ({ page }) => {
      const fixture: Bootstrap = { ...createDemo(), demo: false, records: [], capacity };
      await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
      await page.route('**/api/habits', route => route.fulfill({ status: 400, json: { error: 'data.title: Choose a shorter habit name.' } }));
      await page.goto('/#streaks');
      await page.getByRole('button', { name: 'Add a habit' }).click();
      const dialog = page.getByRole('dialog');
      const today = todayInTimezone('UTC');
      await dialog.getByLabel('Habit name').fill('Evening walk');
      await dialog.getByLabel('Already doing this?').fill(addDays(today, -5));
      await expect(dialog.getByText(/may not fit/)).toHaveCount(0);
      await dialog.getByLabel('Already doing this?').fill(addDays(today, -40));
      await expect(dialog.getByRole('status').filter({ hasText: 'may not fit' })).toHaveText(capacity === 'full' ? 'Your family space has reached a storage limit, so a long backdate may not fit.' : 'Your family space is nearly full, so a long backdate may not fit.');
      expect((await new AxeBuilder({ page }).include('dialog[open], [role="dialog"]').analyze()).violations).toEqual([]);
      await dialog.getByRole('button', { name: 'Create habit', exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText('Choose a shorter habit name.');
    });
  });
}

test('a new habit can be backdated so earlier days count toward the streak', async ({ page }) => {
  await demo(page, 'streaks');
  const today = todayInTimezone('UTC');
  await page.getByRole('button', { name: 'Add a habit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Habit name').fill('Evening walk');
  const start = dialog.getByLabel('Already doing this?');
  await expect(start).toHaveAttribute('max', addDays(today, -1));
  await expect(dialog.getByText('every day through yesterday will count', { exact: false })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('dialog[open], [role="dialog"]').analyze()).violations).toEqual([]);
  await start.fill(addDays(today, -5));
  await expect(dialog.getByText('Counts 5 days as checked in', { exact: false })).toBeVisible();
  await start.fill(addDays(today, -400));
  await expect(dialog.getByRole('alert').filter({ hasText: 'at most 366 days' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create habit', exact: true })).toBeDisabled();
  await start.fill(addDays(today, -5));
  await dialog.getByRole('button', { name: 'Create habit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Evening walk' })).toBeVisible();
  const stats = page.locator('.streak-stats > div');
  await expect(stats.nth(0)).toContainText('5');
  await expect(stats.nth(1)).toContainText('5');
  await expect(stats.nth(2)).toContainText('5');
  await page.getByRole('button', { name: 'Check in for today', exact: true }).click();
  await expect(stats.nth(0)).toContainText('6');
  // A backfilled day is an ordinary check-in: unchecking it splits the streak.
  const split = addDays(today, -3);
  if (split.slice(0, 7) !== today.slice(0, 7)) await page.getByRole('button', { name: 'Previous month' }).click();
  await page.getByRole('button', { name: new RegExp(`^${formatDate(split).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, checked in`) }).click();
  await expect(stats.nth(0)).toContainText('3');
  await expect(stats.nth(2)).toContainText('5');
});

test('moods are private by default and sharing can be explicitly reversed', async ({ page }) => {
  await demo(page, 'moods');
  await page.getByLabel('Date', { exact: true }).fill(addDays(todayInTimezone('UTC'), -3));
  await page.getByRole('radio', { name: 'Good', exact: true }).check();
  await page.getByRole('textbox', { name: 'Anything on your mind?' }).fill('A private moment under the trees.');
  await expect(page.getByRole('checkbox', { name: 'Share this check-in with my family' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Save check-in', exact: true }).click();
  let entry = page.locator('article').filter({ hasText: 'A private moment under the trees.' });
  await expect(entry.getByText('Private', { exact: true })).toBeVisible();
  await switchMember(page, 'Sam');
  await page.getByRole('button', { name: 'Shared with family', exact: true }).click();
  await expect(page.getByText('A private moment under the trees.')).toHaveCount(0);
  await switchMember(page, 'Alex');
  await page.getByRole('button', { name: 'My check-ins', exact: true }).click();
  entry = page.locator('article').filter({ hasText: 'A private moment under the trees.' });
  await entry.getByRole('button', { name: /^Edit/ }).click();
  await page.getByRole('checkbox', { name: 'Share this check-in with my family' }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await switchMember(page, 'Sam');
  await page.getByRole('button', { name: 'Shared with family', exact: true }).click();
  entry = page.locator('article').filter({ hasText: 'A private moment under the trees.' });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await switchMember(page, 'Alex');
  await page.getByRole('button', { name: 'My check-ins', exact: true }).click();
  await page.locator('article').filter({ hasText: 'A private moment under the trees.' }).getByRole('button', { name: /^Edit/ }).click();
  await page.getByRole('checkbox', { name: 'Share this check-in with my family' }).uncheck();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await switchMember(page, 'Sam');
  await page.getByRole('button', { name: 'Shared with family', exact: true }).click();
  await expect(page.getByText('A private moment under the trees.')).toHaveCount(0);
  await switchMember(page, 'Alex');
  await page.getByRole('button', { name: 'My check-ins', exact: true }).click();
  await page.locator('article').filter({ hasText: 'A private moment under the trees.' }).getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete check-in', exact: true }).click();
  await expect(page.getByText('A private moment under the trees.')).toHaveCount(0);
});

test('daily answers reveal after both members answer and profile sharing is opt in', async ({ page }, testInfo) => {
  await demo(page, 'questions');
  await expect(page.locator('.daily-question')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('questions-desktop.png'), fullPage: true, animations: 'disabled' });
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).not.toBeChecked();
  const firstChoice = await page.locator('.question-choice').first().innerText();
  await page.locator('.question-choice').first().click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  await page.getByRole('button', { name: 'Save my answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your answer is tucked away.' })).toBeVisible();
  await expect(page.locator('.question-result')).toHaveCount(0);
  await switchMember(page, 'Sam');
  await expect(page.locator('.question-own-answer')).toHaveCount(0);
  await expect(page.locator('.question-result')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).not.toBeChecked();
  await page.locator('.question-choice').nth(1).click();
  await page.getByRole('button', { name: 'Save my answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A little more understood.' })).toBeVisible();
  await expect(page.locator('.question-result')).toHaveCount(2);
  await page.evaluate(() => { window.location.hash = 'profiles'; });
  await page.getByRole('group', { name: 'Choose a family member' }).getByRole('button', { name: /Alex/ }).click();
  await expect(page.getByText(firstChoice.replace(/^A\s*/, '').trim(), { exact: false }).first()).toBeVisible();
  await page.evaluate(() => { window.location.hash = 'questions'; });
  await switchMember(page, 'Alex');
  await page.getByRole('button', { name: 'Edit answer', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).uncheck();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('This answer will stay off your profile.')).toBeVisible();
  // Consent remains reversible after the next daily prompt arrives.
  await page.clock.setFixedTime(new Date(`${addDays(todayInTimezone('UTC'), 1)}T12:00:00Z`));
  await page.evaluate(() => { window.location.hash = 'profiles'; });
  await expect(page.getByRole('heading', { name: 'Our people', exact: true })).toBeVisible();
  await page.evaluate(() => { window.location.hash = 'questions'; });
  await page.getByRole('button', { name: /^Add answer to profile for/ }).click();
  await expect(page.getByRole('button', { name: /^Remove answer from profile for/ })).toBeVisible();
  await switchMember(page, 'Sam');
  await page.evaluate(() => { window.location.hash = 'profiles'; });
  await page.getByRole('group', { name: 'Choose a family member' }).getByRole('button', { name: /Alex/ }).click();
  await expect(page.locator('.family-preference')).toHaveCount(1);
  await switchMember(page, 'Alex');
  await page.evaluate(() => { window.location.hash = 'questions'; });
  await page.getByRole('button', { name: /^Remove answer from profile for/ }).click();
  await page.evaluate(() => { window.location.hash = 'profiles'; });
  await expect(page.locator('.family-preference')).toHaveCount(0);
});

test('wellness forms and calendars fit a small mobile viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page, 'streaks');
  for (const module of ['streaks', 'moods', 'questions']) {
    await page.evaluate(value => { window.location.hash = value; }, module);
    await expect(page.locator('.wellness-page')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${module}-mobile.png`), fullPage: true, animations: 'disabled' });
  }
});
