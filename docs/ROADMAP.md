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
- [ ] Add coarse family-capacity guidance before storage writes reach their limit
- [ ] Evaluate server pagination, archival and refresh payload reduction before lifting family data limits
- [ ] Validate D1 backup restore in an isolated database when account access exists
- [ ] Continue independent user-flow discovery after each verified milestone; keep scope tied to this family's modular app

## Verification evidence
Latest local checkpoint, observed 2026-10-07: `npm run check` passes **363 unit/API/deployment/PWA/launcher tests**, TypeScript and the production build. All **62 Playwright tests** pass together with two workers. These include actual Worker/D1 pairing and withdrawal, three-member privacy, five-year mood fixtures, 500-recipe pagination, interrupted and overlapping PWA updates, all module flows, accessibility, camera preparation, print privacy and session isolation. `wrangler deploy --dry-run` bundles the Worker and assets successfully (166.27 KiB gzip). See `RELEASE_REVIEW.md` for independent review and `PERFORMANCE.md` for measured improvements and their limits.

Earlier pushed checkpoints `1d0bc1a` (259 unit checks / 42 browser checks) and `bb1d232` (300 / 45) both passed GitHub Actions with fresh dependencies and managed Chromium. Isolated launcher smoke tests verified startup, authenticated API access, occupied-port handling, and SIGINT/SIGTERM cleanup. Independent print review verified a nine-page recipe retained final instructions and excluded family/draft content. Dependency audit reported zero known vulnerabilities at the initial checkpoint; package versions have not changed since. Real Access and Workers AI calls have not run.

## External blockers
Initial environment has no configured secrets, runtime variables or outbound identities. Cloudflare account credentials, family allowlist and Access application identity are not supplied. Continue all local implementation and deployment preparation; keep production fail-closed.

## Product decisions
Working name: Hearth. One family per deployment; no public signup. Cloudflare Access authenticates family members; application also checks an explicit allowlist. Family timezone configurable. Mood entries private unless shared. Daily answers record an immutable pair and reveal only when both partners in that currently active pair have answered; separate profile consent releases a preference to the whole family. Larger households require an explicit pair; legacy answers remain author-only. Modules can be disabled without deleting data. AI produces drafts for human review. Demo data is fictional and memory-only. Offline storage contains only the public shell, never private family records.
