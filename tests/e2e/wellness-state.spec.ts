import { expect, test, type Page } from '@playwright/test';
import { createDemo } from '../../src/client/demo';
import { todayInTimezone } from '../../src/shared/calendar';
import { questionForDate } from '../../src/shared/questions';
import type { FamilyRecord } from '../../src/shared/types';

async function demo(page: Page, module: string) {
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, json: { error: 'Local demo test.' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the local demo' }).click();
  await page.evaluate(value => { window.location.hash = value; }, module);
}

async function switchMember(page: Page, name: string) {
  await page.getByRole('button', { name: 'Your account and family members' }).click();
  await page.locator('.profile-menu-member').filter({ has: page.getByText(name, { exact: true }) }).getByRole('button', { name: 'View as' }).click();
}

async function rollover(page: Page, timestamp: string) {
  await page.clock.setFixedTime(new Date(timestamp));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

test('a question draft survives a concurrent update and submits its original version', async ({ page }) => {
  const fixture = { ...createDemo(), demo: false };
  const date = todayInTimezone('UTC');
  const question = questionForDate(date);
  let current: FamilyRecord<'answer'> = { id: 'answer-alex', kind: 'answer', ownerId: 'alex', version: 1, createdAt: `${date}T08:00:00Z`, updatedAt: `${date}T08:00:00Z`, data: { date, questionId: question.id, choice: 0, shareToProfile: false, participantIds: ['alex', 'sam'] } };
  fixture.records.push(current);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  const sentVersions: number[] = [];
  await page.route('**/api/records/answer-alex', async route => {
    const body = route.request().postDataJSON() as { version: number; data: FamilyRecord<'answer'>['data'] };
    sentVersions.push(body.version);
    if (body.version !== current.version) { await route.fulfill({ status: 409, json: { error: 'Someone changed this answer. Review the latest version before trying again.' } }); return; }
    current = { ...current, data: body.data, version: current.version + 1 };
    fixture.records = fixture.records.map(record => record.id === current.id ? current : record);
    await route.fulfill({ json: current });
  });
  await page.goto('/#questions');
  await page.getByRole('button', { name: 'Edit answer', exact: true }).click();
  await page.locator('.question-choice').nth(1).click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  // Another tab saves a different choice while this tab's form is still open.
  current = { ...current, version: 2, data: { ...current.data, choice: 2 } };
  fixture.records = fixture.records.map(record => record.id === current.id ? current : record);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/bootstrap')),
    page.evaluate(() => window.dispatchEvent(new Event('online'))),
  ]);
  await expect(page.getByRole('radio', { name: question.choices[1], exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).toBeChecked();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Someone changed this answer' })).toBeVisible();
  expect(sentVersions).toEqual([1]);
  await expect(page.getByRole('radio', { name: question.choices[1], exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await expect(page.locator('.question-own-answer')).toContainText(question.choices[2]);
  await page.getByRole('button', { name: 'Edit answer', exact: true }).click();
  await page.locator('.question-choice').nth(3).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.question-own-answer')).toContainText(question.choices[3]);
  expect(sentVersions).toEqual([1, 2]);
});

test('switching members discards private mood and unsaved answer form state', async ({ page }) => {
  await demo(page, 'moods');
  await switchMember(page, 'Sam');
  await page.locator('article').filter({ hasText: 'A full day. A walk helped.' }).getByRole('button', { name: /^Edit/ }).click();
  await page.getByRole('textbox', { name: 'Anything on your mind?' }).fill('A private unsaved thought.');
  await switchMember(page, 'Alex');
  await expect(page.getByRole('textbox', { name: 'Anything on your mind?' })).toHaveValue('');
  await expect(page.getByText('A full day. A walk helped.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Edit your check-in' })).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = 'questions'; });
  await page.locator('.question-choice').first().click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  await switchMember(page, 'Sam');
  await expect(page.locator('.question-choice input:checked')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).not.toBeChecked();
});

test('an unsaved first answer does not silently replace one created in another window', async ({ page }) => {
  const fixture = { ...createDemo(), demo: false };
  const date = todayInTimezone('UTC');
  const question = questionForDate(date);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  const attemptedMethods: string[] = [];
  await page.route('**/api/records', route => {
    attemptedMethods.push(route.request().method());
    return route.fulfill({ status: 409, json: { error: 'An answer already exists for this day.' } });
  });
  await page.goto('/#questions');
  await page.locator('.question-choice').nth(1).click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  fixture.records.push({ id: 'answer-other-window', kind: 'answer', ownerId: 'alex', version: 1, createdAt: `${date}T08:00:00Z`, updatedAt: `${date}T08:00:00Z`, data: { date, questionId: question.id, choice: 2, shareToProfile: false, participantIds: ['alex', 'sam'] } });
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/bootstrap')),
    page.evaluate(() => window.dispatchEvent(new Event('online'))),
  ]);
  await expect(page.getByText('An answer was saved in another window. Your unsaved choice is kept here.')).toBeVisible();
  await expect(page.getByRole('radio', { name: question.choices[1], exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Save my answer', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An answer already exists for this day.' })).toBeVisible();
  expect(attemptedMethods).toEqual(['POST']);
  await expect(page.getByRole('radio', { name: question.choices[1], exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).toBeChecked();
  await page.getByRole('button', { name: 'Review saved answer', exact: true }).click();
  await expect(page.locator('.question-own-answer')).toContainText(question.choices[2]);
  await expect(page.getByText('This answer will stay off your profile.')).toBeVisible();
});

test('an untouched mood form follows midnight while an unfinished check-in keeps its date', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T23:59:00Z'));
  await demo(page, 'moods');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-10-31');
  await rollover(page, '2026-11-01T00:01:00Z');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-11-01');
  await page.getByRole('radio', { name: 'Good', exact: true }).check();
  await page.getByRole('textbox', { name: 'Anything on your mind?' }).fill('A thought from the end of the day.');
  await rollover(page, '2026-11-02T00:01:00Z');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-11-01');
  await expect(page.getByRole('textbox', { name: 'Anything on your mind?' })).toHaveValue('A thought from the end of the day.');
  await expect(page.getByRole('status').filter({ hasText: 'Your unfinished check-in is still dated Nov 1, 2026.' })).toBeVisible();
});

test('a new day clears the previous daily answer selection and profile-sharing consent', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T23:59:00Z'));
  await demo(page, 'questions');
  await page.locator('.question-choice').first().click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  await rollover(page, '2026-11-01T00:01:00Z');
  await expect(page.locator('.daily-question')).toHaveText(questionForDate('2026-11-01').prompt);
  await expect(page.locator('.question-choice input:checked')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Save my answer', exact: true })).toBeDisabled();
});

test('the current streak calendar follows a new month without interrupting a past-month view', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T23:59:00Z'));
  await demo(page, 'streaks');
  await rollover(page, '2026-11-01T00:01:00Z');
  await expect(page.getByRole('heading', { name: 'November 2026', exact: true })).toBeVisible();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toContainText('1');
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible();
  await rollover(page, '2026-12-01T00:01:00Z');
  await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'December 2026', exact: true })).toBeVisible();
});
