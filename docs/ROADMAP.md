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

## Discovery improvements completed in the first pass
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

## Next roadmap
- [ ] Complete live Cloudflare provisioning, Access verification and model-license/inference smoke tests when configured access exists
- [ ] Add a straightforward single-command local development launcher
- [ ] Add print-friendly recipe sheets and cooking accessibility improvements
- [ ] Evaluate bounded pagination/archival before lifting family data limits
- [ ] Evaluate explicit couples pairing for households with more than two configured members
- [ ] Validate D1 backup restore in an isolated database when account access exists
- [ ] Continue independent user-flow discovery after each verified milestone; keep scope tied to this family's modular app

## Verification evidence
Observed 2026-10-07: `npm run check` passes (259 unit/API/deployment/PWA tests plus TypeScript and production build); all 42 Playwright tests pass together with two workers. Browser suites cover actual Worker/D1 persistence, all modules, large/rotated camera photos, private-data sharing, mobile layouts, accessibility, concurrent drafts, first-install offline reload, and sign-out. `wrangler deploy --dry-run` bundles the Worker and assets successfully (about 166 KiB gzip). Dependency audit reports zero known vulnerabilities. Real Access and Workers AI calls have not run. See `RELEASE_REVIEW.md` for independent findings and their verified fixes. Ongoing follow-up changes require their own checks before the next checkpoint.

## External blockers
Initial environment has no configured secrets, runtime variables or outbound identities. Cloudflare account credentials, family allowlist and Access application identity are not supplied. Continue all local implementation and deployment preparation; keep production fail-closed.

## Product decisions
Working name: Hearth. One family per deployment; no public signup. Cloudflare Access authenticates family members; application also checks an explicit allowlist. Family timezone configurable. Mood entries private unless shared. Questionnaire answers reveal once all configured members answer (both partners in a two-person family), with explicit opt-in for profile sharing. Modules can be disabled without deleting data. AI produces drafts for human review. Demo data is fictional and memory-only. Offline storage contains only the public shell, never private family records.
