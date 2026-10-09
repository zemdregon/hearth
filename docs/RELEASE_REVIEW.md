# Release review

## Current release gates — 2026-10-09

Authorized deployment follow-up: the remote D1 backup was retained privately, all six migrations applied, and Worker version `b2fc7a7d-befe-4ccd-bbd5-98d2f1557a13` is live at **https://hearth.kaina.one**. Database integrity and foreign-key checks pass. Live API checks verify private-route denial, required invitation, exact RP ID, required user verification, secure ceremony cookies and rejection of cross-origin/legacy identity attempts. Desktop/mobile browser checks verify the passkey gate and public-only offline shell. Remote migration execution required equivalent CASE-free storage guards; default asset HTML redirects required explicit `html_handling: "none"`. Relevant follow-up suites pass (120 storage/schema/API tests, 80 deployment/PWA tests and typecheck), followed by the complete 558-test suite, TypeScript and production build. See the roadmap for exact evidence. Initial administrator enrollment, real-device passkeys/recovery, AI inference/licensing and isolated remote restore are still outstanding. The account and hostname paragraphs/table below describe the earlier predeployment state.

Hostname follow-up, 2026-10-09: the selected origin is `https://hearth.kaina.one` with RP ID `hearth.kaina.one`. Read-only checks found no existing DNS record or Worker custom-domain binding at that hostname. Local route configuration, preflight with these environment values, all 48 deployment tests and Worker dry run pass. Publication and remote migrations remain unperformed. The account inspection below records the earlier state.

The current implementation uses internal passkeys only. The Access-era reviews below are historical regression evidence, not the current authentication design. Latest completed checks: 556 unit/integration tests, 12 focused passkey browser checks, production build, Worker dry run and the isolated local D1 restore/recovery rehearsal. The preceding complete browser run passed 103 checks. See [ROADMAP.md](ROADMAP.md) for exact scopes and chronology.

Read-only account inspection observed the following on 2026-10-08:

| Gate | Observed state | Remaining evidence |
| --- | --- | --- |
| Account token | Account-token verification returned HTTP 200 and `active`; authenticated resource reads succeeded | Authorization for the intended remote writes; read success does not prove write permissions |
| Worker | Deployments lookup returned HTTP 404/code 10007: `hearth-family` does not exist | First deployed version, canonical route and anonymous private-API denial |
| Database | `hearth-family-db` metadata returned HTTP 200, zero tables and 12,288 bytes | Remote backup baseline, six migrations and initial reviewed member setup |
| Hostname | Twelve active account zones are available; the Worker custom-domain list has no Hearth entry | Operator-selected permanent hostname, matching RP ID and route |
| AI models | Both configured model names appeared in the authenticated model catalog | License acceptance, permission to invoke them and successful bounded fictional text/photo inference |
| Restore | Local export/import, authentication lock, retired-key rejection and fresh recovery passed | Isolated remote D1 import/Time Travel and remote transaction behavior |
| Real devices | Chromium virtual-authenticator checks passed | Actual phone/PWA enrollment, second-device sign-in, backup-key use and recovery |

The token is account-owned: `/user/tokens/verify` returned HTTP 401 while the [account-token verification endpoint](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/) returned `active`. Do not diagnose this token as unusable from the user-token endpoint alone. No token value, account id, private roster or database content is recorded here. Account/model metadata is not evidence of a deployed app or successful inference. No remote resource was created or modified during this inspection.

### Real-device acceptance procedure

Run this after a deliberately authorized candidate deployment at the final hostname. Use operator-approved test membership and fictional records; retain the permanent member ids if those identities will continue into normal family use. Record the date, deployed version, device/OS/browser, install mode, outcome and any reproducible failure for each scenario. Record outcomes rather than private links, cookies, credentials or family content.

1. On the first intended phone/browser, open the initial administrator invitation. Confirm its fragment disappears from the address/history, register a passkey with device verification, and verify registration alone leaves the private API unauthenticated. Sign in separately, reload, and confirm the expected identity.
2. Install the PWA where supported. Launch it from the home screen and verify passkey sign-in at the same canonical origin. Background/resume it, then sign out and use back navigation/offline launch; private content must not return. Record any OS/browser limitation rather than assuming virtual-authenticator behavior carries over.
3. Add a second passkey or security key after fresh verification. Sign in with it from the second intended device/browser. Verify the household can recover access when the first device is unavailable. Test each OS/browser actually used by the family; a single passing phone does not establish all-device support.
4. Issue a separate member invitation and open it both in a new tab and an already-running PWA. Use fresh invitations for each successful enrollment scenario. Verify each token is cleared, its intended identity cannot be changed, and separately verify reuse/expiry/revocation prevents enrollment. An invitation must never directly create a session.
5. Revoke one backup credential and verify it cannot sign in. Verify the remaining credential still works and ordinary management prevents removing the last usable passkey. Revoke all sessions; previously open devices must lose private API access and clear their UI on the next check.
6. Rehearse member recovery with a second administrator, and operator recovery in the isolated release test setup. Old credentials, cookies and invitations must fail. Register a fresh passkey for the same permanent id, separately sign in, and confirm that owned records and private/shared visibility remain correct. Check suspension and the last-active-administrator safeguard.
7. Use only fictional recipe text and a fictional recipe image for authorized live AI smoke tests. Confirm returned content is a reviewable draft and a failed call does not save a recipe. Do not send mood, profile or unrelated family data. Record actual model success or the exact redacted failure; catalog presence alone is insufficient.

Keep unresolved scenarios on the roadmap. Virtual-authenticator tests, local restore success and a deployment dry run cannot close these live gates. Follow the [deployment and restore sequence](DEPLOYMENT.md) before normal family use.

## Independent release review — 2026-10-07

Read-only source review covered the README development path, deployment scripts, API/client contracts, SQLite migrations and storage budget, module visibility, record versions, session handling, exports, PWA caching, and module form behavior. Existing implementation files were not changed by this review.

## Reproduced findings

Both findings below were fixed before the first checkpoint. Their reproductions are retained to explain the regression coverage.

- Export now uses `FamilyProvider.exportData()`, rejects a changed session before returning any downloadable data, and handles expired Access HTML/redirects through the shared API path. `tests/e2e/session-sync.spec.ts` verifies late exports never download after sign-out and expired Access pages never become exports.
- Recipe saves now lock all editor fields and every modal close path. `tests/e2e/recipes.spec.ts` verifies delayed success, blocked close/Escape/backdrop attempts, retained drafts after failure, and successful retries.
- Verification: both fixes were included in the consolidated run of 259 unit/API tests and all 42 browser tests, plus the production build and Workers deployment dry run.

1. **P2 — a delayed export downloads after sign-out.** `src/client/App.tsx`, `ModuleSettings.exportData`, performs a raw fetch and then creates a download without checking whether the initiating session is still active. In Chromium, hold a successful `/api/export` response, broadcast `logout` on `hearth-session`, wait for the sign-in gate, and release the response. A `hearth-2026-10-07.json` download still starts. Route exports through the provider's session checks and suppress download after session invalidation. Regression coverage should also exercise HTML/redirect responses from an expired Access session.

2. **P2 — an earlier recipe save discards a newer draft.** `src/client/modules/Recipes.tsx`, `saveRecipe` and the editor modal, allow the modal close button/Escape/backdrop while the save is pending. `saveRecipe` later calls `setEditor(null)` unconditionally. In Chromium, hold recipe A's POST, close its dialog, open recipe B and type a new title, then release A's response. Recipe A saves and recipe B's unsaved dialog disappears. Recipe inputs also remain editable during the pending save, so edits made after submission can be discarded. Disable the editor and every close path while saving, or use an operation identity that cannot close a newer editor. Cover delayed success and failed saves.

## Evidence and limits

- Both findings were reproduced using standalone Playwright/Chromium scripts against the existing Vite process with controlled API responses; no real family data or database records were changed.
- The documented `APP_ORIGIN=http://localhost:5173` matches browser mutation origins through the Vite proxy; backend configuration accepts its loopback hostname. D1 writes recheck module state and optimistic versions. Aggregate storage is enforced transactionally, including hidden records.
- Existing tests cover persisted task edits, SQL constraints, signed identity verification, module preservation, private-data visibility, family-timezone calculations, and cache boundaries. This review did not rerun the full suite or production build while implementation work was concurrent; the final integrated check remains the release owner's responsibility.
- Production Access, the actual account/hostname, live Workers AI inference, and physical-phone camera/install behavior remain unverified until their documented prerequisites are available. Local success is not evidence of live deployment.

## Follow-up checkpoint review

The reviewer independently repeated both race reproductions and confirmed their fixes. A 26,489-byte recipe containing 50 ingredients, 40 method steps, and a long source URL produced a nine-page A4 PDF with its final ingredient, method and source retained. Private member, note and unsaved-editor sentinels were absent; signing out removed the print sheet.

Launcher review found that public health alone could report readiness despite invalid family configuration. Startup now also checks authenticated bootstrap status and discards the body without parsing or printing private data. All 41 launcher tests passed independently. The implementation owner also verified isolated startup, proxy access, origin enforcement, occupied-port handling, and owned-process cleanup. Review identified an inaccurate Node minimum in the README; the project now requires Node 24+, matching CI and its unflagged SQLite test support.

The integrated follow-up checkpoint passed 300 unit/API/deployment/PWA/launcher tests, TypeScript and the production build, and all 45 browser tests together.

## Pairing, collection growth and offline updates

Independent pairing review found no actionable privacy or correctness issue. It covered stored audiences, same-day atomic guards, private legacy answers, explicit family profile consent, deletion revoking partner visibility, configuration changes clearing stale drafts, and deployments replacing stale pairing secrets. Targeted review validation passed 191 checks across six unit/API suites. Integration also verified pair reveal and withdrawal against real local Workers/D1 storage.

Offline-update review reproduced three failure modes: partial asset downloads replacing a complete shell, overlapping deployments serving HTML for another build, and global cache lookup selecting an unrelated cached document. Installation now settles and verifies every asset before activation, rejects HTML whose SHA-256 differs from the built document, discards incomplete candidates, and reads offline HTML only from the active Hearth cache. Two independently repeated Chromium lifecycle tests verified failed updates preserve the previous offline shell and complete retries replace it; unrelated caches remain untouched and never supply the document.

Recipe and mood histories now use bounded pages. Large fictional fixtures verified global filtering, page clamping, edit/draft preservation and keyboard access. See `PERFORMANCE.md` for controlled mood measurements. The combined checkpoint passed 363 unit/API checks, the production build, all 62 browser tests, and a Worker deployment dry run. Live account, Access and AI prerequisites remain unchanged.
