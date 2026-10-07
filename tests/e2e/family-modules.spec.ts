import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';

async function openDemo(page: Page, module: string) {
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Local test deployment is not configured.' }) }));
  await page.goto(`/#${module}`);
  await page.getByRole('button', { name: 'Explore the local demo' }).click();
}

test('shared tasks support assignment, editing, completion and reversible deletion', async ({ page }) => {
  await openDemo(page, 'tasks');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What needs doing?').fill('Collect our library books');
  await dialog.getByLabel("Who's on it?").selectOption('sam');
  await dialog.getByLabel('Due date').fill('2030-01-15');
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  let task = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Collect our library books', exact: true }) });
  await expect(task).toContainText('Sam');
  await expect(task).toContainText('Jan 15, 2030');
  await page.getByLabel('Filter by assignee').selectOption('alex');
  await expect(task).toHaveCount(0);
  await page.getByLabel('Filter by assignee').selectOption('all');
  await task.getByRole('button', { name: 'Edit Collect our library books' }).click();
  await dialog.getByLabel('What needs doing?').fill('Collect the books and return a novel');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  task = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Collect the books and return a novel' }) });
  await task.getByRole('button', { name: 'Complete task: Collect the books and return a novel' }).click();
  await expect(task).toHaveCount(0);
  await page.getByRole('button', { name: /^Completed/ }).click();
  await expect(task).toBeVisible();
  await task.getByRole('button', { name: 'Delete Collect the books and return a novel' }).click();
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(task).toBeVisible();
  await task.getByRole('button', { name: 'Delete Collect the books and return a novel' }).click();
  await dialog.getByRole('button', { name: 'Delete item' }).click();
  await expect(task).toHaveCount(0);
});

test('dated notes remain searchable and modal cancellation leaves the original intact', async ({ page }) => {
  await openDemo(page, 'notes');
  await page.getByRole('button', { name: 'Write a note', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your note').fill('Remember our lovely afternoon by the lake.');
  await dialog.getByLabel('Date', { exact: true }).fill('2020-06-05');
  await dialog.getByRole('button', { name: 'Save note' }).click();
  const note = page.locator('article').filter({ hasText: 'Remember our lovely afternoon by the lake.' });
  await expect(note).toBeVisible();
  await expect(page.getByText('Fri, June 5, 2020', { exact: true })).toBeVisible();
  await page.getByLabel('Search note history').fill('unmatched-search-term');
  await expect(note).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await note.getByRole('button', { name: 'Edit note' }).click();
  await dialog.getByLabel('Your note').fill('Unsaved replacement');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(note).toBeVisible();
  await expect(note.getByRole('button', { name: 'Edit note' })).toBeFocused();
  await note.getByRole('button', { name: 'Edit note' }).click();
  await dialog.getByLabel('Your note').fill('A lake afternoon worth remembering.');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  const edited = page.locator('article').filter({ hasText: 'A lake afternoon worth remembering.' });
  await edited.getByRole('button', { name: 'Delete note' }).click();
  await dialog.getByRole('button', { name: 'Delete item' }).click();
  await expect(edited).toHaveCount(0);
});

test('events move between countdowns and past memories when their date changes', async ({ page }) => {
  await openDemo(page, 'events');
  await page.getByRole('button', { name: 'Add an event', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel("What's the occasion?").fill('A weekend at the coast');
  await dialog.getByLabel('Date', { exact: true }).fill('2031-07-04');
  await dialog.getByLabel('A little symbol').selectOption('✈️');
  await dialog.getByLabel('A few details').fill('Bring the walking shoes.');
  await dialog.getByRole('button', { name: 'Save event' }).click();
  const event = page.locator('article').filter({ has: page.getByRole('heading', { name: 'A weekend at the coast' }) });
  await expect(event).toContainText('Bring the walking shoes.');
  await expect(event).toContainText(/In \d+ days/);
  await event.getByRole('button', { name: 'Edit A weekend at the coast' }).click();
  await dialog.getByLabel('Date', { exact: true }).fill('2020-07-04');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(event).toHaveCount(0);
  await page.getByRole('button', { name: /^Past moments/ }).click();
  await expect(event).toContainText(/\d+ days ago/);
  await event.getByRole('button', { name: 'Delete A weekend at the coast' }).click();
  await dialog.getByRole('button', { name: 'Delete item' }).click();
  await expect(event).toHaveCount(0);
});

test('goal milestones complete the goal and adding a new step reopens it', async ({ page }) => {
  await openDemo(page, 'goals');
  await page.getByRole('button', { name: 'Add a goal', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What are you dreaming of?').fill('Grow our balcony tomatoes');
  await dialog.getByRole('button', { name: 'Add a milestone' }).click();
  await dialog.getByLabel('Milestone 1', { exact: true }).fill('Choose the seeds');
  await dialog.getByRole('button', { name: 'Add a milestone' }).click();
  await dialog.getByLabel('Milestone 2', { exact: true }).fill('Plant together');
  await dialog.getByRole('button', { name: 'Save goal' }).click();
  const goal = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Grow our balcony tomatoes' }) });
  await goal.getByRole('checkbox', { name: 'Choose the seeds' }).check();
  await expect(goal.getByRole('progressbar')).toHaveAttribute('value', '50');
  await goal.getByRole('checkbox', { name: 'Plant together' }).click();
  await expect(goal).toHaveCount(0);
  await page.getByRole('button', { name: /^Achieved/ }).click();
  await expect(goal.getByRole('progressbar')).toHaveAttribute('value', '100');
  await goal.getByRole('button', { name: 'Edit Grow our balcony tomatoes' }).click();
  await dialog.getByRole('button', { name: 'Add a milestone' }).click();
  await dialog.getByLabel('Milestone 3', { exact: true }).fill('Share the first harvest');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: /^In progress/ }).click();
  await expect(goal.getByRole('progressbar')).toHaveAttribute('value', '67');
  await goal.getByRole('button', { name: 'Complete goal & milestones' }).click();
  await page.getByRole('button', { name: /^Achieved/ }).click();
  await expect(goal.getByRole('checkbox', { name: 'Share the first harvest' })).toBeChecked();
  await goal.getByRole('button', { name: 'Reopen goal' }).click();
  await page.getByRole('button', { name: /^In progress/ }).click();
  await expect(goal).toBeVisible();
  await goal.getByRole('button', { name: 'Delete Grow our balcony tomatoes' }).click();
  await dialog.getByRole('button', { name: 'Delete item' }).click();
  await expect(goal).toHaveCount(0);
});

test('profiles save your preferences and viewing another member does not grant editing access', async ({ page }) => {
  await openDemo(page, 'profiles');
  await page.getByRole('button', { name: 'Edit my profile' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('A few words about you').fill('Happiest in the garden.');
  await dialog.getByLabel('Little things you love').fill('Tomatoes\nFresh bread\nTomatoes');
  await dialog.getByLabel('Thoughtful little ideas').fill('Plan a picnic\nWater the seedlings');
  await dialog.getByRole('button', { name: 'Save my profile' }).click();
  await expect(page.getByText('Happiest in the garden.', { exact: true })).toBeVisible();
  await expect(page.getByText('Tomatoes', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Plan a picnic', { exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Choose a family member' }).getByRole('button', { name: /Sam/ }).click();
  await expect(page.getByRole('region', { name: "Sam's profile" })).toContainText('Happiest outside');
  await page.getByRole('button', { name: 'Edit my profile' }).click();
  await expect(dialog.getByLabel('A few words about you')).toHaveValue('Happiest in the garden.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('failed asynchronous saves retain the draft and can be retried', async ({ page }) => {
  const bootstrap = { ...createDemo(), demo: false };
  let failing = true;
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bootstrap) }));
  await page.route('**/api/records', async route => {
    if (failing) { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save this task. Please try again.' }) }); return; }
    const request = route.request().postDataJSON();
    const record = { id: 'retried-task', kind: 'task' as const, ownerId: 'alex', data: request.data, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    bootstrap.records.push(record);
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(record) });
  });
  await page.goto('/#tasks');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What needs doing?').fill('A draft that must not disappear');
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save this task.');
  await expect(dialog.getByLabel('What needs doing?')).toHaveValue('A draft that must not disappear');
  failing = false;
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A draft that must not disappear' })).toBeVisible();
});

test('family modules fit a phone and their form controls have accessible labels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page, 'tasks');
  for (const [module, title, button] of [
    ['tasks', 'Shared tasks', 'Add task'], ['notes', 'Little notes', 'Write a note'], ['events', 'Our calendar', 'Add an event'], ['profiles', 'Our people', 'Edit my profile'], ['goals', 'Our bigger dreams', 'Add a goal'],
  ]) {
    await page.evaluate(hash => { window.location.hash = hash; }, module);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: button, exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const unlabeled = await dialog.locator('input, textarea, select').evaluateAll(elements => elements.filter(element => !element.getAttribute('aria-label') && !(element as HTMLInputElement).labels?.length).length);
    expect(unlabeled).toBe(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('family modules and their editing dialogs meet automated accessibility checks', async ({ page }) => {
  test.setTimeout(60000);
  await openDemo(page, 'tasks');
  for (const [module, title, button] of [
    ['tasks', 'Shared tasks', 'Add task'], ['notes', 'Little notes', 'Write a note'], ['events', 'Our calendar', 'Add an event'], ['profiles', 'Our people', 'Edit my profile'], ['goals', 'Our bigger dreams', 'Add a goal'],
  ]) {
    await page.evaluate(hash => { window.location.hash = hash; }, module);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    const viewResults = await new AxeBuilder({ page }).include('#main-content').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(viewResults.violations, `${module} page accessibility`).toEqual([]);
    await page.getByRole('button', { name: button, exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const dialogResults = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(dialogResults.violations, `${module} dialog accessibility`).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});
