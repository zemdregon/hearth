import { test, expect } from '@playwright/test';
import { createDemo } from '../../src/client/demo';
import type { FamilyRecord } from '../../src/shared/types';

test('a confirmed save stays visible when the following refresh loses the connection',async({page})=>{
  const fixture={...createDemo(),demo:false};
  let connectionLost=false;
  await page.route('**/api/bootstrap',route=>connectionLost?route.abort('failed'):route.fulfill({json:fixture}));
  await page.route('**/api/records',async route=>{
    const body=route.request().postDataJSON();
    const record={id:'confirmed-save',kind:body.kind,data:body.data,ownerId:fixture.user.id,version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as FamilyRecord;
    connectionLost=true;
    await route.fulfill({status:201,json:record});
  });
  await page.goto('/#tasks');
  await page.getByRole('button',{name:'Add task',exact:true}).click();
  await page.getByLabel('What needs doing?').fill('Saved before the connection dropped');
  await page.getByRole('dialog').getByRole('button',{name:'Add task',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Saved before the connection dropped',exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Check your connection');
});

test('late save responses cannot restore private state after a cross-tab sign-out',async({page})=>{
  const fixture={...createDemo(),demo:false};
  let finish: (()=>void)|undefined;
  let started: (()=>void)|undefined;
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  const requestStarted=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/bootstrap',route=>route.fulfill({json:fixture}));
  await page.route('**/api/records',async route=>{
    const body=route.request().postDataJSON();started?.();await pending;
    await route.fulfill({status:201,json:{id:'late-save',kind:body.kind,data:body.data,ownerId:fixture.user.id,version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}});
  });
  await page.goto('/#tasks');
  await page.getByRole('button',{name:'Add task',exact:true}).click();
  await page.getByLabel('What needs doing?').fill('Must never reappear after sign-out');
  await page.getByRole('dialog').getByRole('button',{name:'Add task',exact:true}).click();
  await requestStarted;
  await page.evaluate(()=>{const channel=new BroadcastChannel('hearth-session');channel.postMessage('logout');channel.close();});
  await expect(page.getByRole('button',{name:'Explore the local demo'})).toBeVisible();
  const response=page.waitForResponse('**/api/records');finish?.();await response;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading',{name:'Must never reappear after sign-out'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Explore the local demo'})).toBeVisible();
});

test('an in-flight export is canceled when the session signs out',async({page})=>{
  const fixture={...createDemo(),demo:false};
  const downloads:string[]=[];
  page.on('download',download=>downloads.push(download.suggestedFilename()));
  let finish: (()=>void)|undefined;
  let started: (()=>void)|undefined;
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  const requestStarted=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/bootstrap',route=>route.fulfill({json:fixture}));
  await page.route('**/api/export',async route=>{started?.();await pending;await route.fulfill({json:{...fixture,schemaVersion:1,exportedAt:new Date().toISOString(),scope:'Private fixture'}});});
  await page.goto('/#settings');
  await page.getByRole('button',{name:'Export data'}).click();
  await requestStarted;
  await page.evaluate(()=>{const channel=new BroadcastChannel('hearth-session');channel.postMessage('logout');channel.close();});
  await expect(page.getByRole('button',{name:'Explore the local demo'})).toBeVisible();
  const response=page.waitForResponse('**/api/export');finish?.();await response;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  expect(downloads).toEqual([]);
  await expect(page.getByRole('button',{name:'Explore the local demo'})).toBeVisible();
});

test('an unexpected sign-in HTML response never becomes a family export',async({page})=>{
  const fixture={...createDemo(),demo:false};
  const downloads:string[]=[];
  let expired=false;
  page.on('download',download=>downloads.push(download.suggestedFilename()));
  await page.route('**/api/bootstrap',route=>expired?route.fulfill({status:401,json:{error:'Sign in with a family passkey.'}}):route.fulfill({json:fixture}));
  await page.route('**/api/export',route=>{expired=true;return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Sign in</title>Sign in'});});
  await page.goto('/#settings');
  await page.getByRole('button',{name:'Export data'}).click();
  await expect(page.getByRole('button',{name:'Explore the local demo'})).toBeVisible();
  expect(downloads).toEqual([]);
});
