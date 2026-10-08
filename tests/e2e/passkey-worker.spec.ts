import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('real Worker verifies passkey enrollment and assertions, rejects replay, and revokes logout', async ({ page, context }) => {
  test.setTimeout(90000);
  const { enrollment } = JSON.parse(readFileSync(new URL('../../.wrangler/e2e-auth.json', import.meta.url), 'utf8')) as {enrollment:string};
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,
  } });
  try {
    await page.goto(`/#enroll=${enrollment}`);
    await expect(page.getByRole('button',{name:'Create your passkey'})).toBeVisible();
    expect(page.url()).not.toContain(enrollment);
    await page.getByRole('button',{name:'Create your passkey'}).click();
    await expect(page.getByText('Your passkey is registered. Sign in with it to open your family space.')).toBeVisible();
    expect((await page.request.get('/api/bootstrap')).status()).toBe(401);
    const assertion = page.waitForRequest(request => request.url().endsWith('/api/auth/login/verify'));
    await page.getByRole('button',{name:'Sign in with a passkey'}).click();
    const verifiedRequest = await assertion;
    await expect(page.getByRole('heading',{name:'Home, together.'})).toBeVisible();
    const snapshot=await page.request.get('/api/bootstrap');
    expect(snapshot.status()).toBe(200);
    const data=await snapshot.json();
    expect(data.user.id).toBe('passkey-test');
    expect(data.user).not.toHaveProperty('email');
    const replay=await page.request.post('/api/auth/login/verify',{headers:{Origin:'http://localhost:5173'},data:verifiedRequest.postDataJSON()});
    expect(replay.status()).toBe(401);
    const cookies=await context.cookies();
    const session=cookies.find(cookie=>cookie.name==='__Host-hearth_session');
    expect(session).toMatchObject({secure:true,httpOnly:true,sameSite:'Strict',path:'/'});
    await page.getByRole('button',{name:'Your account and family members'}).click();
    const logout=page.waitForResponse(response=>response.url().endsWith('/api/auth/logout'));
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    expect((await logout).status()).toBe(200);
    await expect(page.getByRole('button',{name:'Sign in with a passkey'})).toBeVisible();
    const denied=await page.request.get('/api/bootstrap',{headers:{Cookie:`__Host-hearth_session=${session!.value}`}});
    expect(denied.status()).toBe(401);
    await page.getByRole('button',{name:'Sign in with a passkey'}).click();
    await expect(page.getByRole('heading',{name:'Home, together.'})).toBeVisible();
    // No private API responses or auth artifacts should be cached by the PWA.
    const cached=await page.evaluate(async()=>{
      const urls:string[]=[];
      for(const name of await caches.keys()) for(const request of await (await caches.open(name)).keys()) urls.push(request.url);
      return urls;
    });
    expect(cached.some(url=>new URL(url).pathname.startsWith('/api/'))).toBe(false);
  } finally { await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId}); await cdp.detach(); }
});
