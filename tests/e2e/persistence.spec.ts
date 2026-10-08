import { readFileSync } from 'node:fs';
import { test as base, expect } from '@playwright/test';
import type { Bootstrap, FamilyRecord } from '../../src/shared/types';
import { addDays } from '../../src/shared/calendar';
import { questionForDate } from '../../src/shared/questions';

function fixtureAuth(): {sessions: Record<string,string>} {
  return JSON.parse(readFileSync(new URL('../../.wrangler/e2e-auth.json', import.meta.url), 'utf8'));
}
function memberCookie(id: string) { return `__Host-hearth_session=${fixtureAuth().sessions[id] || ''}`; }
const test = base.extend({
  storageState: async ({}, use) => {
    await use({ cookies: [{ name:'__Host-hearth_session', value:fixtureAuth().sessions.alex, domain:'localhost',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Strict' }], origins:[] });
  },
});

test('real Worker conditional refresh authenticates and returns no private body when unchanged', async ({ request }) => {
  const initial = await request.get('/api/bootstrap');
  expect(initial.status()).toBe(200);
  const validator = initial.headers().etag;
  expect(validator).toMatch(/^W\/"hearth-[a-f0-9]{64}"$/);
  const response = await request.get('/api/bootstrap', { headers: { 'If-None-Match': validator } });
  expect(response.status()).toBe(304);
  expect(await response.body()).toHaveLength(0);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers().etag).toBe(validator);
  const other = await request.get('/api/bootstrap', { headers: { 'If-None-Match': validator, Cookie: memberCookie('sam') } });
  expect(other.status()).toBe(200);
  expect((await other.json() as Bootstrap).user.id).toBe('sam');
  expect(other.headers().etag).not.toBe(validator);
  const denied = await request.get('/api/bootstrap', { headers: { 'If-None-Match': validator, Cookie: '' } });
  expect(denied.status()).toBe(401);
});

test('real browser retains its family view after a Worker 304 response', async ({ page }) => {
  const loaded = page.waitForResponse(response => response.url().endsWith('/api/bootstrap') && response.status() === 200);
  await page.goto('/#tasks');
  const initial = await loaded;
  const validator = initial.headers().etag;
  await expect(page.getByRole('heading', { name: 'Shared tasks', exact: true })).toBeVisible();
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/bootstrap') && response.status() === 304);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const unchanged = await refreshed;
  expect(unchanged.request().headers()['if-none-match']).toBe(validator);
  await expect(page.getByRole('heading', { name: 'Shared tasks', exact: true })).toBeVisible();
  await expect(page.locator('.sync-error')).toHaveCount(0);
});

test('real Worker and D1 persist shared edits, enforce conflicts, privacy, and module controls', async ({ request })=>{
  const origin='http://localhost:5173';
  const headers={ Origin:origin, 'Content-Type':'application/json' };
  const samHeaders={...headers,Cookie:memberCookie('sam')};
  const title=`Browser integration ${crypto.randomUUID()}`;
  const records:FamilyRecord[]=[];
  try {
    const initial=await request.get('/api/bootstrap');
    expect(initial.status()).toBe(200);
    const bootstrap=await initial.json() as Bootstrap;
    expect(bootstrap.user.id).toBe('alex');
    const create=await request.post('/api/records',{headers,data:{kind:'task',data:{title,done:false}}});
    expect(create.status()).toBe(201);
    let task=await create.json() as FamilyRecord<'task'>;records.push(task);
    const second=await request.get('/api/bootstrap',{headers:samHeaders});
    expect((await second.json() as Bootstrap).records.some(r=>r.id===task.id)).toBe(true);
    const changed=await request.patch(`/api/records/${task.id}`,{headers:samHeaders,data:{version:task.version,data:{...task.data,done:true}}});
    expect(changed.status()).toBe(200);
    task=await changed.json() as FamilyRecord<'task'>;records[0]=task;
    expect((await request.patch(`/api/records/${task.id}`,{headers,data:{version:1,data:{title,done:false}}})).status()).toBe(409);
    const ownProfile=await request.post('/api/records',{headers:samHeaders,data:{kind:'mood',data:{date:'2000-02-29',score:4,note:title,shared:false}}});
    expect(ownProfile.status()).toBe(201);const mood=await ownProfile.json() as FamilyRecord;records.push(mood);
    const privateState=await request.get('/api/bootstrap');
    expect((await privateState.json() as Bootstrap).records.some(r=>r.id===mood.id)).toBe(false);
    const exportResponse=await request.get('/api/export');
    expect((await exportResponse.json() as Bootstrap).records.some(r=>r.id===mood.id)).toBe(false);
    expect(exportResponse.headers()['cache-control']).toContain('no-store');
    expect((await request.patch('/api/modules/tasks',{headers:samHeaders,data:{enabled:false}})).status()).toBe(403);
    expect((await request.post('/api/records',{headers:{...headers,Origin:'https://unrelated.example'},data:{kind:'task',data:{title,done:false}}})).status()).toBe(403);
    expect((await request.get('/api/bootstrap',{headers:{Cookie:''}})).status()).toBe(401);
  } finally {
    for(const record of records) await request.delete(`/api/records/${record.id}`,{headers:record.ownerId==='sam'?samHeaders:headers,data:{version:record.version}});
  }
});

test('real UI saves a shared task across reloads',async({page,request})=>{
  const title=`Persisted task ${crypto.randomUUID().slice(0,8)}`;
  await page.goto('/#tasks');
  await expect(page.getByRole('heading',{name:'Shared tasks',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Add task',exact:true}).first().click();
  await page.getByLabel('What needs doing?').fill(title);
  await page.getByRole('dialog').getByRole('button',{name:'Add task',exact:true}).click();
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  const data=await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const record=data.records.find(r=>r.kind==='task'&&r.data.title===title);
  expect(record).toBeDefined();
  if(record) await request.delete(`/api/records/${record.id}`,{headers:{Origin:'http://localhost:5173'},data:{version:record.version}});
});

test('real Worker and D1 bind question audiences, reveal a completed pair, and revoke visibility after withdrawal', async ({ request }) => {
  const headers = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
  const samHeaders = { ...headers, Cookie: memberCookie('sam') };
  const alex = await (await request.get('/api/bootstrap')).json() as Bootstrap;
  const sam = await (await request.get('/api/bootstrap', { headers: samHeaders })).json() as Bootstrap;
  expect(alex.questionPair).toEqual(['alex', 'sam']);
  const occupiedDates = new Set([...alex.records, ...sam.records].filter(record => record.kind === 'answer').map(record => record.data.date));
  let date = '1999-01-01';
  while (occupiedDates.has(date)) date = addDays(date, 1);
  const data = { date, questionId: questionForDate(date).id, choice: 0, shareToProfile: false, participantIds: alex.questionPair };
  const created: FamilyRecord<'answer'>[] = [];
  try {
    const first = await request.post('/api/records', { headers, data: { kind: 'answer', data } });
    expect(first.status(), await first.text()).toBe(201);
    const firstAnswer = await first.json() as FamilyRecord<'answer'>;
    created.push(firstAnswer);
    const waiting = await (await request.get('/api/bootstrap', { headers: samHeaders })).json() as Bootstrap;
    expect(waiting.records.some(record => record.id === firstAnswer.id)).toBe(false);

    const forged = await request.post('/api/records', { headers: samHeaders, data: { kind: 'answer', data: { ...data, participantIds: ['sam', 'outsider'] } } });
    expect(forged.status()).toBe(409);
    const second = await request.post('/api/records', { headers: samHeaders, data: { kind: 'answer', data: { ...data, choice: 1 } } });
    expect(second.status(), await second.text()).toBe(201);
    const secondAnswer = await second.json() as FamilyRecord<'answer'>;
    created.push(secondAnswer);
    const revealed = await (await request.get('/api/bootstrap')).json() as Bootstrap;
    expect(revealed.records.filter(record => created.some(answer => answer.id === record.id))).toHaveLength(2);

    const reassigned = await request.patch(`/api/records/${firstAnswer.id}`, { headers, data: { version: firstAnswer.version, data: { ...firstAnswer.data, participantIds: ['alex', 'outsider'] } } });
    expect(reassigned.status()).toBe(400);
    const removed = await request.delete(`/api/records/${firstAnswer.id}`, { headers, data: { version: firstAnswer.version } });
    expect(removed.status()).toBe(200);
    created.shift();
    const withdrawn = await (await request.get('/api/bootstrap')).json() as Bootstrap;
    expect(withdrawn.records.some(record => record.id === secondAnswer.id)).toBe(false);
    const owner = await (await request.get('/api/bootstrap', { headers: samHeaders })).json() as Bootstrap;
    expect(owner.records.some(record => record.id === secondAnswer.id)).toBe(true);
  } finally {
    for (const record of created) await request.delete(`/api/records/${record.id}`, { headers: record.ownerId === 'sam' ? samHeaders : headers, data: { version: record.version } });
  }
});
