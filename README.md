# Hearth

A private, modular home for your family: recipes, shared tasks, daily notes, streaks, countdowns, moods, daily questions, profiles and long-term goals. Built with React, TypeScript, Cloudflare Workers, D1 and Workers AI.

![Hearth desktop demo](docs/screenshots/hearth-desktop.png)

## Local preview

Use Node 24 LTS or newer and npm. Run `npm ci` and `npm run dev`, then open http://localhost:5173 and choose the clearly labeled demo. Demo data lives only in memory and resets when you leave or reload; it is never sent to the API. The production application does not seed fictional family data.

For real local persistence, run `npm run dev:full`. This builds the app, creates `.dev.vars` from the local example only when the file is absent, applies local D1 migrations, and starts the API and browser app together. Open http://localhost:5173; press Ctrl+C to stop both services. Existing local configuration and database records are preserved. Workers AI is disabled in this local session; recipe authoring and structured recipe-link extraction remain available.

The launcher binds to loopback and never uses remote bindings. To choose different ports, use `npm run dev:full -- --api-port 8789 --ui-port 5174`. Use `--check` to validate configuration and available ports without changing files or starting services, or `--skip-build` to reuse a previous build.

To run the services separately:

1. Run `npm run build` to create Worker assets.
2. Copy `.dev.vars.example` to `.dev.vars`.
3. Run `npm run db:local`.
4. Run `npm run dev:api` in another terminal alongside `npm run dev`.

Local authentication uses the same passkey ceremonies and server sessions as production. Configure `APP_ORIGIN` and `WEBAUTHN_RP_ID`, import a reviewed roster with `npm run auth:operator`, and authorize initial administrator enrollment. See [operator commands](docs/AUTHENTICATION.md#operator-commands). There is no development identity header or automatic sign-in; the memory-only demo remains available without an account.

Local daily questions pair an active two-member household automatically. For deployment, configure `FAMILY_QUESTION_PAIR` explicitly as two permanent member ids, such as `["alex","sam"]`; JSON `null` disables participation. Answers reveal privately after both partners answer, with separate opt-in for family profile sharing. Earlier answers without a recorded pair remain owner-only. See the [pairing rules](docs/DEPLOYMENT.md#daily-question-pairing) before changing a pair.

## Validation

`npm run check` runs TypeScript, unit/API tests, and the production build. `npm run test:e2e` runs browser tests with Chromium (`CHROMIUM_PATH` may override `/usr/bin/chromium`). Production deployment and live AI inference require configured Cloudflare access; passing local tests does not imply either was performed.

The passkey checkpoint passes 511 unit/API/deployment/PWA/launcher tests, with real Worker/D1 and browser verification tracked in the roadmap. Coverage includes passkey ceremonies, operator recovery, explicit couples privacy, large collections, accessibility and offline updates. See the roadmap for checkpoint details and [performance evidence](docs/PERFORMANCE.md). The patched `sharp` override keeps Wrangler's local development image dependency current; reassess the override when Wrangler incorporates that patch.

## Production

See [deployment](docs/DEPLOYMENT.md), [architecture](docs/ARCHITECTURE.md), and [roadmap](docs/ROADMAP.md). The repository deliberately has no credentials or real family identities. Hearth uses [internal, invite-only passkeys](docs/AUTHENTICATION.md): no passwords, email identities, OTP or social login. D1 membership and revocable sessions enforce access on the server; missing passkey configuration fails closed. Real-device and live-deployment verification are tracked separately in the roadmap.
