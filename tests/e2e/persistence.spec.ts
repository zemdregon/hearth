import { test, expect } from '@playwright/test';
import type { Bootstrap, FamilyRecord } from '../../src/shared/types';

test('real Worker and D1 persist shared edits, enforce conflicts, privacy, and module controls', async ({ request })=>{
  const origin='http://localhost:5173';
  const headers={ Origin:origin, 'Content-Type':'application/json' };
  const samHeaders={...headers,'X-Dev-User':'sam@example.test'};
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
    expect((await request.get('/api/bootstrap',{headers:{'X-Dev-User':'outsider@example.test'}})).status()).toBe(403);
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
