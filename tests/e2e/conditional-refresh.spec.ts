import { expect, test, type Page } from '@playwright/test';
import { createDemo } from '../../src/client/demo';
import { questionForDate } from '../../src/shared/questions';
import type { Bootstrap, FamilyRecord } from '../../src/shared/types';

const firstTag = `W/"hearth-${'a'.repeat(64)}"`;
const secondTag = `W/"hearth-${'b'.repeat(64)}"`;
const fixture = (): Bootstrap => ({ ...createDemo(), demo: false, timezone: 'UTC', capacity: 'available' });

async function refresh(page: Page) {
  const response = page.waitForResponse('**/api/bootstrap');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const received = await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return received;
}

async function conditionalFixture(page: Page, family = fixture()) {
  const validators: (string | undefined)[] = [];
  await page.route('**/api/bootstrap', route => {
    const validator = route.request().headers()['if-none-match'];
    validators.push(validator);
    return route.fulfill(validator ? { status: 304, headers: { etag: firstTag, 'cache-control': 'no-store, private' } } : { json: family, headers: { etag: firstTag, 'cache-control': 'no-store, private' } });
  });
  return validators;
}

test('bodyless refresh preserves a focused private draft and uses no persistent cache', async ({ page }) => {
  const privateDraft = 'Private draft that must never enter a browser cache';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch;
    const options: (RequestCache | undefined)[] = [];
    Object.assign(window, { bootstrapCacheOptions: options });
    window.fetch = (input, init) => {
      if (String(input).includes('/api/bootstrap')) options.push(init?.cache);
      return original(input, init);
    };
  });
  const family = fixture();
  const privateSnapshot = 'Private saved task only held in the family snapshot';
  const task = family.records.find(record => record.kind === 'task') as FamilyRecord<'task'>;
  task.data.title = privateSnapshot;
  const validators = await conditionalFixture(page, family);
  await page.goto('/#tasks');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const draft = page.getByLabel('What needs doing?');
  await draft.fill(privateDraft);
  const originalInput = await draft.elementHandle();
  for (let attempt = 0; attempt < 2; attempt++) expect((await refresh(page)).status()).toBe(304);
  await expect(draft).toHaveValue(privateDraft);
  await expect(draft).toBeFocused();
  expect(await originalInput!.evaluate(input => input.isSameNode(document.getElementById('task-title')))).toBe(true);
  expect(validators.at(-1)).toBe(firstTag);
  expect(errors).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const persistence = await page.evaluate(async () => ({
    cacheOptions: (window as unknown as { bootstrapCacheOptions: RequestCache[] }).bootstrapCacheOptions,
    local: Object.values(localStorage).join('\n'), session: Object.values(sessionStorage).join('\n'),
    requests: (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat(),
  }));
  expect(persistence.cacheOptions.length).toBeGreaterThan(1);
  expect(persistence.cacheOptions.every(option => option === 'no-store')).toBe(true);
  expect(persistence.local + persistence.session).not.toContain(firstTag);
  expect(persistence.local + persistence.session).not.toContain(privateDraft);
  expect(persistence.local + persistence.session).not.toContain(privateSnapshot);
  expect(persistence.requests.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
});

test('a304 clears a transient refresh error and a changed200 replaces the visible snapshot', async ({ page }) => {
  const family = fixture();
  let mode: 'initial' | 'offline' | 'unchanged' | 'changed' = 'initial';
  const validators: (string | undefined)[] = [];
  await page.route('**/api/bootstrap', route => {
    validators.push(route.request().headers()['if-none-match']);
    if (mode === 'offline') return route.abort('failed');
    if (mode === 'unchanged') return route.fulfill({ status: 304, headers: { etag: firstTag } });
    return route.fulfill({ json: family, headers: { etag: mode === 'changed' ? secondTag : firstTag } });
  });
  await page.goto('/#settings');
  const storage = page.getByRole('region', { name: 'Family storage', exact: true }).getByRole('status');
  await expect(storage).toHaveText('Storage available');
  mode = 'offline';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  mode = 'unchanged';
  expect((await refresh(page)).status()).toBe(304);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(storage).toHaveText('Storage available');
  mode = 'changed'; family.capacity = 'near-limit';
  expect((await refresh(page)).status()).toBe(200);
  await expect(storage).toHaveText('Family storage is nearly full');
  expect(validators.at(-1)).toBe(firstTag);
  await refresh(page);
  expect(validators.at(-1)).toBe(secondTag);
});

test('a successful response without a validator discards the previous validator', async ({ page }) => {
  const family = fixture();
  let includeTag = true;
  const validators: (string | undefined)[] = [];
  await page.route('**/api/bootstrap', route => {
    validators.push(route.request().headers()['if-none-match']);
    return route.fulfill({ json: family, headers: includeTag ? { etag: firstTag } : {} });
  });
  await page.goto('/#tasks');
  await expect(page.getByRole('heading', { name: 'Shared tasks', exact: true })).toBeVisible();
  includeTag = false;
  await refresh(page);
  expect(validators.at(-1)).toBe(firstTag);
  await refresh(page);
  expect(validators.at(-1)).toBeUndefined();
});

test('confirmed creation survives a failed refresh and a late304 from before the save', async ({ page }) => {
  const family = fixture();
  let saved = false;
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const validators: (string | undefined)[] = [];
  await page.route('**/api/bootstrap', async route => {
    const validator = route.request().headers()['if-none-match'];
    validators.push(validator);
    if (validator) {
      await pending;
      return route.fulfill({ status: 304, headers: { etag: firstTag } });
    }
    return saved ? route.abort('failed') : route.fulfill({ json: family, headers: { etag: firstTag } });
  });
  await page.route('**/api/records', route => {
    const body = route.request().postDataJSON();
    saved = true;
    return route.fulfill({ status: 201, json: { id: 'confirmed-conditional-save', kind: body.kind, data: body.data, ownerId: family.user.id, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  });
  await page.goto('/#tasks');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByLabel('What needs doing?').fill('Confirmed save survives an offline refresh');
  const conditional = page.waitForRequest('**/api/bootstrap');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect((await conditional).headers()['if-none-match']).toBe(firstTag);
  await page.getByRole('dialog').getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirmed save survives an offline refresh', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  expect(validators.at(-1)).toBeUndefined();
  const late = page.waitForResponse('**/api/bootstrap'); release?.(); await late;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'Confirmed save survives an offline refresh', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Check your connection');
  await page.getByRole('link', { name: 'Make it your own', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Family storage', exact: true }).getByRole('status')).toHaveText('Storage status unavailable');
  const failed = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/bootstrap'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await failed;
  expect(validators.at(-1)).toBeUndefined();
});

test('a confirmed no-op edit still requires a full refresh', async ({ page }) => {
  const family = fixture();
  const task = family.records.find(record => record.kind === 'task') as FamilyRecord<'task'>;
  task.data.done = false;
  const validators = await conditionalFixture(page, family);
  await page.route(`**/api/records/${task.id}`, route => route.fulfill({ json: task }));
  await page.goto('/#tasks');
  await page.getByRole('button', { name: `Edit ${task.data.title}`, exact: true }).click();
  const requestsBefore = validators.length;
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(validators.length).toBeGreaterThan(requestsBefore);
  expect(validators.at(-1)).toBeUndefined();
});

test('module enable and disable each invalidate the complete snapshot', async ({ page }) => {
  const family = fixture();
  family.modules = family.modules.map(module => module.id === 'recipes' ? { ...module, enabled: false } : module);
  const validators = await conditionalFixture(page, family);
  await page.route('**/api/modules/recipes', route => {
    const body = route.request().postDataJSON();
    const module = { ...family.modules.find(module => module.id === 'recipes')!, enabled: body.enabled };
    family.modules = family.modules.map(current => current.id === module.id ? module : current);
    return route.fulfill({ json: module });
  });
  await page.goto('/#settings');
  for (const action of ['Enable', 'Disable']) {
    const recipes = page.getByRole('switch', { name: 'Recipe book', exact: true });
    await recipes.click();
    await expect(recipes).toHaveAttribute('aria-checked', action === 'Enable' ? 'true' : 'false');
    await expect(recipes).toBeEnabled();
    expect(validators.at(-1)).toBeUndefined();
    await refresh(page);
    expect(validators.at(-1)).toBe(firstTag);
  }
});

for (const failure of [401, 403, 503, 'html'] as const) {
  test(`conditional refresh clears private state after ${failure} authentication failure`, async ({ page }) => {
    const family = fixture();
    let expired = false;
    const validators: (string | undefined)[] = [];
    await page.route('**/api/bootstrap', route => {
      validators.push(route.request().headers()['if-none-match']);
      if (!expired) return route.fulfill({ json: family, headers: { etag: firstTag } });
      return failure === 'html' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Access sign-in</title>' }) : route.fulfill({ status: failure, json: { error: 'Session unavailable' } });
    });
    await page.goto('/#settings');
    await expect(page.getByRole('region', { name: 'Family storage', exact: true })).toBeVisible();
    expired = true;
    await refresh(page);
    await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Family storage', exact: true })).toHaveCount(0);
    expect(validators.at(-1)).toBe(firstTag);
    expired = false;
    await refresh(page);
    await expect(page.getByRole('region', { name: 'Family storage', exact: true })).toBeVisible();
    expect(validators.at(-1)).toBeUndefined();
  });
}

test('a late304 cannot restore a signed-out session or clear the sign-out state', async ({ page }) => {
  const family = fixture();
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/bootstrap', async route => {
    if (!route.request().headers()['if-none-match']) return route.fulfill({ json: family, headers: { etag: firstTag } });
    await pending;
    return route.fulfill({ status: 304, headers: { etag: firstTag } });
  });
  await page.goto('/#settings');
  await expect(page.getByRole('region', { name: 'Family storage', exact: true })).toBeVisible();
  const request = page.waitForRequest('**/api/bootstrap');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect((await request).headers()['if-none-match']).toBe(firstTag);
  await page.evaluate(() => { const channel = new BroadcastChannel('hearth-session'); channel.postMessage('logout'); channel.close(); });
  await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
  const response = page.waitForResponse('**/api/bootstrap'); release?.(); await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Explore the local demo' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Family storage', exact: true })).toHaveCount(0);
});

for (const problem of ['unsolicited', 'mismatched', 'missing'] as const) {
  test(`${problem}304 recovers with exactly one unconditional bootstrap request`, async ({ page }) => {
    const family = fixture();
    let invalid = false;
    let recovered = false;
    const validators: (string | undefined)[] = [];
    await page.route('**/api/bootstrap', route => {
      const validator = route.request().headers()['if-none-match'];
      validators.push(validator);
      if (invalid && !recovered) {
        recovered = true;
        return route.fulfill({ status: 304, headers: problem === 'missing' ? {} : { etag: problem === 'mismatched' ? secondTag : firstTag } });
      }
      return route.fulfill({ json: family, headers: problem === 'unsolicited' && !invalid ? {} : { etag: firstTag } });
    });
    await page.goto('/#settings');
    const storage = page.getByRole('region', { name: 'Family storage', exact: true }).getByRole('status');
    await expect(storage).toHaveText('Storage available');
    family.capacity = 'full'; invalid = true;
    const requestsBefore = validators.length;
    await refresh(page);
    await expect(storage).toHaveText('Family storage has reached a limit');
    expect(validators.slice(requestsBefore)).toEqual([problem === 'unsolicited' ? undefined : firstTag, undefined]);
  });
}

test('repeated invalid304 stops after one unconditional retry and reports the failure', async ({ page }) => {
  const family = fixture();
  let invalid = false;
  const validators: (string | undefined)[] = [];
  await page.route('**/api/bootstrap', route => {
    validators.push(route.request().headers()['if-none-match']);
    return invalid ? route.fulfill({ status: 304, headers: { etag: secondTag } }) : route.fulfill({ json: family, headers: { etag: firstTag } });
  });
  await page.goto('/#settings');
  await expect(page.getByRole('region', { name: 'Family storage', exact: true })).toBeVisible();
  invalid = true;
  const requestsBefore = validators.length;
  await refresh(page);
  await expect(page.getByRole('alert')).toContainText('We couldn’t verify your family space');
  expect(validators.slice(requestsBefore)).toEqual([firstTag, undefined]);
  await expect(page.getByRole('region', { name: 'Family storage', exact: true }).getByRole('status')).toHaveText('Storage available');
});

test('unchanged304 follows midnight for untouched moods and preserves an unfinished check-in', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T23:59:00Z'));
  await conditionalFixture(page);
  await page.goto('/#moods');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-10-31');
  await page.clock.setFixedTime(new Date('2026-11-01T00:01:00Z'));
  expect((await refresh(page)).status()).toBe(304);
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-11-01');
  await page.getByRole('radio', { name: 'Good', exact: true }).check();
  await page.getByRole('textbox', { name: 'Anything on your mind?' }).fill('An unfinished midnight thought');
  await page.clock.setFixedTime(new Date('2026-11-02T00:01:00Z'));
  expect((await refresh(page)).status()).toBe(304);
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-11-01');
  await expect(page.getByRole('textbox', { name: 'Anything on your mind?' })).toHaveValue('An unfinished midnight thought');
  await expect(page.getByRole('status').filter({ hasText: 'Your unfinished check-in is still dated Nov 1, 2026.' })).toBeVisible();
});

test('unchanged304 clears yesterday’s question choice and profile-sharing consent', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T23:59:00Z'));
  await conditionalFixture(page);
  await page.goto('/#questions');
  await page.locator('.question-choice').first().click();
  await page.getByRole('checkbox', { name: 'Add this preference to my profile' }).check();
  await page.clock.setFixedTime(new Date('2026-11-01T00:01:00Z'));
  expect((await refresh(page)).status()).toBe(304);
  await expect(page.locator('.daily-question')).toHaveText(questionForDate('2026-11-01').prompt);
  await expect(page.locator('.question-choice input:checked')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Add this preference to my profile' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Save my answer', exact: true })).toBeDisabled();
});

test('unchanged304 advances the current streak month and respects a past-month selection', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-31T23:59:00Z'));
  await conditionalFixture(page);
  await page.goto('/#streaks');
  await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-11-01T00:01:00Z'));
  expect((await refresh(page)).status()).toBe(304);
  await expect(page.getByRole('heading', { name: 'November 2026', exact: true })).toBeVisible();
  await expect(page.locator('.calendar-day[aria-current="date"]')).toContainText('1');
  await page.getByRole('button', { name: 'Previous month' }).click();
  await page.clock.setFixedTime(new Date('2026-12-01T00:01:00Z'));
  expect((await refresh(page)).status()).toBe(304);
  await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible();
});
