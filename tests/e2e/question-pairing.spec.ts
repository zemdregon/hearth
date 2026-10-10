import { expect, test, type Page } from '@playwright/test';
import { createDemo, prepareDemoAnswer } from '../../src/client/demo';
import { visibleRecords } from '../../src/server/db';
import { addDays, todayInTimezone } from '../../src/shared/calendar';
import { questionForDate } from '../../src/shared/questions';
import type { Answer, Bootstrap, FamilyRecord, QuestionPair, User } from '../../src/shared/types';

const lee: User = { id: 'lee', name: 'Lee', role: 'admin', color: '#426c85' };
const today = () => todayInTimezone('UTC');
function answer(ownerId: string, date: string, data: Partial<Answer> = {}): FamilyRecord<'answer'> {
  return { id: `${ownerId}-${date}`, kind: 'answer', ownerId, version: 1, createdAt: `${date}T12:00:00Z`, updatedAt: `${date}T12:00:00Z`, data: { date, questionId: questionForDate(date).id, choice: 0, shareToProfile: false, participantIds: ['alex', 'sam'], ...data } };
}
async function refresh(page: Page) {
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/bootstrap')), page.evaluate(() => window.dispatchEvent(new Event('online')))]);
}
async function household(page: Page, records: FamilyRecord<'answer'>[] = [], pair: QuestionPair | null = ['alex', 'sam']) {
  const source: Bootstrap = { ...createDemo(), demo: false, members: [...createDemo().members, lee], questionPair: pair };
  source.records.push(...records);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...source, records: visibleRecords(source.records, source.user, source.members, source.modules, source.questionPair) } }));
  await page.route('**/api/records**', async route => {
    try {
      const id = new URL(route.request().url()).pathname.split('/')[3];
      const body = route.request().postDataJSON() as { kind?: string; data: Answer; version?: number };
      const original = source.records.find(record => record.id === id);
      if (route.request().method() === 'POST') {
        if (body.kind !== 'answer') throw new Error('Unexpected record type.');
        const data = prepareDemoAnswer(source, body.data);
        const created = answer(source.user.id, data.date, data);
        source.records.push(created);
        await route.fulfill({ status: 201, json: created }); return;
      }
      if (!original || original.kind !== 'answer' || original.ownerId !== source.user.id || original.version !== body.version) throw new Error('This answer changed. Refresh before trying again.');
      if (route.request().method() === 'DELETE') {
        source.records = source.records.filter(record => record.id !== id);
        await route.fulfill({ json: { ok: true } }); return;
      }
      const updated = { ...original, version: original.version + 1, data: prepareDemoAnswer(source, body.data, original) };
      source.records = source.records.map(record => record.id === id ? updated : record);
      await route.fulfill({ json: updated });
    } catch (error) { await route.fulfill({ status: 409, json: { error: error instanceof Error ? error.message : 'Could not save.' } }); }
  });
  await page.goto('/#questions');
  return {
    source,
    async member(id: string, module = 'questions') {
      source.user = source.members.find(member => member.id === id)!;
      await refresh(page);
      await page.evaluate(value => { window.location.hash = value; }, module);
    },
    async configure(next: QuestionPair | null) { source.questionPair = next; await refresh(page); },
  };
}
async function profile(page: Page, name: string) {
  await page.evaluate(() => { window.location.hash = 'profiles'; });
  await page.getByRole('group', { name: 'Choose a family member' }).getByRole('button', { name: new RegExp(name) }).click();
}

test('a couple reveals privately in a larger household and explicitly releases preferences to the whole family', async ({ page }, testInfo) => {
  const home = await household(page);
  await expect(page.getByText('You & Sam', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).not.toBeChecked();
  await page.locator('.question-choice').first().click();
  await page.getByRole('button', { name: 'Save my answer', exact: true }).click();
  await expect(page.locator('.question-result')).toHaveCount(0);
  await home.member('sam');
  await expect(page.locator('.question-result')).toHaveCount(0);
  await page.locator('.question-choice').nth(1).click();
  await page.getByRole('button', { name: 'Save my answer', exact: true }).click();
  await expect(page.locator('.question-result')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('private-pair-reveal.png'), fullPage: true });
  await home.member('lee');
  await expect(page.getByRole('heading', { name: 'A space for two' })).toBeVisible();
  await expect(page.locator('.question-result')).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await profile(page, 'Alex');
  await expect(page.locator('.family-preference')).toHaveCount(0);
  await home.member('alex');
  await page.getByRole('button', { name: 'Edit answer', exact: true }).click();
  await expect(page.getByText('Your whole family can see this preference', { exact: false })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await home.member('lee', 'profiles');
  await profile(page, 'Alex');
  await expect(page.locator('.family-preference')).toHaveCount(1);
  // Lee receives only Alex's released preference, not Sam's private answer.
  const received = await page.evaluate(async () => {
    const body = await (await fetch('/api/bootstrap')).json() as { records: { kind: string; ownerId: string }[] };
    return body.records.filter(record => record.kind === 'answer');
  });
  expect(received.map((record: {ownerId: string}) => record.ownerId)).toEqual(['alex']);
  // The dashboard must not invite an unpaired member to a conversation "just for the two of you".
  await page.evaluate(() => { window.location.hash = ''; });
  await expect(page.getByText('Welcome home, Lee.')).toBeVisible();
  await expect(page.getByText('just for the two of you')).toHaveCount(0);
  await home.member('alex', '');
  await expect(page.getByText('just for the two of you')).toBeVisible();
  await home.member('lee');
  await page.evaluate(() => { window.location.hash = 'questions'; });
  await expect(page.getByRole('heading', { name: 'A space for two' })).toBeVisible();
  await expect(page.locator('.question-history')).toHaveCount(0);
  await expect(page.locator('.daily-question')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('unpaired-household-member.png'), fullPage: true });
  await home.member('alex');
  await page.getByRole('button', { name: 'Edit answer', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).uncheck();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await home.member('lee', 'profiles');
  await profile(page, 'Alex');
  await expect(page.locator('.family-preference')).toHaveCount(0);
});

test('a pairing change clears unsaved choices and consent before submission to the new partner', async ({ page }) => {
  const home = await household(page);
  await page.locator('.question-choice').first().click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  await home.configure(['alex', 'lee']);
  await expect(page.getByText('You & Lee', { exact: true })).toBeVisible();
  await expect(page.locator('.question-choice input:checked')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Save my answer', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Your question pairing changed.' })).toBeVisible();
  await page.locator('.question-choice').nth(1).click();
  await page.getByRole('button', { name: 'Save my answer', exact: true }).click();
  await expect(page.locator('.question-own-answer')).toBeVisible();
  const saved = home.source.records.find(record => record.kind === 'answer' && record.ownerId === 'alex');
  expect(saved?.data).toMatchObject({ participantIds: ['alex', 'lee'], shareToProfile: false, choice: 1 });
});

test('legacy preferences and unmatched pair history remain private and can be withdrawn or deleted', async ({ page }) => {
  const yesterday = addDays(today(), -1);
  const legacy = answer('alex', yesterday, { participantIds: undefined, shareToProfile: true });
  const pending = answer('alex', addDays(today(), -2), { shareToProfile: true });
  const home = await household(page, [legacy, pending]);
  await expect(page.getByText('Saved before pairing · private to you.')).toBeVisible();
  await profile(page, 'Alex');
  await expect(page.locator('.family-preference')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '1 preference is waiting for your partner' })).toBeVisible();
  await home.configure(null);
  await page.evaluate(() => { window.location.hash = 'questions'; });
  await expect(page.getByRole('heading', { name: 'A space for two' })).toBeVisible();
  await expect(page.getByText('Saved before pairing · private to you.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Add answer to profile/ })).toHaveCount(0);
  const legacyArticle = page.locator('.question-history-card').filter({ hasText: questionForDate(yesterday).prompt });
  await legacyArticle.getByRole('button', { name: /^Remove answer from profile/ }).click();
  expect(home.source.records.find(record => record.id === legacy.id)?.data).toMatchObject({ shareToProfile: false });
  expect((home.source.records.find(record => record.id === legacy.id)?.data as Answer).participantIds).toBeUndefined();
  await legacyArticle.getByRole('button', { name: /^Delete my answer/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete answer', exact: true }).click();
  await expect(page.getByText('Saved before pairing · private to you.')).toHaveCount(0);
  await home.member('lee');
  await expect(page.locator('.question-history')).toHaveCount(0);
});

test('a same-day pair change never reassigns existing answers or reveals them to the new partner', async ({ page }) => {
  const original = [answer('alex', today(), { shareToProfile: true }), answer('sam', today(), { choice: 1, shareToProfile: true })];
  const home = await household(page, original);
  const before = JSON.stringify(home.source.records.filter(record => record.kind === 'answer'));
  await expect(page.locator('.question-result')).toHaveCount(2);
  await home.configure(['alex', 'lee']);
  await expect(page.getByText('Today’s saved answer belongs to an earlier pairing.', { exact: false })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.locator('.question-result')).toHaveCount(0);
  await home.member('lee');
  await expect(page.locator('.question-own-answer')).toHaveCount(0);
  await expect(page.locator('.question-result')).toHaveCount(0);
  await page.locator('.question-choice').first().click();
  await page.getByRole('button', { name: 'Save my answer', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Start a new question tomorrow' })).toBeVisible();
  expect(JSON.stringify(home.source.records.filter(record => record.kind === 'answer'))).toBe(before);
  await profile(page, 'Alex');
  await expect(page.locator('.family-preference')).toHaveCount(0);
});
