# Hearth roadmap

## First usable release — verified locally
These checked milestones describe the pre-transition implementation. They do not establish passkey readiness; the authentication replacement below is now the next implementation priority.

- [x] Private Workers API with verified family access and D1 persistence
- [x] Modular responsive app shell, installable PWA, offline public shell
- [x] Recipe library, authoring, URL/text extraction, camera OCR drafts, portion scaling
- [x] Shared tasks, note of the day, countdowns, editable member profiles, long-term goals
- [x] Shared streak calendar, private-by-default moods, daily couples questions
- [x] Module administration and safe data export
- [x] Local demo and real API development workflow
- [x] Cloudflare deployment automation and documented operational setup
- [x] Consolidated final checks and source checkpoint after independent review fixes

## Discovery improvements completed
- [x] Browser and Axe accessibility checks, readable mobile typography, keyboard-focus navigation
- [x] Atomic aggregate storage budgets and genuine local D1 trigger semantics
- [x] First-visit offline shell precaching, build revisions, cache privacy/MIME checks, CORS Vary handling
- [x] Synchronous logout, cross-tab logout, back/forward-cache privacy and stale mutation suppression
- [x] Confirmed saves remain visible when a follow-up refresh fails
- [x] Midnight/DST/calendar behavior, concurrent form drafts, immutable dated questionnaire cycles
- [x] Patched development dependencies; zero known audit findings at the checkpoint
- [x] Production preflight validates authentication, allowlist, route, database and development-bypass settings
- [x] On-device photo orientation, resizing, metadata removal and reviewable upload preview
- [x] Independent review closure: delayed export and recipe-save races
- [x] Single-command local launcher with preserved configuration, local-only services, authenticated readiness and owned-process cleanup
- [x] Print-friendly recipe sheets using adjusted servings, with long-document and privacy checks
- [x] Explicit couples pairing, immutable answer audiences, private legacy history and separate family profile consent
- [x] Bounded recipe and mood pages with preserved drafts, keyboard navigation and measured large-history improvements
- [x] Atomic offline-shell updates, exact-build document verification and isolated cache fallback

## Next roadmap
- [x] Decide internal, invite-only passkey authentication with no passwords, email identities, OTP or social login; document [transition and recovery contract](AUTHENTICATION.md)
- [x] Add additive D1 authentication schema, email-free member contracts and offline proposed-roster validation without altering existing ownership
- [ ] Implement operator-reviewed roster import preserving historical ids; remove legacy email fields from runtime, bootstrap, fixtures and exports at cutover
- [ ] Implement verified WebAuthn ceremonies, private enrollment, revocable sessions, backup passkeys and administrator/operator recovery
- [ ] Build passkey sign-in, enrollment and credential/member management; retain privacy and session-clearing behavior
- [ ] Replace Access/email runtime, deployment configuration and local authentication workflow together; verify rejection cases, browser flows and real phone/PWA passkeys before cutover
- [ ] Complete live Cloudflare deployment, passkey verification and model-license/inference smoke tests after the authentication transition
- [x] Add coarse family-capacity guidance before storage writes reach their limit
- [x] Evaluate server pagination, archival and refresh payload reduction before lifting family data limits
- [ ] Validate D1 backup restore in an isolated database when account access exists
- [ ] Continue independent user-flow discovery after each verified milestone; keep scope tied to this family's modular app

## Verification evidence
Passkey foundation, observed 2026-10-08: `npm test -- --maxWorkers=1` passes **471 tests**, including **74 real SQLite migration/constraint checks** and **21 roster validation/CLI checks**. The additive migration preserves existing record bytes, owners, couples audiences, module settings and storage accounting; authentication tables start empty. `npm run build` passes TypeScript and production bundling. All three migrations also applied successfully through Wrangler to an isolated temporary local D1 database using the `DB` binding. Independent Astra Ultra review found no substantive issues. No browser flow changed (the built browser bundle/revision is unchanged), so browser tests were not rerun for this checkpoint. No remote migration, enrollment, passkey sign-in or deployment was performed. Operator-reviewed import, runtime email removal, ceremonies, sessions and UI remain unchecked work above.

Scaling evaluation, observed 2026-10-08: conditional member-visible bootstrap refresh removes unchanged response bodies while retaining fresh authentication/visibility checks, complete snapshots and both existing storage limits. The reproducible two/five-year fixtures measure 3,211,871 / 4,521,699 JSON bytes for a full response and zero body bytes for an unchanged response; full database reads remain. See `PERFORMANCE.md` for the measurements, domain-pagination prerequisites and reversible-archival/delta-sync decisions. `npm test -- --maxWorkers=1` passes **376 tests**, and `npm run build` passes TypeScript and the production build. All **91 browser checks** pass across the full single-worker run (**89 passed**, two mobile/accessibility timeouts) and an unchanged `--last-failed --workers=1` rerun (**2 passed**). This includes **18 conditional-refresh tests** and **5 real Worker/browser persistence tests**. Independent Astra Ultra review found no concrete defects, including the added midnight and delayed-response regressions. Earlier verification runs encountered timeouts during severe shared-host contention; assertions and timeouts remain unchanged. `wrangler deploy --dry-run` also succeeds (166.79 KiB gzip). Live deployment, Access verification, inference and isolated D1 restore remain blocked by the configuration listed below.

Capacity milestone, observed 2026-10-08: `npm run check` passes **369 unit/API/deployment/PWA/launcher tests**, TypeScript and the production build. All **71 Playwright tests** pass together with two workers using managed Chromium, including **9 dedicated capacity browser tests** covering all buckets and unavailable guidance, member access, draft preservation, failed refresh after confirmed saves, mobile Axe/overflow, recipe print privacy and logout with a late response. `wrangler deploy --dry-run` bundles the Worker and assets successfully (166.47 KiB gzip); no live deployment or inference was attempted. Independent Astra Ultra review found no concrete issues. Capacity is a coarse whole-family signal from the same D1 snapshot as records; private and paused-module data contribute without exposing exact usage. Existing atomic limits remain unchanged. T3 collaborative preview could not start because host AppArmor blocks its browser sandbox; browser tests used the repository's Playwright configuration with cached managed Chromium instead.

Previous local checkpoint, observed 2026-10-07: `npm run check` passes **363 unit/API/deployment/PWA/launcher tests**, TypeScript and the production build. All **62 Playwright tests** pass together with two workers. These include actual Worker/D1 pairing and withdrawal, three-member privacy, five-year mood fixtures, 500-recipe pagination, interrupted and overlapping PWA updates, all module flows, accessibility, camera preparation, print privacy and session isolation. `wrangler deploy --dry-run` bundles the Worker and assets successfully (166.27 KiB gzip). See `RELEASE_REVIEW.md` for independent review and `PERFORMANCE.md` for measured improvements and their limits.

Earlier pushed checkpoints `1d0bc1a` (259 unit checks / 42 browser checks) and `bb1d232` (300 / 45) both passed GitHub Actions with fresh dependencies and managed Chromium. Isolated launcher smoke tests verified startup, authenticated API access, occupied-port handling, and SIGINT/SIGTERM cleanup. Independent print review verified a nine-page recipe retained final instructions and excluded family/draft content. Dependency audit reported zero known vulnerabilities at the initial checkpoint; package versions have not changed since. Real Access and Workers AI calls have not run.

## Transition status and external prerequisites
On 2026-10-08 the user replaced the Access plan with internal passkey-only authentication. This creates actionable local implementation work; missing Access settings and email allowlists are no longer prerequisites to pursue. The existing preflight still reports them because its replacement has not been implemented. Do not bypass those checks to deploy the current code.

The Cloudflare token and account ID are available, and authenticated D1 discovery succeeded. The local DB binding identifies the existing `hearth-family-db`; no remote schema or data was changed. Production still needs a stable HTTPS hostname/route and RP ID, operator-authorized initial administrator enrollment, verified passkey implementation, real-device checks, inference/license verification and an isolated restore rehearsal. Earlier independent review and test evidence apply to the pre-transition implementation only. No passkey implementation, live authentication or inference success is claimed.

## Product decisions
Working name: Hearth. One family per deployment; no public signup. Internal passkeys are the sole planned authentication method, with private enrollment and permanent member ids; no passwords, email addresses, OTP or social-login fallback. Family timezone configurable. Mood entries private unless shared. Daily answers record an immutable pair and reveal only when both partners in that currently active pair have answered; separate profile consent releases a preference to the whole family. Larger households require an explicit pair; legacy answers remain author-only. Modules can be disabled without deleting data. AI produces drafts for human review. Demo data is fictional and memory-only. Offline storage contains only the public shell, never private family records.
