import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDemo } from '../../src/client/demo';

const token = 'a'.repeat(43);
const challenge = Buffer.from('fictional-browser-challenge-32-bytes').toString('base64url');
const registrationOptions = {
  challenge, rp: { id: 'localhost', name: 'Hearth test' },
  user: { id: Buffer.from('fictional-browser-member').toString('base64url'), name: 'hearth-fictional-member', displayName: 'Family member' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  timeout: 60000, attestation: 'none',
};
const authenticationOptions = { challenge, rpId: 'localhost', userVerification: 'required', timeout: 60000, allowCredentials: [] };

// These tests exercise real browser WebAuthn with a virtual authenticator and
// mocked JSON endpoints. Server verification has separate Worker integration tests.
async function setup(page: Page, signedIn = false) {
  const fixture = { ...createDemo(), demo: false };
  const state = {
    signedIn, bootstrapCalls: 0, calls: [] as string[], registrations: 0,
    credentials: [{ id: 'first', name: 'First passkey', createdAt: 1791417600, lastUsedAt: 1791417600 }],
    members: fixture.members.map(member => ({ ...member, status: 'active' })),
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.route('**/api/bootstrap', route => {
    state.bootstrapCalls++;
    return route.fulfill(state.signedIn ? { json: fixture } : { status: 401, json: { error: 'Sign in with a passkey.' } });
  });
  await page.route('**/api/auth/**', route => {
    const path = new URL(route.request().url()).pathname;
    state.calls.push(path);
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : {};
    if (path.endsWith('/register/options')) return route.fulfill({ json: { ceremonyId: 'registration', options: registrationOptions } });
    if (path.endsWith('/register/verify')) {
      state.registrations++;
      if (state.registrations > 1) state.credentials.push({ id: body.response.id, name: body.name || 'Unnamed passkey', createdAt: 1791417600, lastUsedAt: 1791417600 });
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/login/options') || path.endsWith('/reauth/options')) return route.fulfill({ json: { ceremonyId: 'assertion', options: authenticationOptions } });
    if (path.endsWith('/login/verify')) {state.signedIn = true;return route.fulfill({ json: { ok: true } });}
    if (path.endsWith('/reauth/verify')) return route.fulfill({ json: { ok: true } });
    if (path.endsWith('/logout') || path.endsWith('/sessions/revoke')) {state.signedIn = false;return route.fulfill({ json: { ok: true } });}
    if (path.endsWith('/credentials/revoke')) {state.credentials = state.credentials.filter(credential => credential.id !== body.id);return route.fulfill({ json: { ok: true } });}
    if (path.endsWith('/credentials')) return route.fulfill({ json: { credentials: state.credentials } });
    if (path.endsWith('/members') && route.request().method() === 'GET') return route.fulfill({ json: { members: state.members } });
    if (path.endsWith('/members') && route.request().method() === 'POST') {state.members.push({ ...body, status: 'pending' });return route.fulfill({ json: { token, expiresAt: 1791504000 } });}
    if (path.endsWith('/recover')) return route.fulfill({ json: { token, expiresAt: 1791504000 } });
    if (path.endsWith('/invitations/revoke') || path.endsWith('/suspend')) return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: 'Unexpected test endpoint.' } });
  });
  return state;
}
async function enrollAndSignIn(page: Page) {
  await page.goto(`/#enroll=${token}`);
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  await expect(page.getByText('Your passkey is registered. Sign in with it to open your family space.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
}
async function settings(page: Page) {
  await page.locator('.sidebar').getByRole('link', { name: 'Make it your own' }).click();
  await page.getByRole('button', { name: 'Manage passkeys and account' }).click();
  await expect(page.getByRole('button', { name: 'Add another passkey' })).toBeEnabled();
}

test('fragment enrollment is memory-only and needs a separate assertion before family access', async ({ page }) => {
  const state = await setup(page);
  const urls: string[] = [];
  page.on('request', request => urls.push(request.url()));
  await page.addInitScript(() => {
    const authFetches: { cache?: RequestCache; credentials?: RequestCredentials }[] = [];
    (window as unknown as { authFetches: typeof authFetches }).authFetches = authFetches;
    const fetchOriginal = window.fetch;
    window.fetch = (input, init) => {if (String(input).startsWith('/api/auth/')) authFetches.push({ cache: init?.cache, credentials: init?.credentials });return fetchOriginal(input, init);};
  });
  await page.goto(`/#enroll=${token}`);
  await expect(page.getByRole('button', { name: 'Create your passkey' })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(state.bootstrapCalls).toBe(0);
  await page.getByLabel('Passkey name', { exact: true }).fill('My phone');
  await page.getByRole('button', { name: 'Create your passkey' }).click();
  await expect(page.getByText('Your passkey is registered. Sign in with it to open your family space.')).toBeVisible();
  expect(state.signedIn).toBe(false);
  expect(state.bootstrapCalls).toBe(0);
  expect(state.calls).toEqual(['/api/auth/register/options', '/api/auth/register/verify']);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
  expect(state.calls.slice(-2)).toEqual(['/api/auth/login/options', '/api/auth/login/verify']);
  expect(urls.every(url => !url.includes(token))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)).toBe(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { authFetches: unknown[] }).authFetches)).toEqual(Array(4).fill({cache:'no-store',credentials:'same-origin'}));
});

test('same-document enrollment clears its fragment and private state without revoking the server session', async ({ page }) => {
  const state=await setup(page,true);
  const replacementToken='b'.repeat(43);
  let submittedToken:unknown;
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/auth/register/options') submittedToken=request.postDataJSON().token;});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Home, together.'})).toBeVisible();
  const bootstrapCalls=state.bootstrapCalls;
  await page.evaluate(value=>{
    (window as unknown as {sameDocumentMarker:string}).sameDocumentMarker='existing-document';
    window.location.hash=`enroll=${value}`;
  },token);
  await expect(page.getByRole('button',{name:'Create your passkey'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Home, together.'})).toHaveCount(0);
  expect(await page.evaluate(()=>location.hash)).toBe('');
  expect(await page.evaluate(()=>(window as unknown as {sameDocumentMarker:string}).sameDocumentMarker)).toBe('existing-document');
  expect(state.signedIn).toBe(true);
  expect(state.calls).not.toContain('/api/auth/logout');
  // A second same-document invitation replaces the first in memory even though
  // the signed-out gate is already mounted.
  await page.getByLabel('Passkey name',{exact:true}).fill('Draft from earlier invitation');
  await page.evaluate(value=>{window.location.hash=`enroll=${value}`;},replacementToken);
  await expect(page.getByLabel('Passkey name',{exact:true})).toHaveValue('');
  expect(await page.evaluate(()=>location.hash)).toBe('');
  await page.goBack();
  expect(page.url()).not.toContain('enroll=');
  await page.goForward();
  expect(page.url()).not.toContain('enroll=');
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  expect(state.bootstrapCalls).toBe(bootstrapCalls);
  await page.getByRole('button',{name:'Create your passkey'}).click();
  await expect(page.getByText('Your passkey is registered. Sign in with it to open your family space.')).toBeVisible();
  expect(submittedToken).toBe(replacementToken);
  expect(state.bootstrapCalls).toBe(bootstrapCalls);
  expect(state.calls).not.toContain('/api/auth/logout');
});

test('a canceled passkey assertion explains retry without offering another authentication method', async ({ page }) => {
  const state = await setup(page);
  await page.addInitScript(() => {navigator.credentials.get = async () => {throw new DOMException('Canceled', 'NotAllowedError');};});
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('canceled or timed out');
  expect(state.calls).toEqual(['/api/auth/login/options']);
  await expect(page.locator('input[type=email],input[type=password],a[href*="cdn-cgi/access"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
});

test('unsupported browsers get a useful passkey explanation before making a ceremony request', async ({ page }) => {
  const state = await setup(page);
  await page.addInitScript(() => {Object.defineProperty(window,'PublicKeyCredential',{value:undefined});});
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('Passkeys aren’t available in this browser');
  expect(state.calls).toEqual([]);
});

test('background refresh cannot interrupt a pending passkey assertion', async ({ page }) => {
  const state = await setup(page);
  await enrollAndSignIn(page);
  await page.getByRole('button', { name: 'Your account and family members' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  // Reload so ordinary unauthenticated refresh is enabled before starting login.
  await page.clock.install();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  await page.evaluate(() => {
    const original=navigator.credentials.get.bind(navigator.credentials);
    let resume: (()=>void)|undefined;
    const waiting=new Promise<void>(resolve=>{resume=resolve;});
    (window as unknown as {resumeAssertion:()=>void}).resumeAssertion=()=>resume?.();
    navigator.credentials.get=async options=>{await waiting;return original(options);};
  });
  const before=state.bootstrapCalls;
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect.poll(()=>state.calls.at(-1)).toBe('/api/auth/login/options');
  await page.clock.runFor(31000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(state.bootstrapCalls).toBe(before);
  await page.evaluate(() => (window as unknown as {resumeAssertion:()=>void}).resumeAssertion());
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toBeVisible();
});

test('logout clears family content immediately and honestly reports a failed server revocation', async ({ page }) => {
  const state = await setup(page, true);
  let finish: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => {finish = resolve;});
  let logoutCalls = 0;
  await page.route('**/api/auth/logout', async route => {
    logoutCalls++;
    expect(route.request().postDataJSON()).toEqual({});
    if (logoutCalls === 1) {await waiting;await route.abort('failed');}
    else {state.signedIn = false;await route.fulfill({json:{ok:true}});}
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Your account and family members' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeDisabled();
  finish?.();
  await expect(page.getByRole('alert')).toContainText('server sign-out could not be confirmed');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading', { name: 'Home, together.' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(logoutCalls).toBe(2);
});

test('a second passkey requires reauthentication and the final usable passkey cannot be removed in the UI', async ({ page }) => {
  const state = await setup(page);
  await enrollAndSignIn(page);
  await settings(page);
  await expect(page.getByRole('button', { name: 'Remove First passkey' })).toBeDisabled();
  await page.getByLabel('New passkey name').fill('Backup security key');
  const start = state.calls.length;
  await page.getByRole('button', { name: 'Add another passkey' }).click();
  await expect(page.getByText('Backup security key', {exact:true})).toBeVisible();
  expect(state.calls.slice(start, start + 4)).toEqual(['/api/auth/reauth/options','/api/auth/reauth/verify','/api/auth/register/options','/api/auth/register/verify']);
  await page.getByRole('button', {name:'Remove Backup security key'}).click();
  await page.getByRole('button', {name:'Verify and remove passkey'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Remove First passkey'})).toBeDisabled();
  expect(state.calls).toContain('/api/auth/credentials/revoke');
});

test('administrators verify a passkey before receiving a private enrollment link', async ({ page }) => {
  const state = await setup(page);
  await enrollAndSignIn(page);
  await settings(page);
  await page.getByLabel('New member’s display name').fill('Fictional guest');
  const start = state.calls.length;
  await page.getByRole('button', {name:'Create enrollment invitation'}).click();
  await expect(page.getByRole('dialog')).toContainText('Anyone who receives it can register a passkey');
  await expect(page.getByRole('textbox',{name:'Enrollment link',exact:true})).toHaveValue(`http://localhost:5173/#enroll=${token}`);
  expect(state.calls.slice(start,start+3)).toEqual(['/api/auth/reauth/options','/api/auth/reauth/verify','/api/auth/members']);
  expect(state.members.find(member=>member.name==='Fictional guest')?.id).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Enrollment link',exact:true})).toHaveCount(0);
});

test('recovery describes its authority and session logout cancels a late reauthentication response', async ({ page }) => {
  const state = await setup(page, true);
  let finish: (() => void) | undefined;
  let started: (() => void) | undefined;
  const pending = new Promise<void>(resolve => {finish=resolve;});
  const requestStarted = new Promise<void>(resolve => {started=resolve;});
  await page.route('**/api/auth/reauth/options', async route => {started?.();await pending;await route.fulfill({json:{ceremonyId:'late',options:authenticationOptions}}).catch(()=>undefined);});
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Manage passkeys and account' }).click();
  await expect(page.getByRole('button',{name:'Recover account'}).last()).toBeEnabled();
  await page.getByRole('button',{name:'Recover account'}).last().click();
  await expect(page.getByRole('dialog')).toContainText('revokes their old passkeys, sessions and invitations');
  await page.getByRole('button',{name:'Identity verified — authorize recovery'}).click();
  await requestStarted;
  await page.evaluate(()=>{const channel=new BroadcastChannel('hearth-session');channel.postMessage('logout');channel.close();});
  await expect(page.getByRole('button',{name:'Sign in with a passkey'})).toBeVisible();
  finish?.();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  expect(state.calls.some(path=>path.endsWith('/reauth/verify') || path.endsWith('/recover'))).toBe(false);
  await expect(page.getByRole('textbox',{name:'Enrollment link',exact:true})).toHaveCount(0);
});

test('closing account controls cancels pending verification without signing out', async ({ page }) => {
  const state=await setup(page,true);
  let finish:(()=>void)|undefined;
  let started:(()=>void)|undefined;
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  const requestStarted=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/auth/reauth/options',async route=>{started?.();await pending;await route.fulfill({json:{ceremonyId:'late',options:authenticationOptions}}).catch(()=>undefined);});
  await page.goto('/#settings');
  await page.getByRole('button',{name:'Manage passkeys and account'}).click();
  await expect(page.getByRole('button',{name:'Add another passkey'})).toBeEnabled();
  await page.getByRole('button',{name:'Add another passkey'}).click();
  await requestStarted;
  await page.getByRole('button',{name:'Close account controls'}).click();
  finish?.();
  await expect(page.getByRole('heading',{name:'Make it your own.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Manage passkeys and account'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Sign in with a passkey'})).toHaveCount(0);
  expect(state.calls.some(path=>path.endsWith('/reauth/verify') || path.endsWith('/register/options'))).toBe(false);
});

test('account settings are accessible on mobile and the fictional demo has no authentication controls', async ({ page }) => {
  await setup(page,true);
  await page.setViewportSize({width:390,height:844});
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Manage passkeys and account' }).click();
  await expect(page.getByRole('button',{name:'Add another passkey'})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.evaluate(()=>{const channel=new BroadcastChannel('hearth-session');channel.postMessage('logout');channel.close();});
  await page.getByRole('button',{name:'Explore the local demo'}).click();
  await expect(page.getByRole('button',{name:'Add another passkey'})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Family membership'})).toHaveCount(0);
});
