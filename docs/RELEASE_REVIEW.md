# Independent release review — 2026-10-07

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
