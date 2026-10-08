# Cloudflare deployment

## Authentication transition — deployment on hold

The accepted deployment target uses internal passkey-only authentication, not Cloudflare Access. No email identity provider, password, OTP or public signup is part of the new plan. Follow [AUTHENTICATION.md](AUTHENTICATION.md) for the implementation and cutover gates. The current Worker and deployment scripts still require the old Access configuration; do not weaken or bypass them to publish an unfinished replacement.

Cloudflare Workers, D1 and Workers AI remain the hosting stack. Token/account configuration and read-only D1 access were verified on 2026-10-08; `wrangler.jsonc` identifies the existing `hearth-family-db`. Remote migrations, deployment and inference have not been verified.

Planned release sequence, executable only after the authentication implementation is complete:

1. Select a stable canonical HTTPS hostname and exact `APP_ORIGIN`; configure a matching WebAuthn RP ID and Worker route. Keep `workers_dev: false` and reject unexpected origins. Changing the RP ID later requires an explicit credential migration/re-enrollment plan.
2. Back up D1 and rehearse restore in isolation. Apply the new authentication migrations after reviewing their preservation of permanent member ids and existing data ownership.
3. Use the explicit operator bootstrap command to authorize the initial administrator's passkey enrollment. The command and private enrollment UI are planned work, not currently available. Add a second passkey and rehearse recovery before relying on the deployment.
4. Enroll other members through administrator-issued private invitations. Store membership internally in D1 without email fields. Set the family timezone and question pair using permanent ids.
5. Run the revised preflight and deployment workflow after its tests pass. It must validate passkey origin/RP configuration and reject production development bypasses, without requiring Access secrets or email-bearing `FAMILY_MEMBERS`. Remove legacy Access configuration only with the verified replacement release.
6. Verify unauthenticated private API denial, passkey sign-in, enrollment/recovery, session revocation, member isolation and private moods/answers on the actual phones and PWA. Then verify recipe text/photo AI drafts and model licensing in the target account.

Member ids are permanent ownership keys. Never assign a departed member's id to a different person: doing so grants that identity the former member's private records. Removing a member revokes application access but preserves their data; their shared records remain available and private records remain private.

Keep account tokens and enrollment authorizations out of commits, command history and logs. The current `npm run deploy` applies remote migrations and publishes the Worker; it is not a passkey deployment command yet.

Workers AI calls require a live binding and may incur account usage charges. JSON-LD extraction and manual recipe entry avoid unnecessary model calls. Set Cloudflare account budgets/alerts appropriate for household use. Never log recipe images, access tokens, mood entries or full API bodies in observability.

The vision model `@cf/meta/llama-3.2-11b-vision-instruct` requires account acceptance of Meta's model license before first use. Follow the [official Cloudflare vision setup](https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/). Text extraction uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Model availability, license acceptance and actual inference must be verified in the target account. URL import requires public recipe-site and Cloudflare DNS egress. Local tests use controlled fixtures; they do not establish live destination reachability. Verify egress in the target runtime before relying on remote imports.

## Daily question pairing

The following describes the current configuration. During the auth transition, validate pair ids against internal membership instead of the email-bearing deployment roster; preserve the same privacy semantics and explicit pair across migration.

`FAMILY_QUESTION_PAIR` configures one pair per household. Both ids must be distinct and present in `FAMILY_MEMBERS`; invalid JSON, unknown ids, and arrays of any other size fail closed. The runtime and deployment preflight share the same parser and normalize id order. This setting is optional, but every deployment uploads its resolved pair or `null` as a Worker secret. Removing the environment setting therefore replaces a previously configured secret with the current roster's default instead of retaining stale pairing. Use explicit JSON `null` to keep even a two-member household unpaired. The two-person demo continues to pair automatically.

New answers record their original two participant ids. Private reveal requires both members of that exact active pair to answer the same dated question. Profile sharing is a separate, reversible author opt-in that makes an answer visible to the whole family only after that answer has been released to its pair. Changing or disabling the pair hides answers from a previous pair from nonowners, including on profiles; owners retain their own history. Saved answers and stale drafts cannot be assigned to a replacement partner. If today's saved answer belongs to a different pair, the new pair resumes tomorrow.

Older answers without participant ids remain owner-only, including answers previously marked for profile sharing. No audience is inferred from the current roster, and no SQL migration is required for pairing. Preserve stable member ids permanently and never reuse them for a different person.

## Backup and recovery

Use D1 Time Travel and periodic account-controlled database exports. A user's in-app export intentionally includes only records that identity may view; it is not an administrator bypass or complete disaster-recovery backup. Store full database backups encrypted in a family-controlled location. Verify restore into a separate non-production database before depending on backups.

For a bad code release, use `npx wrangler rollback` only to a version compatible with the restored authentication configuration and schema. D1 migrations are separate from Worker rollback: keep migrations additive, take a backup before destructive changes, and restore to a separate database when needed. Never overwrite the live database blindly. The passkey restore workflow must invalidate restored sessions, invitations and challenges and reconcile credential/member revocations before admitting traffic; rolling back code alone must not resurrect access.

## Resource boundaries

The current release loads the family collection together. Conditional refresh avoids sending unchanged response bodies but still reads and processes the full collection. Atomic database triggers limit it to 10,000 records and 8 MiB of UTF-8 record data, including private and disabled-module data. Individual records are limited to 32 KiB. Delete or shrink existing records to recover capacity; nothing is silently discarded. Server pagination and bounded export measurements are prerequisites for raising these bounds; archival remains a separate, reversible product capability to evaluate. See the [scaling evaluation](PERFORMANCE.md) for constraints and measured limits. Apply all checked-in migrations before starting the updated Worker; the additive authentication tables do not themselves enable passkey sign-in.

Each member has limits of 300 requests per minute, 240 writes per hour, 10 recipe imports per hour and 10 exports per hour. The family has a 40-import daily limit. These limits reduce accidental usage spikes; they are not a substitute for Cloudflare account billing controls. Recipe source pages are bounded to 1 MiB and input images to 4 MiB.

## Continued development

`docs/ROADMAP.md` records completion evidence and blockers. This repository supports continued work across agent sessions; an active chat does not by itself guarantee a permanent background process. Do not claim an unattended daemon or scheduled continuation exists unless the platform confirms it.
