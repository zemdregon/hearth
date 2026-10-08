import {
  browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

export type PasskeyRequest = { <T>(path: string, body?: unknown): Promise<T>; assertCurrent(): void };

// Capture a fragment invitation before React renders or any request starts. Never
// put this value in a query string, persistent browser storage, or a log.
function readArrivalInvitation(): { token: string | null; invalid: boolean } {
  if (!window.location.hash.startsWith('#enroll=')) return { token: null, invalid: false };
  const fragment = window.location.hash.slice('#enroll='.length);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(fragment)) return { token: null, invalid: true };
  return { token: fragment, invalid: false };
}
let arrivalInvitation = readArrivalInvitation();
export const arrivedForEnrollment = !!arrivalInvitation.token || arrivalInvitation.invalid;
// A private link may navigate an already-open PWA without loading a new document.
// Capture and erase it synchronously in the hashchange handler as well.
export function captureArrivalInvitation(): boolean {
  if (!window.location.hash.startsWith('#enroll=')) return false;
  arrivalInvitation = readArrivalInvitation();
  return true;
}
export function initialInvitation() { return arrivalInvitation; }
export function forgetInitialInvitation() { arrivalInvitation = { token: null, invalid: false }; }
export function cancelPasskeyCeremony() { WebAuthnAbortService.cancelCeremony(); }

function requirePasskeys() {
  if (!window.isSecureContext || !browserSupportsWebAuthn()) {
    throw new Error('Passkeys aren’t available in this browser. Open Hearth’s secure address in a current browser on your phone or computer, or use a security key.');
  }
}
function ceremonyError(error: unknown): Error {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error('The passkey request was canceled or timed out. Try again when you’re ready, and unlock your device if asked.');
  if (name === 'InvalidStateError') return new Error('This passkey may already be registered. Sign in with it, or choose another device or security key.');
  return new Error('The passkey request couldn’t finish. Try a current browser, another device, or a security key.');
}
export async function verifyPasskey(request: PasskeyRequest, operation: 'login' | 'reauth') {
  requirePasskeys();
  const { ceremonyId, options } = await request<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>(`/api/auth/${operation}/options`, {});
  request.assertCurrent();
  let response;
  try { response = await startAuthentication({ optionsJSON: options }); }
  catch (error) { throw ceremonyError(error); }
  await request(`/api/auth/${operation}/verify`, { ceremonyId, response });
}
export async function createPasskey(request: PasskeyRequest, name: string, token?: string) {
  requirePasskeys();
  const { ceremonyId, options } = await request<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/register/options', token ? { token } : {});
  request.assertCurrent();
  let response;
  try { response = await startRegistration({ optionsJSON: options }); }
  catch (error) { throw ceremonyError(error); }
  await request('/api/auth/register/verify', { ceremonyId, response, ...(name.trim() ? { name: name.trim() } : {}) });
}
