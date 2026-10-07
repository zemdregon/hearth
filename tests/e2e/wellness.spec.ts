import { expect, test, type Page } from '@playwright/test';
import { addDays, todayInTimezone } from '../../src/shared/calendar';

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
