# Hearth roadmap

## First usable release — verified locally
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
- [ ] Complete live Cloudflare provisioning, Access verification and model-license/inference smoke tests when configured access exists
- [x] Add coarse family-capacity guidance before storage writes reach their limit
- [x] Evaluate server pagination, archival and refresh payload reduction before lifting family data limits
- [ ] Validate D1 backup restore in an isolated database when account access exists
- [ ] Continue independent user-flow discovery after each verified milestone; keep scope tied to this family's modular app

## Verification evidence
Scaling evaluation, observed 2026-10-08: conditional member-visible bootstrap refresh removes unchanged response bodies while retaining fresh authentication/visibility checks, complete snapshots and both existing storage limits. The reproducible two/five-year fixtures measure 3,211,871 / 4,521,699 JSON bytes for a full response and zero body bytes for an unchanged response; full database reads remain. See `PERFORMANCE.md` for the measurements, domain-pagination prerequisites and reversible-archival/delta-sync decisions. `npm test -- --maxWorkers=1` passes **376 tests**, and `npm run build` passes TypeScript and the production build. All **91 browser checks** pass across the full single-worker run (**89 passed**, two mobile/accessibility timeouts) and an unchanged `--last-failed --workers=1` rerun (**2 passed**). This includes **18 conditional-refresh tests** and **5 real Worker/browser persistence tests**. Independent Astra Ultra review found no concrete defects, including the added midnight and delayed-response regressions. Earlier verification runs encountered timeouts during severe shared-host contention; assertions and timeouts remain unchanged. `wrangler deploy --dry-run` also succeeds (166.79 KiB gzip). Live deployment, Access verification, inference and isolated D1 restore remain blocked by the configuration listed below.

Capacity milestone, observed 2026-10-08: `npm run check` passes **369 unit/API/deployment/PWA/launcher tests**, TypeScript and the production build. All **71 Playwright tests** pass together with two workers using managed Chromium, including **9 dedicated capacity browser tests** covering all buckets and unavailable guidance, member access, draft preservation, failed refresh after confirmed saves, mobile Axe/overflow, recipe print privacy and logout with a late response. `wrangler deploy --dry-run` bundles the Worker and assets successfully (166.47 KiB gzip); no live deployment or inference was attempted. Independent Astra Ultra review found no concrete issues. Capacity is a coarse whole-family signal from the same D1 snapshot as records; private and paused-module data contribute without exposing exact usage. Existing atomic limits remain unchanged. T3 collaborative preview could not start because host AppArmor blocks its browser sandbox; browser tests used the repository's Playwright configuration with cached managed Chromium instead.

Previous local checkpoint, observed 2026-10-07: `npm run check` passes **363 unit/API/deployment/PWA/launcher tests**, TypeScript and the production build. All **62 Playwright tests** pass together with two workers. These include actual Worker/D1 pairing and withdrawal, three-member privacy, five-year mood fixtures, 500-recipe pagination, interrupted and overlapping PWA updates, all module flows, accessibility, camera preparation, print privacy and session isolation. `wrangler deploy --dry-run` bundles the Worker and assets successfully (166.27 KiB gzip). See `RELEASE_REVIEW.md` for independent review and `PERFORMANCE.md` for measured improvements and their limits.

Earlier pushed checkpoints `1d0bc1a` (259 unit checks / 42 browser checks) and `bb1d232` (300 / 45) both passed GitHub Actions with fresh dependencies and managed Chromium. Isolated launcher smoke tests verified startup, authenticated API access, occupied-port handling, and SIGINT/SIGTERM cleanup. Independent print review verified a nine-page recipe retained final instructions and excluded family/draft content. Dependency audit reported zero known vulnerabilities at the initial checkpoint; package versions have not changed since. Real Access and Workers AI calls have not run.

## External blockers
Rechecked on 2026-10-08 after the user enabled `CLOUDFLARE_API_TOKEN`: the token and account ID are available, and an authenticated `wrangler d1 list --json` succeeded. The local DB binding now identifies the existing `hearth-family-db` database; no remote schema or data was changed. `npm run deploy:preflight` still reports missing `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `APP_ORIGIN`, `FAMILY_MEMBERS`, and the Access-protected hostname route. Live Access, inference and isolated restore remain unverified. A bounded independent Astra review after the capacity and conditional-refresh milestones found no additional actionable local gap in the required flows or deployment/restore preparation. Recurring discovery remains ongoing; deployment requires the remaining external configuration above. Keep production fail-closed.

## Product decisions
Working name: Hearth. One family per deployment; no public signup. Cloudflare Access authenticates family members; application also checks an explicit allowlist. Family timezone configurable. Mood entries private unless shared. Daily answers record an immutable pair and reveal only when both partners in that currently active pair have answered; separate profile consent releases a preference to the whole family. Larger households require an explicit pair; legacy answers remain author-only. Modules can be disabled without deleting data. AI produces drafts for human review. Demo data is fictional and memory-only. Offline storage contains only the public shell, never private family records.
